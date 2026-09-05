use crate::config::Config;
use crate::models::Order;
use lettre::{
    message::header::ContentType, transport::smtp::authentication::Credentials, AsyncSmtpTransport,
    AsyncTransport, Message,
};

pub struct EmailService {
    mailer: AsyncSmtpTransport<lettre::Tokio1Executor>,
    from: String,
    admin_email: String,
}
impl EmailService {
    pub fn new(config: &Config) -> Self {
        let mailer = AsyncSmtpTransport::<lettre::Tokio1Executor>::relay(&config.smtp_host)
            .unwrap()
            .credentials(Credentials::new(
                config.smtp_user.clone(),
                config.smtp_password.clone(),
            ))
            .port(config.smtp_port)
            .build();
        Self {
            mailer,
            from: config.smtp_from.clone(),
            admin_email: config.admin_email.clone(),
        }
    }
    pub async fn send_contact(
        &self,
        id: uuid::Uuid,
        name: &str,
        phone: &str,
        contact_email: Option<&str>,
        message: &str,
    ) -> anyhow::Result<()> {
        if self.admin_email.is_empty() || self.from.is_empty() {
            return Ok(());
        }
        let body = format!(
            "Новая заявка #{id}\n\nИмя: {name}\nТелефон: {phone}\nEmail: {}\n\nЗадача:\n{message}",
            contact_email.unwrap_or("—")
        );
        let email = Message::builder()
            .from(self.from.parse()?)
            .to(self.admin_email.parse()?)
            .subject(format!("Заявка с сайта #{id}"))
            .header(ContentType::TEXT_PLAIN)
            .body(body)?;
        self.mailer.send(email).await?;
        Ok(())
    }
    pub async fn send_order_confirmation(
        &self,
        order: &Order,
        items_html: &str,
    ) -> anyhow::Result<()> {
        if self.admin_email.is_empty() || self.from.is_empty() {
            return Ok(());
        }
        let body = format!("<h2>Новый заказ на сайте ГраутПро</h2><p><strong>ID:</strong> {}</p><p><strong>Клиент:</strong> {}</p><p><strong>Телефон:</strong> {}</p><p><strong>Сумма:</strong> {} ₽</p><h3>Товары:</h3><ul>{}</ul>", order.id, escape_html(&order.customer_name), escape_html(&order.customer_phone), format_money(order.total_amount), items_html);
        let email = Message::builder()
            .from(self.from.parse()?)
            .to(self.admin_email.parse()?)
            .subject(format!("Новый заказ #{}", order.id))
            .header(ContentType::TEXT_HTML)
            .body(body)?;
        self.mailer.send(email).await?;
        Ok(())
    }
}
fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
fn format_money(cents: i64) -> String {
    format!("{}.{:02}", cents / 100, cents.abs() % 100)
}
