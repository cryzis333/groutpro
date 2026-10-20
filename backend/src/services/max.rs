use crate::config::Config;
use crate::services::notify::{describe_http_error, split_list, truncate_chars, Notification};
use anyhow::{anyhow, bail};
use reqwest::Client;
use serde_json::Value;
use std::time::Duration;

pub struct MaxService {
    client: Client,
    api_base: String,
    bot_token: String,
    chat_ids: Vec<String>,
}

impl MaxService {
    pub fn new(config: &Config) -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(15))
                .build()
                .unwrap_or_default(),
            api_base: config.max_api_base.trim_end_matches('/').to_string(),
            bot_token: config.max_bot_token.clone(),
            chat_ids: split_list(&config.max_chat_id),
        }
    }

    pub async fn send(&self, notification: &Notification) -> anyhow::Result<bool> {
        if self.bot_token.is_empty() || self.chat_ids.is_empty() {
            return Ok(false);
        }
        let text = truncate_chars(&notification.plain_text(), 4000);
        let mut errors = Vec::new();
        for chat_id in &self.chat_ids {
            if let Err(error) = self.send_to(chat_id, &text).await {
                errors.push(format!("чат {chat_id}: {error:#}"));
            }
        }
        if errors.is_empty() {
            Ok(true)
        } else {
            bail!(errors.join("; "))
        }
    }

    async fn send_to(&self, chat_id: &str, text: &str) -> anyhow::Result<()> {
        let response = self
            .client
            .post(format!("{}/messages", self.api_base))
            .query(&[("chat_id", chat_id)])
            .header("Authorization", &self.bot_token)
            .json(&serde_json::json!({ "text": text }))
            .send()
            .await
            .map_err(|e| anyhow!(describe_http_error(&e)))?;
        if response.status().is_success() {
            return Ok(());
        }
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        let message = body
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("неизвестный ответ MAX");
        bail!("{status}: {message}")
    }
}
