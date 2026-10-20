use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Product {
    pub id: Uuid,
    pub title: String,
    pub description: Option<String>,
    pub price: i64,
    pub preview_image: Option<String>,
    #[sqlx(default)]
    pub images: Vec<String>,
    pub category: Option<String>,
    #[sqlx(default)]
    pub unit: Option<String>,
    pub stock: i32,
    pub archived_at: Option<DateTime<Utc>>,
    pub is_published: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[sqlx(default)]
    pub discount_percent_bps: Option<i32>,
    #[sqlx(default)]
    pub discount_registered_only: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct CreateProductRequest {
    pub title: String,
    pub description: Option<String>,
    pub price: i64,
    pub category: Option<String>,
    #[serde(default)]
    pub unit: Option<String>,
    pub stock: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Order {
    pub id: Uuid,
    pub customer_name: String,
    pub customer_phone: String,
    pub customer_email: Option<String>,
    pub customer_address: Option<String>,
    pub total_amount: i64,
    pub status: String,
    pub payment_id: Option<String>,
    pub public_number: String,
    pub paid_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateOrderRequest {
    #[serde(default)]
    #[serde(skip)]
    pub customer_id: Option<Uuid>,
    pub customer_name: String,
    pub customer_phone: String,
    pub customer_email: Option<String>,
    pub customer_address: Option<String>,
    pub items: Vec<OrderItemRequest>,
    #[serde(default)]
    pub company_name: Option<String>,
    #[serde(default)]
    pub company_inn: Option<String>,
    #[serde(default)]
    pub consent: bool,
    #[serde(default)]
    pub not_robot: bool,
    #[serde(default)]
    pub website: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct OrderItemRequest {
    pub product_id: Uuid,
    pub quantity: i32,
}

#[derive(Debug, Serialize, FromRow)]
pub struct OrderItem {
    pub id: Uuid,
    pub order_id: Uuid,
    pub product_id: Uuid,
    pub quantity: i32,
    pub price: i64,
    pub product_title: String,
    pub original_unit_price: i64,
    pub final_unit_price: i64,
    pub discount_percent_bps: i32,
    pub discount_source: Option<String>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct DailyAnalytics {
    pub date: DateTime<Utc>,
    pub revenue: Option<i64>,
    pub orders_count: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct TrackViewRequest {
    pub path: String,
    #[serde(default)]
    pub category: Option<String>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct CategoryViewCount {
    pub category: String,
    pub views: i64,
}

#[derive(Debug, Serialize)]
pub struct ViewStats {
    pub total_views: i64,
    pub categories: Vec<CategoryViewCount>,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct LoginResponse {
    pub token: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub exp: usize,
}

#[derive(Debug, Deserialize)]
pub struct CustomerRegisterRequest {
    pub name: String,
    pub email: String,
    pub password: String,
    #[serde(default)]
    pub consent: bool,
    #[serde(default)]
    pub not_robot: bool,
    #[serde(default)]
    pub website: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CustomerLoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Serialize, FromRow)]
pub struct CustomerProfile {
    pub id: Uuid,
    pub email: String,
    pub display_name: String,
    #[sqlx(default)]
    pub phone: Option<String>,
    #[sqlx(default)]
    pub address: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateProfileRequest {
    pub display_name: String,
    #[serde(default)]
    pub phone: Option<String>,
    #[serde(default)]
    pub address: Option<String>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct CustomerOrder {
    pub public_number: String,
    pub total_amount: i64,
    pub status: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct ContactRequest {
    pub id: Uuid,
    pub name: String,
    pub phone: String,
    pub email: Option<String>,
    pub message: String,
    pub status: String,
    pub created_at: DateTime<Utc>,
    /// 'contact' — вопрос с формы, 'estimate' — запрос замера по собранной смете.
    #[sqlx(default)]
    pub source: String,
    #[sqlx(default)]
    pub estimate_items: Option<String>,
    #[sqlx(default)]
    pub estimate_total: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct CreateContactRequest {
    pub name: String,
    pub phone: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub consent: bool,
    #[serde(default)]
    pub website: Option<String>,
    /// Позиции сметы приходят как id товара + количество; цены сервер берёт свои.
    #[serde(default)]
    pub estimate: Option<Vec<EstimateItemRequest>>,
}

#[derive(Debug, Deserialize)]
pub struct EstimateItemRequest {
    pub product_id: Uuid,
    pub quantity: i32,
}

#[derive(Debug, Deserialize)]
pub struct UpdateContactStatusRequest {
    pub status: String,
}

#[derive(Debug, Serialize, FromRow)]
pub struct Review {
    pub id: Uuid,
    pub kind: String,
    pub author_name: String,
    pub rating: Option<i32>,
    pub message: String,
    pub contact: Option<String>,
    pub status: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct PublicReview {
    pub author_name: String,
    pub rating: Option<i32>,
    pub message: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateReviewRequest {
    pub author_name: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub rating: Option<i32>,
    pub message: String,
    #[serde(default)]
    pub contact: Option<String>,
    #[serde(default)]
    pub consent: bool,
    #[serde(default)]
    pub website: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateReviewStatusRequest {
    pub status: String,
}
