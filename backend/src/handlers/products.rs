use crate::{
    error::AppError, extract::AppJson, handlers::customer_auth::current_customer, models::*,
    state::AppState,
};
use axum::{
    body::Bytes,
    extract::{
        multipart::{Field, MultipartError},
        Multipart, Path, Query, State,
    },
    http::HeaderMap,
    Json,
};
use std::path::{Path as StdPath, PathBuf};
use tokio::fs;
use uuid::Uuid;

const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const MAX_IMAGES: usize = 10;
/// Column default from migration 014: new products go after the ones the owner
/// has already put in order.
const DEFAULT_SORT_ORDER: i32 = 1000;

/// `Product` columns plus the discount chosen by `discount_join`.
const PRODUCT_COLUMNS: &str =
    "p.id, p.title, p.description, p.price, p.preview_image, p.images, p.category,
     p.unit, p.stock, p.sort_order, p.archived_at, p.is_published, p.created_at, p.updated_at,
     d.percent_bps AS discount_percent_bps, d.is_registered_only AS discount_registered_only";

/// Picks the discount to show by the rule checkout charges with: discounts open to
/// everyone always apply, registered-only ones when `signed_in` (an SQL boolean)
/// is true; the biggest applicable one wins. When nothing applies, an anonymous
/// visitor still gets the best registered-only discount with
/// `discount_registered_only = true`: the shop shows it as «для зарегистрированных»
/// and keeps the full price, which is exactly what checkout charges.
fn discount_join(signed_in: &str) -> String {
    format!(
        "LEFT JOIN LATERAL (
             SELECT percent_bps, is_registered_only FROM discounts
             WHERE is_active = TRUE
               AND (product_id = p.id OR LOWER(TRIM(category)) = LOWER(TRIM(p.category)))
               AND (starts_at IS NULL OR starts_at <= NOW()) AND (ends_at IS NULL OR ends_at > NOW())
             ORDER BY (is_registered_only = FALSE OR {signed_in}) DESC, percent_bps DESC
             LIMIT 1
         ) d ON true"
    )
}

/// Registered-only prices need a valid customer session, as at checkout.
async fn is_signed_in(state: &AppState, headers: &HeaderMap) -> bool {
    current_customer(state, headers).await.is_ok()
}

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
    headers: HeaderMap,
    Query(query): Query<ProductQuery>,
) -> Result<Json<Vec<Product>>, AppError> {
    let page = query.page.unwrap_or(1).clamp(1, 10_000);
    let page_size = query.page_size.unwrap_or(24).clamp(1, 100);
    let offset = (page - 1) * page_size;
    let search = query.q.as_deref().unwrap_or("").trim();
    let category = query.category.as_deref().unwrap_or("").trim();
    let order_by = match query.sort.as_deref() {
        Some("price-asc") => "p.price ASC",
        Some("price-desc") => "p.price DESC",
        Some("title") => "p.title ASC",
        // по умолчанию — ручной порядок владельца, затем новинки
        _ => "p.sort_order ASC, p.created_at DESC",
    };
    let sql = format!(
        "SELECT {PRODUCT_COLUMNS}
         FROM products p
         {discount}
         WHERE p.archived_at IS NULL AND p.is_published = TRUE
           AND ($1 = '' OR p.title ILIKE '%' || $1 || '%' OR COALESCE(p.description, '') ILIKE '%' || $1 || '%'
               -- Russian stemming: the query is matched by word stems, not substrings
               OR to_tsvector('russian', p.title || ' ' || COALESCE(p.description, '')) @@ plainto_tsquery('russian', $1))
           AND ($2 = '' OR TRIM(p.category) ILIKE $2)
         ORDER BY {order_by}
         LIMIT $3 OFFSET $4",
        discount = discount_join("$5"),
    );
    let signed_in = is_signed_in(&state, &headers).await;
    let products = sqlx::query_as::<_, Product>(&sql)
        .bind(search)
        .bind(category)
        .bind(page_size)
        .bind(offset)
        .bind(signed_in)
        .fetch_all(&state.pool)
        .await?;
    Ok(Json(products))
}

pub async fn get_product(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Product>, AppError> {
    let sql = format!(
        "SELECT {PRODUCT_COLUMNS}
         FROM products p
         {discount}
         WHERE p.id = $1 AND p.archived_at IS NULL AND p.is_published = TRUE",
        discount = discount_join("$2"),
    );
    let signed_in = is_signed_in(&state, &headers).await;
    let product = sqlx::query_as::<_, Product>(&sql)
        .bind(id)
        .bind(signed_in)
        .fetch_optional(&state.pool)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(product))
}

/// Admin catalog: every product that is not archived, published or hidden, in the
/// order the shop shows them. The discount is the best active one of any kind.
pub async fn list_admin_products(
    State(state): State<AppState>,
) -> Result<Json<Vec<Product>>, AppError> {
    let sql = format!(
        "SELECT {PRODUCT_COLUMNS}
         FROM products p
         {discount}
         WHERE p.archived_at IS NULL
         ORDER BY p.sort_order ASC, p.created_at DESC",
        discount = discount_join("TRUE"),
    );
    let products = sqlx::query_as::<_, Product>(&sql)
        .fetch_all(&state.pool)
        .await?;
    Ok(Json(products))
}

pub async fn create_product(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<Product>, AppError> {
    let mut title = None;
    let mut description = None;
    let mut price = None;
    let mut category = None;
    let mut unit = None;
    let mut stock = 0;
    let mut sort_order = None;
    let mut images = Vec::new();

    while let Some(field) = multipart.next_field().await.map_err(multipart_error)? {
        let name = field.name().unwrap_or("").to_string();
        if name == "images" {
            if images.len() >= MAX_IMAGES {
                return Err(too_many_images());
            }
            images.push(read_image(field).await?);
            continue;
        }
        let text = field.text().await.map_err(multipart_error)?;
        match name.as_str() {
            "title" => title = non_empty_text(&text),
            "description" => description = non_empty_text(&text),
            "price" => price = Some(parse_price(&text)?),
            "category" => category = non_empty_text(&text),
            "unit" => unit = non_empty_text(&text),
            "stock" => stock = text.trim().parse::<i32>().unwrap_or(0),
            "sort_order" => sort_order = parse_sort_order(&text)?,
            _ => {}
        }
    }

    let title = title.ok_or_else(|| AppError::Validation("Укажите название товара".to_string()))?;
    let price = price.ok_or_else(|| AppError::Validation("Укажите цену товара".to_string()))?;
    validate_product(&title, price, stock)?;

    // Every field and image is valid: only now does anything reach the disk.
    let filenames = save_images(&state, images).await?;
    let inserted = sqlx::query_as::<_, Product>(
        "INSERT INTO products (title, description, price, preview_image, images, category, stock, unit, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *",
    )
    .bind(title)
    .bind(description)
    .bind(price)
    .bind(filenames.first().cloned())
    .bind(&filenames)
    .bind(category)
    .bind(stock)
    .bind(unit)
    .bind(sort_order.unwrap_or(DEFAULT_SORT_ORDER))
    .fetch_one(&state.pool)
    .await
    .map_err(AppError::from);
    if inserted.is_err() {
        remove_images(&state, &filenames).await;
    }
    inserted.map(Json)
}

pub async fn update_product(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    AppJson(req): AppJson<CreateProductRequest>,
) -> Result<Json<Product>, AppError> {
    let title = req.title.trim();
    validate_product(title, req.price, req.stock)?;
    let product = sqlx::query_as::<_, Product>(
        "UPDATE products SET title = $1, description = $2, price = $3, category = $4, stock = $5, unit = $6,
                sort_order = COALESCE($7, sort_order), updated_at = NOW()
         WHERE id = $8 AND archived_at IS NULL RETURNING *",
    )
    .bind(title)
    .bind(req.description.as_deref().map(str::trim).filter(|value| !value.is_empty()))
    .bind(req.price)
    .bind(req.category.as_deref().map(str::trim).filter(|value| !value.is_empty()))
    .bind(req.stock)
    .bind(req.unit.as_deref().map(str::trim).filter(|v| !v.is_empty()))
    .bind(req.sort_order)
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

/// Replaces a product's photos. Old files stay on disk on purpose — the same
/// upload can be referenced by another product.
pub async fn replace_product_images(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    mut multipart: Multipart,
) -> Result<Json<Product>, AppError> {
    let mut images = Vec::new();
    while let Some(field) = multipart.next_field().await.map_err(multipart_error)? {
        if field.name().unwrap_or("") != "images" {
            continue;
        }
        if images.len() >= MAX_IMAGES {
            return Err(too_many_images());
        }
        images.push(read_image(field).await?);
    }
    if images.is_empty() {
        return Err(AppError::Validation(
            "Выберите хотя бы одно изображение".to_string(),
        ));
    }
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM products WHERE id = $1 AND archived_at IS NULL)",
    )
    .bind(id)
    .fetch_one(&state.pool)
    .await?;
    if !exists {
        return Err(AppError::NotFound);
    }

    let filenames = save_images(&state, images).await?;
    let updated = sqlx::query_as::<_, Product>(
        "UPDATE products SET images = $1, preview_image = $2, updated_at = NOW()
         WHERE id = $3 AND archived_at IS NULL RETURNING *",
    )
    .bind(&filenames)
    .bind(filenames.first().cloned())
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .map_err(AppError::from)
    .and_then(|product| product.ok_or(AppError::NotFound));
    if updated.is_err() {
        // Archived in the meantime or the database failed: keep no unreferenced files.
        remove_images(&state, &filenames).await;
    }
    updated.map(Json)
}

/// Price is in kopecks; 0 means «цена по запросу» (shown in the catalog, ordered
/// only through a request — checkout refuses it).
fn validate_product(title: &str, price: i64, stock: i32) -> Result<(), AppError> {
    if title.is_empty() || title.chars().count() > 200 || price < 0 || stock < 0 {
        return Err(AppError::Validation(
            "Проверьте название, цену и остаток товара".to_string(),
        ));
    }
    Ok(())
}

fn parse_price(text: &str) -> Result<i64, AppError> {
    text.trim().parse::<i64>().map_err(|_| {
        AppError::Validation("Укажите цену числом (0 — «цена по запросу»)".to_string())
    })
}

/// An empty field keeps the default position.
fn parse_sort_order(text: &str) -> Result<Option<i32>, AppError> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(None);
    }
    text.parse::<i32>().map(Some).map_err(|_| {
        AppError::Validation("Порядок в каталоге должен быть целым числом".to_string())
    })
}

fn non_empty_text(text: &str) -> Option<String> {
    Some(text.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn too_many_images() -> AppError {
    AppError::Validation(format!("Можно загрузить не более {MAX_IMAGES} изображений"))
}

/// The upload stream broke off — most often the files exceeded the size limit.
fn multipart_error(error: MultipartError) -> AppError {
    tracing::warn!(%error, "cannot read multipart upload");
    AppError::BadRequest(
        "Не удалось прочитать загруженные данные. Проверьте размер фото (до 5 МБ каждое) \
         и попробуйте ещё раз."
            .to_string(),
    )
}

/// An uploaded image that passed validation and is not on disk yet.
struct ValidatedImage {
    data: Bytes,
    extension: &'static str,
}

/// Validates one uploaded image; the type is sniffed from its own bytes, not taken
/// from the client's claim. Nothing is written to disk here.
async fn read_image(field: Field<'_>) -> Result<ValidatedImage, AppError> {
    let content_type = field.content_type().map(str::to_owned);
    let data = field.bytes().await.map_err(multipart_error)?;
    if data.is_empty() || data.len() > MAX_IMAGE_BYTES {
        return Err(AppError::Validation(
            "Размер одного изображения должен быть не более 5 МБ".to_string(),
        ));
    }
    let extension = match content_type.as_deref() {
        Some("image/jpeg") if data.starts_with(&[0xFF, 0xD8, 0xFF]) => "jpg",
        Some("image/png") if data.starts_with(b"\x89PNG\r\n\x1a\n") => "png",
        Some("image/webp") if data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP") => {
            "webp"
        }
        _ => {
            return Err(AppError::Validation(
                "Разрешены только изображения JPEG, PNG и WebP".to_string(),
            ))
        }
    };
    Ok(ValidatedImage { data, extension })
}

/// Stores validated images under random names and returns those names. If one
/// write fails, the files written before it are removed again.
async fn save_images(
    state: &AppState,
    images: Vec<ValidatedImage>,
) -> Result<Vec<String>, AppError> {
    let mut saved = Vec::with_capacity(images.len());
    for image in images {
        let filename = format!("{}.{}", Uuid::new_v4(), image.extension);
        if let Err(error) = fs::write(upload_path(state, &filename), image.data).await {
            remove_images(state, &saved).await;
            return Err(AppError::Internal(format!(
                "cannot save upload {filename}: {error}"
            )));
        }
        saved.push(filename);
    }
    Ok(saved)
}

/// Best effort: a file that can't be removed is only logged.
async fn remove_images(state: &AppState, filenames: &[String]) {
    for filename in filenames {
        if let Err(error) = fs::remove_file(upload_path(state, filename)).await {
            tracing::warn!(%error, %filename, "cannot remove unused upload");
        }
    }
}

fn upload_path(state: &AppState, filename: &str) -> PathBuf {
    StdPath::new(&state.upload_dir).join(filename)
}

#[cfg(test)]
mod tests {
    use super::{parse_price, parse_sort_order, validate_product};

    #[test]
    fn price_zero_means_on_request() {
        assert!(validate_product("Грунт", 0, 0).is_ok());
        assert!(validate_product("Грунт", 150_000, 3).is_ok());
        assert!(validate_product("Грунт", -1, 0).is_err());
        assert!(validate_product("Грунт", 100, -1).is_err());
        assert!(validate_product("", 100, 0).is_err());
    }

    #[test]
    fn title_limit_counts_characters() {
        assert!(validate_product(&"ж".repeat(200), 100, 0).is_ok());
        assert!(validate_product(&"ж".repeat(201), 100, 0).is_err());
    }

    #[test]
    fn parses_price_and_sort_order() {
        assert_eq!(parse_price(" 0 ").ok(), Some(0));
        assert_eq!(parse_price("125000").ok(), Some(125_000));
        assert!(parse_price("NaN").is_err());
        assert_eq!(parse_sort_order("").ok(), Some(None));
        assert_eq!(parse_sort_order(" 10 ").ok(), Some(Some(10)));
        assert!(parse_sort_order("first").is_err());
    }
}
