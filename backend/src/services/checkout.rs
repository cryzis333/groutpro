use sqlx::{FromRow, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    error::AppError,
    models::{CreateOrderRequest, Order},
    state::AppState,
};

const MAX_ORDER_ITEMS: usize = 30;
const MAX_QUANTITY_PER_ITEM: i32 = 100;

#[derive(FromRow)]
struct CheckoutProduct {
    id: Uuid,
    title: String,
    price: i64,
    stock: i32,
    category: Option<String>,
}

#[derive(FromRow)]
struct DiscountRow {
    percent_bps: i32,
    source: String,
}

pub async fn create_pending_order(
    state: &AppState,
    req: &CreateOrderRequest,
) -> Result<Order, AppError> {
    validate_order_request(req)?;

    let mut tx = state.pool.begin().await?;
    let customer_id = req.customer_id;
    let registered_customer = customer_id.is_some();
    let mut line_items = Vec::with_capacity(req.items.len());
    let mut total = 0_i64;

    for item in &req.items {
        let product = sqlx::query_as::<_, CheckoutProduct>(
            "SELECT id, title, price, stock, category FROM products
             WHERE id = $1 AND archived_at IS NULL AND is_published = TRUE
             FOR UPDATE",
        )
        .bind(item.product_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(AppError::NotFound)?;

        if product.stock < item.quantity {
            return Err(AppError::Validation(format!(
                "Недостаточно товара «{}» на складе",
                product.title
            )));
        }

        // Stock is decremented only after YooKassa confirms payment (see
        // payments::yookassa_webhook). This keeps abandoned or cancelled
        // payment attempts from consuming inventory.
        let discount = if registered_customer {
            sqlx::query_as::<_, DiscountRow>(
                "SELECT percent_bps, CASE WHEN product_id = $1 THEN 'product' ELSE 'category' END AS source
                 FROM discounts WHERE is_active = TRUE AND is_registered_only = TRUE
                 AND (product_id = $1 OR category = $2)
                 AND (starts_at IS NULL OR starts_at <= NOW()) AND (ends_at IS NULL OR ends_at > NOW())
                 ORDER BY percent_bps DESC LIMIT 1"
            )
            .bind(product.id)
            .bind(product.category.as_deref())
            .fetch_optional(&mut *tx)
            .await?
        } else {
            None
        };
        let final_price = final_price_for(product.price, discount.as_ref());
        let line_total = final_price
            .checked_mul(item.quantity as i64)
            .ok_or_else(|| AppError::Validation("Сумма заказа слишком велика".to_string()))?;
        total = total
            .checked_add(line_total)
            .ok_or_else(|| AppError::Validation("Сумма заказа слишком велика".to_string()))?;

        line_items.push((product, item.quantity, discount));
    }

    let public_number = format!(
        "GP-{}",
        Uuid::new_v4().simple().to_string()[..8].to_uppercase()
    );
    let order = insert_order(&mut tx, req, total, &public_number, customer_id).await?;

    for (product, quantity, discount) in line_items {
        sqlx::query(
            "INSERT INTO order_items (
                order_id, product_id, quantity, price, product_title, original_unit_price, final_unit_price, discount_percent_bps, discount_source
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        )
        .bind(order.id)
        .bind(product.id)
        .bind(quantity)
        .bind(product.price)
        .bind(&product.title)
        .bind(product.price)
        .bind(final_price_for(product.price, discount.as_ref()))
        .bind(discount.as_ref().map(|d| d.percent_bps).unwrap_or(0))
        .bind(discount.as_ref().map(|d| d.source.as_str()))
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(order)
}

fn final_price_for(price: i64, discount: Option<&DiscountRow>) -> i64 {
    discount
        .map(|d| price * (10_000 - d.percent_bps) as i64 / 10_000)
        .unwrap_or(price)
}

async fn insert_order(
    tx: &mut Transaction<'_, Postgres>,
    req: &CreateOrderRequest,
    total: i64,
    public_number: &str,
    customer_id: Option<Uuid>,
) -> Result<Order, AppError> {
    Ok(sqlx::query_as::<_, Order>(
        "INSERT INTO orders (
            customer_id, customer_name, customer_phone, customer_email, customer_address,
            total_amount, status, public_number
         ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
         RETURNING *",
    )
    .bind(customer_id)
    .bind(req.customer_name.trim())
    .bind(req.customer_phone.trim())
    .bind(
        req.customer_email
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    )
    .bind(
        req.customer_address
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    )
    .bind(total)
    .bind(public_number)
    .fetch_one(&mut **tx)
    .await?)
}

fn validate_order_request(req: &CreateOrderRequest) -> Result<(), AppError> {
    if req.customer_name.trim().len() < 2 || req.customer_name.trim().len() > 120 {
        return Err(AppError::Validation(
            "Укажите имя от 2 до 120 символов".to_string(),
        ));
    }
    if req.customer_phone.trim().len() < 7 || req.customer_phone.trim().len() > 32 {
        return Err(AppError::Validation(
            "Укажите корректный телефон".to_string(),
        ));
    }
    if req.items.is_empty() || req.items.len() > MAX_ORDER_ITEMS {
        return Err(AppError::Validation(
            "Корзина содержит недопустимое число позиций".to_string(),
        ));
    }
    if req
        .items
        .iter()
        .any(|item| item.quantity <= 0 || item.quantity > MAX_QUANTITY_PER_ITEM)
    {
        return Err(AppError::Validation(
            "Укажите допустимое количество товара".to_string(),
        ));
    }
    if let Some(email) = &req.customer_email {
        if email.len() > 254 || (!email.trim().is_empty() && !email.contains('@')) {
            return Err(AppError::Validation("Укажите корректный email".to_string()));
        }
    }
    if req
        .customer_address
        .as_ref()
        .is_some_and(|address| address.len() > 500)
    {
        return Err(AppError::Validation("Адрес слишком длинный".to_string()));
    }
    Ok(())
}
