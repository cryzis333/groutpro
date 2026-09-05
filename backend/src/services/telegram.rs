use crate::config::Config;
use crate::models::Order;
use reqwest::Client;

pub struct TelegramService {
    client: Client,
    bot_token: String,
    chat_id: String,
}

impl TelegramService {
    pub fn new(config: &Config) -> Self {
        Self {
            client: Client::new(),
            bot_token: config.telegram_bot_token.clone(),
            chat_id: config.telegram_chat_id.clone(),
        }
    }

    pub async fn send_order_notification(&self, order: &Order, items: &str) -> anyhow::Result<()> {
        if self.bot_token.is_empty() || self.chat_id.is_empty() {
            return Ok(());
        }
        let text = format!(
            "🛒 <b>Новый заказ!</b>\n\n📋 ID: {}\n👤 Имя: {}\n📞 Телефон: {}\n📧 Email: {}\n💰 Сумма: {} ₽\n📦 Товары:\n{}\n💳 Статус: {}",
            order.id,
            escape_html(&order.customer_name),
            escape_html(&order.customer_phone),
            escape_html(order.customer_email.as_deref().unwrap_or("-")),
            format_money(order.total_amount),
            items,
            escape_html(&order.status)
        );

        fn format_money(cents: i64) -> String {
            format!("{}.{:02}", cents / 100, cents.abs() % 100)
        }
        fn escape_html(value: &str) -> String {
            value
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
        }

        let url = format!("https://api.telegram.org/bot{}/sendMessage", self.bot_token);
        self.client
            .post(&url)
            .form(&[
                ("chat_id", self.chat_id.as_str()),
                ("text", &text),
                ("parse_mode", "HTML"),
            ])
            .send()
            .await?;
        Ok(())
    }
}
