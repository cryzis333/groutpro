use crate::config::Config;
use crate::services::notify::{
    describe_http_error, escape_html, split_list, truncate_chars, Notification,
};
use anyhow::{anyhow, bail};
use reqwest::Client;
use serde_json::Value;
use std::time::Duration;

pub struct TelegramService {
    client: anyhow::Result<Client>,
    api_base: String,
    bot_token: String,
    chat_ids: Vec<String>,
}

impl TelegramService {
    pub fn new(config: &Config) -> Self {
        Self {
            client: build_client(&config.telegram_proxy),
            api_base: config.telegram_api_base.trim_end_matches('/').to_string(),
            bot_token: config.telegram_bot_token.clone(),
            chat_ids: split_list(&config.telegram_chat_id),
        }
    }

    pub async fn send(&self, notification: &Notification) -> anyhow::Result<bool> {
        if self.bot_token.is_empty() || self.chat_ids.is_empty() {
            return Ok(false);
        }
        let client = self.client.as_ref().map_err(|e| anyhow!("{e:#}"))?;
        let text = truncate_chars(&render(notification), 4000);
        let mut errors = Vec::new();
        for chat_id in &self.chat_ids {
            if let Err(error) = self.send_to(client, chat_id, &text).await {
                errors.push(format!("чат {chat_id}: {error:#}"));
            }
        }
        if errors.is_empty() {
            Ok(true)
        } else {
            bail!(errors.join("; "))
        }
    }

    async fn send_to(&self, client: &Client, chat_id: &str, text: &str) -> anyhow::Result<()> {
        let url = format!("{}/bot{}/sendMessage", self.api_base, self.bot_token);
        let mut target = chat_id.to_string();
        // A group upgraded to a supergroup gets a new id; follow it once.
        for _ in 0..2 {
            let response = client
                .post(&url)
                .json(&serde_json::json!({
                    "chat_id": target,
                    "text": text,
                    "parse_mode": "HTML",
                    "disable_web_page_preview": true,
                }))
                .send()
                .await
                .map_err(|e| anyhow!(describe_http_error(&e)))?;
            let body: Value = response.json().await.unwrap_or(Value::Null);
            if body.get("ok").and_then(Value::as_bool) == Some(true) {
                return Ok(());
            }
            if let Some(new_id) = body.pointer("/parameters/migrate_to_chat_id") {
                tracing::warn!(old = chat_id, new = %new_id, "telegram chat migrated, update TELEGRAM_CHAT_ID");
                target = new_id.to_string();
                continue;
            }
            let description = body
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("неизвестный ответ Telegram");
            bail!("{description}");
        }
        bail!("чат переехал, запустите настройку заново")
    }
}

fn render(notification: &Notification) -> String {
    let mut text = format!("<b>{}</b>\n", escape_html(&notification.title));
    for (label, value) in &notification.fields {
        let value = escape_html(value);
        if value.contains('\n') {
            text.push_str(&format!("\n<b>{label}:</b>\n{value}\n"));
        } else {
            text.push_str(&format!("\n<b>{label}:</b> {value}"));
        }
    }
    if let Some(link) = &notification.link {
        text.push_str(&format!("\n\n{}", escape_html(link)));
    }
    text
}

fn build_client(proxy: &str) -> anyhow::Result<Client> {
    let mut builder = Client::builder().timeout(Duration::from_secs(15));
    if !proxy.is_empty() {
        // Telegram is blocked from Russian hosting; TELEGRAM_PROXY lets it go
        // through e.g. socks5h://user:pass@host:port.
        builder = builder.proxy(
            reqwest::Proxy::all(proxy).map_err(|_| anyhow!("неверный адрес TELEGRAM_PROXY"))?,
        );
    }
    builder
        .build()
        .map_err(|_| anyhow!("не удалось создать HTTP-клиент"))
}
