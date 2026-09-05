use crate::{error::AppError, models::*, state::AppState};
use axum::{extract::State, Json};

pub async fn persist_order(state: &AppState, req: &CreateOrderRequest) -> Result<Order, AppError> {
    validate_order(req)?;
    let mut tx = state.pool.begin().await?;
    let mut priced = Vec::with_capacity(req.items.len());
    let mut total = 0_i64;
    let mut quantities = std::collections::HashMap::new();
    for item in &req.items {
        *quantities.entry(item.product_id).or_insert(0_i32) += item.quantity;
    }
    if quantities.len() != req.items.len() {
        return Err(AppError::Validation(
            "Повторяющиеся товары объедините в одну позицию".into(),
        ));
    }

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
        let changed = sqlx::query("UPDATE products SET stock = stock - $1, updated_at = NOW() WHERE id = $2 AND stock >= $1")
            .bind(item.quantity)
            .bind(product.id)
            .execute(&mut *tx)
            .await?;
        if changed.rows_affected() != 1 {
            return Err(AppError::Validation(format!(
                "Недостаточно товара: {}",
                product.title
            )));
        }
        sqlx::query("INSERT INTO inventory_reservations (order_id, product_id, quantity, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL '30 minutes') ON CONFLICT (order_id, product_id) DO NOTHING")
            .bind(order.id)
            .bind(product.id)
            .bind(item.quantity)
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
    State(_state): State<AppState>,
    Json(_req): Json<CreateOrderRequest>,
) -> Result<Json<Order>, AppError> {
    Err(AppError::Validation(
        "Заказы создаются только через оплату".into(),
    ))
}

pub async fn release_reservation(
    state: &AppState,
    order_id: uuid::Uuid,
    status: &str,
) -> Result<(), AppError> {
    let mut tx = state.pool.begin().await?;
    let reservations = sqlx::query_as::<_, (uuid::Uuid, i32)>("UPDATE inventory_reservations SET status='released', released_at=NOW() WHERE order_id=$1 AND status='reserved' RETURNING product_id, quantity")
        .bind(order_id).fetch_all(&mut *tx).await?;
    for (product_id, quantity) in reservations {
        sqlx::query("UPDATE products SET stock=stock+$1, updated_at=NOW() WHERE id=$2")
            .bind(quantity)
            .bind(product_id)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("UPDATE orders SET status=$1, cancelled_at=NOW(), stock_released_at=NOW(), updated_at=NOW() WHERE id=$2 AND status <> 'paid'")
        .bind(status).bind(order_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn expire_reservations(state: &AppState) -> Result<(), AppError> {
    let ids = sqlx::query_scalar::<_, uuid::Uuid>("SELECT id FROM orders WHERE status='awaiting_payment' AND payment_deadline < NOW() AND stock_released_at IS NULL LIMIT 100")
        .fetch_all(&state.pool).await?;
    for id in ids {
        release_reservation(state, id, "expired").await?;
    }
    Ok(())
}

pub async fn list_orders(State(state): State<AppState>) -> Result<Json<Vec<Order>>, AppError> {
    Ok(Json(
        sqlx::query_as::<_, Order>("SELECT * FROM orders ORDER BY created_at DESC LIMIT 500")
            .fetch_all(&state.pool)
            .await?,
    ))
}
