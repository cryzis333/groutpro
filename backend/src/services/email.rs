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
        let creds = Credentials::new(config.smtp_user.clone(), config.smtp_password.clone());
        let mailer = AsyncSmtpTransport::<lettre::Tokio1Executor>::relay(&config.smtp_host)
            .unwrap()
            .credentials(creds)
            .port(config.smtp_port)
            .build();

        Self {
            mailer,
            from: config.smtp_from.clone(),
            admin_email: config.admin_email.clone(),
        }
    }

    pub async fn send_order_confirmation(
        &self,
        order: &Order,
        items_html: &str,
    ) -> anyhow::Result<()> {
        if self.admin_email.is_empty() || self.from.is_empty() {
            return Ok(());
        }
        let body = format!(
            "<h2>Новый заказ на сайте ГраутПро</h2>
            <p><strong>ID:</strong> {}</p>
            <p><strong>Клиент:</strong> {}</p>
            <p><strong>Телефон:</strong> {}</p>
            <p><strong>Сумма:</strong> {:.2} ₽</p>
            <h3>Товары:</h3>
            <ul>{}</ul>",
            order.id,
            order.customer_name,
            order.customer_phone,
            order.total_amount as f64 / 100.0,
            items_html
        );

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
