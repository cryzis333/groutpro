use crate::{error::AppError, models::*, state::AppState};
use axum::{extract::State, Json};

pub async fn persist_order(state: &AppState, req: &CreateOrderRequest) -> Result<Order, AppError> {
    validate_order(req)?;
    let mut tx = state.pool.begin().await?;
    let mut priced = Vec::with_capacity(req.items.len());
    let mut total = 0_i64;

    for item in &req.items {
        let product =
            sqlx::query_as::<_, Product>("SELECT * FROM products WHERE id = $1 FOR UPDATE")
                .bind(item.product_id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or(AppError::NotFound)?;
        if item.quantity > product.stock {
            return Err(AppError::Validation(format!(
                "Недостаточно товара: {}",
                product.title
            )));
        }
        let line_total = product
            .price
            .checked_mul(i64::from(item.quantity))
            .ok_or_else(|| AppError::Validation("Слишком большая сумма заказа".into()))?;
        total = total
            .checked_add(line_total)
            .ok_or_else(|| AppError::Validation("Слишком большая сумма заказа".into()))?;
        priced.push((item, product));
    }

    let order = sqlx::query_as::<_, Order>("INSERT INTO orders (customer_name, customer_phone, customer_email, customer_address, total_amount, status) VALUES ($1,$2,$3,$4,$5,'pending') RETURNING *")
        .bind(req.customer_name.trim()).bind(req.customer_phone.trim())
        .bind(req.customer_email.as_deref().map(str::trim).filter(|v| !v.is_empty()))
        .bind(req.customer_address.as_deref().map(str::trim).filter(|v| !v.is_empty()))
        .bind(total).fetch_one(&mut *tx).await?;

    for (item, product) in priced {
        sqlx::query("INSERT INTO order_items (order_id, product_id, product_title, quantity, price) VALUES ($1,$2,$3,$4,$5)")
            .bind(order.id).bind(product.id).bind(&product.title).bind(item.quantity).bind(product.price)
            .execute(&mut *tx).await?;
        sqlx::query("UPDATE products SET stock = stock - $1, updated_at = NOW() WHERE id = $2")
            .bind(item.quantity)
            .bind(product.id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(order)
}

fn validate_order(req: &CreateOrderRequest) -> Result<(), AppError> {
    let name = req.customer_name.trim();
    let phone = req.customer_phone.trim();
    if name.is_empty() || name.chars().count() > 120 {
        return Err(AppError::Validation("Укажите корректное имя".into()));
    }
    if phone.len() < 5 || phone.len() > 32 {
        return Err(AppError::Validation("Укажите корректный телефон".into()));
    }
    if req.items.is_empty() || req.items.len() > 50 {
        return Err(AppError::Validation(
            "Корзина пуста или слишком велика".into(),
        ));
    }
    if req
        .items
        .iter()
        .any(|item| item.quantity < 1 || item.quantity > 100)
    {
        return Err(AppError::Validation(
            "Количество товара должно быть от 1 до 100".into(),
        ));
    }
    Ok(())
}

pub async fn create_order(
    State(state): State<AppState>,
    Json(req): Json<CreateOrderRequest>,
) -> Result<Json<Order>, AppError> {
    Ok(Json(persist_order(&state, &req).await?))
}

pub async fn list_orders(State(state): State<AppState>) -> Result<Json<Vec<Order>>, AppError> {
    Ok(Json(
        sqlx::query_as::<_, Order>("SELECT * FROM orders ORDER BY created_at DESC LIMIT 500")
            .fetch_all(&state.pool)
            .await?,
    ))
}
