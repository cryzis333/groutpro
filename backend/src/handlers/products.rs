use crate::{error::AppError, models::Product, state::AppState};
use axum::{
    extract::{Multipart, Path, State},
    Json,
};
use std::path::Path as StdPath;
use tokio::fs;
use uuid::Uuid;

const MAX_IMAGES: usize = 10;
const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;

pub async fn list_products(State(state): State<AppState>) -> Result<Json<Vec<Product>>, AppError> {
    Ok(Json(
        sqlx::query_as::<_, Product>("SELECT * FROM products ORDER BY created_at DESC")
            .fetch_all(&state.pool)
            .await?,
    ))
}

pub async fn get_product(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Product>, AppError> {
    Ok(Json(
        sqlx::query_as::<_, Product>("SELECT * FROM products WHERE id=$1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await?
            .ok_or(AppError::NotFound)?,
    ))
}

pub async fn create_product(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<Product>, AppError> {
    let (mut title, mut description, mut price, mut category, mut stock) =
        (None, None, None, None, None);
    let mut pending_images: Vec<(String, Vec<u8>)> = Vec::new();
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(e.to_string()))?
    {
        let name = field.name().unwrap_or("").to_string();
        if name == "images" {
            if pending_images.len() >= MAX_IMAGES {
                return Err(AppError::Validation("Максимум 10 изображений".into()));
            }
            let data = field
                .bytes()
                .await
                .map_err(|e| AppError::BadRequest(e.to_string()))?;
            if data.len() > MAX_IMAGE_BYTES {
                return Err(AppError::Validation(
                    "Изображение не должно превышать 5 МБ".into(),
                ));
            }
            let extension = image_extension(&data)
                .ok_or_else(|| AppError::Validation("Разрешены JPEG, PNG и WebP".into()))?;
            pending_images.push((format!("{}.{}", Uuid::new_v4(), extension), data.to_vec()));
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
                            .map_err(|_| AppError::Validation("Некорректная цена".into()))?,
                    )
                }
                "category" => category = Some(text),
                "stock" => {
                    stock = Some(
                        text.parse::<i32>()
                            .map_err(|_| AppError::Validation("Некорректный остаток".into()))?,
                    )
                }
                _ => {}
            }
        }
    }
    let title = title
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty() && v.chars().count() <= 200)
        .ok_or_else(|| AppError::Validation("Укажите название до 200 символов".into()))?;
    let price = price
        .filter(|v| *v > 0)
        .ok_or_else(|| AppError::Validation("Цена должна быть больше нуля".into()))?;
    let stock = stock.unwrap_or(0);
    if stock < 0 {
        return Err(AppError::Validation(
            "Остаток не может быть отрицательным".into(),
        ));
    }
    let images: Vec<String> = pending_images
        .iter()
        .map(|(name, _)| name.clone())
        .collect();
    let preview = images.first().cloned();
    let product = sqlx::query_as::<_, Product>("INSERT INTO products (title,description,price,preview_image,images,category,stock) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *")
        .bind(title).bind(description).bind(price).bind(preview).bind(&images).bind(category).bind(stock).fetch_one(&state.pool).await?;
    for (name, data) in pending_images {
        let path = StdPath::new(&state.upload_dir).join(name);
        if let Err(error) = fs::write(path, data).await {
            sqlx::query("DELETE FROM products WHERE id=$1")
                .bind(product.id)
                .execute(&state.pool)
                .await?;
            return Err(AppError::internal(error));
        }
    }
    Ok(Json(product))
}

pub async fn delete_product(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let product = sqlx::query_as::<_, Product>("DELETE FROM products WHERE id=$1 RETURNING *")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or(AppError::NotFound)?;
    for image in product.images {
        let _ = fs::remove_file(StdPath::new(&state.upload_dir).join(image)).await;
    }
    Ok(Json(serde_json::json!({"success":true})))
}

fn image_extension(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("jpg")
    } else if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::image_extension;
    #[test]
    fn detects_supported_images() {
        assert_eq!(image_extension(&[0xff, 0xd8, 0xff, 0]), Some("jpg"));
        assert_eq!(image_extension(b"\x89PNG\r\n\x1a\nrest"), Some("png"));
        assert_eq!(image_extension(b"RIFF0000WEBP"), Some("webp"));
        assert_eq!(image_extension(b"<script>"), None);
    }
}
