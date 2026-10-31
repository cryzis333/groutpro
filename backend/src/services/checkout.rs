use sqlx::{FromRow, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    error::AppError,
    models::{CreateOrderRequest, Order, OrderItemRequest},
    state::AppState,
};

const MAX_ORDER_ITEMS: usize = 30;
const MAX_QUANTITY_PER_ITEM: i32 = 100;

/// The best discount the buyer is entitled to: discounts open to everyone always
/// apply, "registered only" ones only when $3 (a verified customer session) is true.
/// The catalog (handlers::products) shows prices by the same rule.
const BEST_DISCOUNT_SQL: &str = "SELECT percent_bps,
        CASE WHEN product_id = $1 THEN 'product' ELSE 'category' END AS source
     FROM discounts
     WHERE is_active = TRUE
       AND (is_registered_only = FALSE OR $3)
       AND (product_id = $1 OR LOWER(TRIM(category)) = LOWER(TRIM($2)))
       AND (starts_at IS NULL OR starts_at <= NOW()) AND (ends_at IS NULL OR ends_at > NOW())
     ORDER BY percent_bps DESC
     LIMIT 1";

#[derive(FromRow)]
struct CheckoutProduct {
    id: Uuid,
    title: String,
    price: i64,
    stock: i32,
    category: Option<String>,
    unit: Option<String>,
}

/// Only piece goods («шт» or no unit) are limited by stock. Contract work priced
/// per м², пог. м, ввод or объект has no stock and is never written off.
pub fn tracks_stock(unit: Option<&str>) -> bool {
    match unit.map(str::trim) {
        None | Some("") => true,
        Some(unit) => unit == "шт",
    }
}

#[derive(FromRow)]
struct DiscountRow {
    percent_bps: i32,
    source: String,
}

pub async fn create_pending_order(
    state: &AppState,
    req: &CreateOrderRequest,
    payment_method: &str,
) -> Result<Order, AppError> {
    validate_order_request(req)?;
    // The same product on two lines must not pass the stock check twice.
    let lines = merge_order_lines(&req.items);
    if lines
        .iter()
        .any(|(_, quantity)| *quantity > MAX_QUANTITY_PER_ITEM)
    {
        return Err(AppError::Validation(
            "Укажите допустимое количество товара".to_string(),
        ));
    }

    let mut tx = state.pool.begin().await?;
    let customer_id = req.customer_id;
    let registered_customer = customer_id.is_some();
    let mut line_items = Vec::with_capacity(lines.len());
    let mut total = 0_i64;

    for (product_id, quantity) in lines {
        let product = sqlx::query_as::<_, CheckoutProduct>(
            "SELECT id, title, price, COALESCE(stock, 0) AS stock, category, unit FROM products
             WHERE id = $1 AND archived_at IS NULL AND is_published = TRUE
             FOR UPDATE",
        )
        .bind(product_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| {
            AppError::Validation(
                "Товар из корзины больше не продаётся. Обновите корзину.".to_string(),
            )
        })?;

        if product.price <= 0 {
            // «Цена по запросу»: такую позицию считают по объекту, в заказ она не идёт
            return Err(AppError::Validation(format!(
                "«{}» рассчитывается по запросу — оставьте заявку, посчитаем по объекту",
                product.title
            )));
        }
        if tracks_stock(product.unit.as_deref()) && product.stock < quantity {
            return Err(AppError::Validation(format!(
                "Недостаточно товара «{}» на складе",
                product.title
            )));
        }

        // Registered-only discounts need a verified session (customer_id is set by
        // the handler from the session cookie, never from the request body).
        let discount = sqlx::query_as::<_, DiscountRow>(BEST_DISCOUNT_SQL)
            .bind(product.id)
            .bind(product.category.as_deref())
            .bind(registered_customer)
            .fetch_optional(&mut *tx)
            .await?;
        let final_price = final_price_for(product.price, discount.as_ref());
        let line_total = final_price
            .checked_mul(i64::from(quantity))
            .ok_or_else(|| AppError::Validation("Сумма заказа слишком велика".to_string()))?;
        total = total
            .checked_add(line_total)
            .ok_or_else(|| AppError::Validation("Сумма заказа слишком велика".to_string()))?;

        line_items.push((product, quantity, discount));
    }

    let public_number = format!(
        "GP-{}",
        Uuid::new_v4().simple().to_string()[..8].to_uppercase()
    );
    let order = insert_order(
        &mut tx,
        req,
        total,
        &public_number,
        customer_id,
        payment_method,
    )
    .await?;

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
        .bind(product.title)
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

/// Unit price after a discount given in basis points (1250 = 12.5 %), rounded
/// down to whole kopecks — the same formula the frontend uses for display.
fn final_price_for(price: i64, discount: Option<&DiscountRow>) -> i64 {
    discount
        .map(|d| price * i64::from(10_000 - d.percent_bps) / 10_000)
        .unwrap_or(price)
}

/// Sums the quantities of repeated products, keeping the order in which they
/// first appear in the cart.
fn merge_order_lines(items: &[OrderItemRequest]) -> Vec<(Uuid, i32)> {
    let mut lines: Vec<(Uuid, i32)> = Vec::with_capacity(items.len());
    for item in items {
        match lines
            .iter_mut()
            .find(|(product_id, _)| *product_id == item.product_id)
        {
            Some((_, quantity)) => *quantity = quantity.saturating_add(item.quantity),
            None => lines.push((item.product_id, item.quantity)),
        }
    }
    lines
}

async fn insert_order(
    tx: &mut Transaction<'_, Postgres>,
    req: &CreateOrderRequest,
    total: i64,
    public_number: &str,
    customer_id: Option<Uuid>,
    payment_method: &str,
) -> Result<Order, AppError> {
    Ok(sqlx::query_as::<_, Order>(
        "INSERT INTO orders (
            customer_id, customer_name, customer_phone, customer_email, customer_address,
            total_amount, status, public_number, payment_method, company_name, company_inn
         ) VALUES ($1, $2, $3, $4, $5, $6, 'pending_payment', $7, $8, $9, $10)
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
    .bind(payment_method)
    .bind(
        req.company_name
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty()),
    )
    .bind(
        req.company_inn
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty()),
    )
    .fetch_one(&mut **tx)
    .await?)
}

fn validate_order_request(req: &CreateOrderRequest) -> Result<(), AppError> {
    if req
        .website
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        return Err(AppError::Validation(
            "Проверьте форму и попробуйте снова".to_string(),
        ));
    }
    if !req.consent {
        return Err(AppError::Validation(
            "Подтвердите согласие с политикой конфиденциальности".to_string(),
        ));
    }
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

#[cfg(test)]
mod tests {
    use super::{final_price_for, merge_order_lines, tracks_stock, DiscountRow};
    use crate::models::OrderItemRequest;
    use uuid::Uuid;

    fn discount(percent_bps: i32) -> DiscountRow {
        DiscountRow {
            percent_bps,
            source: "category".to_string(),
        }
    }

    fn item(id: u128, quantity: i32) -> OrderItemRequest {
        OrderItemRequest {
            product_id: Uuid::from_u128(id),
            quantity,
        }
    }

    #[test]
    fn applies_discount_in_basis_points() {
        assert_eq!(final_price_for(10_000, None), 10_000);
        assert_eq!(final_price_for(10_000, Some(&discount(1_000))), 9_000);
        assert_eq!(
            final_price_for(1_890_000, Some(&discount(1_250))),
            1_653_750
        );
        assert_eq!(final_price_for(10_000, Some(&discount(9_999))), 1);
    }

    #[test]
    fn rounds_fractional_kopecks_down() {
        assert_eq!(final_price_for(999, Some(&discount(3_333))), 666);
        assert_eq!(final_price_for(1, Some(&discount(5_000))), 0);
    }

    #[test]
    fn merges_repeated_products() {
        let lines = merge_order_lines(&[item(1, 2), item(2, 1), item(1, 3), item(3, 4)]);
        assert_eq!(
            lines,
            vec![
                (Uuid::from_u128(1), 5),
                (Uuid::from_u128(2), 1),
                (Uuid::from_u128(3), 4)
            ]
        );
    }

    #[test]
    fn keeps_unique_lines_untouched() {
        let lines = merge_order_lines(&[item(7, 1), item(8, 100)]);
        assert_eq!(
            lines,
            vec![(Uuid::from_u128(7), 1), (Uuid::from_u128(8), 100)]
        );
        assert!(merge_order_lines(&[]).is_empty());
    }

    #[test]
    fn only_piece_goods_track_stock() {
        assert!(tracks_stock(None));
        assert!(tracks_stock(Some("")));
        assert!(tracks_stock(Some("шт")));
        assert!(tracks_stock(Some(" шт ")));
        assert!(!tracks_stock(Some("м²")));
        assert!(!tracks_stock(Some("пог. м")));
        assert!(!tracks_stock(Some("ввод")));
    }
}
