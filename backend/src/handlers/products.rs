use crate::{error::AppError, models::*, state::AppState};
use axum::{
    extract::{Multipart, Path, Query, State},
    Json,
};
use std::path::Path as StdPath;
use tokio::fs;
use uuid::Uuid;

#[derive(Debug, serde::Deserialize)]
pub struct ProductQuery {
    pub q: Option<String>,
    pub category: Option<String>,
    pub sort: Option<String>,
    pub page: Option<i64>,
    pub page_size: Option<i64>,
}

pub async fn list_products(
    State(state): State<AppState>,
    Query(query): Query<ProductQuery>,
) -> Result<Json<Vec<Product>>, AppError> {
    let page = query.page.unwrap_or(1).clamp(1, 10_000);
    let page_size = query.page_size.unwrap_or(24).clamp(1, 100);
    let offset = (page - 1) * page_size;
    let search = query.q.as_deref().unwrap_or("").trim();
    let category = query.category.as_deref().unwrap_or("").trim();
    let order_by = match query.sort.as_deref() {
        Some("price-asc") => "price ASC",
        Some("price-desc") => "price DESC",
        Some("title") => "title ASC",
        _ => "created_at DESC",
    };
    let sql = format!(
        "SELECT * FROM products
         WHERE archived_at IS NULL AND is_published = TRUE
           AND ($1 = '' OR title ILIKE '%' || $1 || '%' OR COALESCE(description, '') ILIKE '%' || $1 || '%')
           AND ($2 = '' OR category = $2)
         ORDER BY {order_by}
         LIMIT $3 OFFSET $4"
    );
    let products = sqlx::query_as::<_, Product>(&sql)
        .bind(search)
        .bind(category)
        .bind(page_size)
        .bind(offset)
        .fetch_all(&state.pool)
        .await?;
    Ok(Json(products))
}

pub async fn get_product(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Product>, AppError> {
    let product = sqlx::query_as::<_, Product>(
        "SELECT * FROM products WHERE id = $1 AND archived_at IS NULL AND is_published = TRUE",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(product))
}

pub async fn create_product(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<Product>, AppError> {
    let mut title = None;
    let mut description = None;
    let mut price = None;
    let mut category = None;
    let mut stock = Some(0);
    let mut images = vec![];
    let mut preview = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(e.to_string()))?
    {
        let name = field.name().unwrap_or("").to_string();
        if name == "images" {
            if images.len() >= 10 {
                return Err(AppError::Validation(
                    "Можно загрузить не более 10 изображений".to_string(),
                ));
            }
            let content_type = field.content_type().map(str::to_owned);
            let data = field
                .bytes()
                .await
                .map_err(|e| AppError::BadRequest(e.to_string()))?;
            const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
            if data.is_empty() || data.len() > MAX_IMAGE_BYTES {
                return Err(AppError::Validation(
                    "Размер одного изображения должен быть не более 5 МБ".to_string(),
                ));
            }
            let extension = match content_type.as_deref() {
                Some("image/jpeg") if data.starts_with(&[0xFF, 0xD8, 0xFF]) => "jpg",
                Some("image/png") if data.starts_with(b"\x89PNG\r\n\x1a\n") => "png",
                Some("image/webp")
                    if data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP") =>
                {
                    "webp"
                }
                _ => {
                    return Err(AppError::Validation(
                        "Разрешены только изображения JPEG, PNG и WebP".to_string(),
                    ))
                }
            };
            let filename = format!("{}.{}", Uuid::new_v4(), extension);
            let path = StdPath::new(&state.upload_dir).join(&filename);
            fs::write(&path, &data)
                .await
                .map_err(|e| AppError::Internal(e.to_string()))?;
            images.push(filename.clone());
            if preview.is_none() {
                preview = Some(filename);
            }
        } else {
            let text = field
                .text()
                .await
                .map_err(|e| AppError::BadRequest(e.to_string()))?;
            match name.as_str() {
                "title" => title = Some(text),
                "description" => description = Some(text),
                "price" => {
                    price = Some(
                        text.parse::<i64>()
                            .map_err(|_| AppError::Validation("Invalid price".to_string()))?,
                    )
                }
                "category" => category = Some(text),
                "stock" => stock = Some(text.parse::<i32>().unwrap_or(0)),
                _ => {}
            }
        }
    }

    let title = title.ok_or(AppError::Validation("Title required".to_string()))?;
    let price = price.ok_or(AppError::Validation("Price required".to_string()))?;
    if title.trim().is_empty() || title.len() > 200 || price <= 0 || stock.unwrap_or(0) < 0 {
        return Err(AppError::Validation(
            "Проверьте название, цену и остаток товара".to_string(),
        ));
    }

    let product = sqlx::query_as::<_, Product>(
        "INSERT INTO products (title, description, price, preview_image, images, category, stock)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *",
    )
    .bind(title)
    .bind(description)
    .bind(price)
    .bind(preview)
    .bind(&images)
    .bind(category)
    .bind(stock.unwrap_or(0))
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(product))
}

pub async fn update_product(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<CreateProductRequest>,
) -> Result<Json<Product>, AppError> {
    let title = req.title.trim();
    if title.is_empty() || title.len() > 200 || req.price <= 0 || req.stock < 0 {
        return Err(AppError::Validation(
            "Проверьте название, цену и остаток товара".to_string(),
        ));
    }
    let product = sqlx::query_as::<_, Product>(
        "UPDATE products SET title = $1, description = $2, price = $3, category = $4, stock = $5, updated_at = NOW()
         WHERE id = $6 AND archived_at IS NULL RETURNING *",
    )
    .bind(title)
    .bind(req.description.as_deref().map(str::trim).filter(|value| !value.is_empty()))
    .bind(req.price)
    .bind(req.category.as_deref().map(str::trim).filter(|value| !value.is_empty()))
    .bind(req.stock)
    .bind(id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(product))
}

pub async fn delete_product(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = sqlx::query(
        "UPDATE products SET archived_at = NOW(), is_published = FALSE, updated_at = NOW()
         WHERE id = $1 AND archived_at IS NULL",
    )
    .bind(id)
    .execute(&state.pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(serde_json::json!({ "success": true })))
}
