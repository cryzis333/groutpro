use crate::config::Config;
use crate::services::notify::{describe_http_error, escape_html, split_list, Notification};
use anyhow::{anyhow, bail};
use reqwest::Client;
use serde_json::Value;
use std::time::Duration;

/// Telegram rejects messages longer than 4096 characters, and it counts them in
/// UTF-16 code units (an emoji takes two). Every length below is counted the same
/// way; keep a margin.
const MESSAGE_LIMIT: usize = 4000;
const TITLE_LIMIT: usize = 256;
const LINK_LIMIT: usize = 512;

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
        let text = render(notification);
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
    render_within(notification, MESSAGE_LIMIT)
}

/// Builds the HTML message so that it never exceeds `limit` UTF-16 code units. Long
/// values are shortened as raw text *before* escaping, so a cut can never split a
/// tag or an entity like `&amp;` — Telegram would reject the whole message.
fn render_within(notification: &Notification, limit: usize) -> String {
    let mut title_budget = TITLE_LIMIT;
    let title = escape_within(&notification.title, &mut title_budget);
    let mut link_budget = LINK_LIMIT;
    let link = notification
        .link
        .as_deref()
        .map(|link| escape_within(link, &mut link_budget));
    // Fixed markup: "<b></b>\n" around the title, at most "\n<b>label:</b>\n" and a
    // trailing "\n" per field, "\n\n" before the link.
    let markup = 8
        + utf16_len(&title)
        + notification
            .fields
            .iter()
            .map(|(label, _)| utf16_len(label) + 11)
            .sum::<usize>()
        + link.as_ref().map_or(0, |link| utf16_len(link) + 2);
    // What is left is shared by the field values in order: a long value only
    // shortens itself and whatever comes after it.
    let mut budget = limit.saturating_sub(markup);

    let mut text = format!("<b>{title}</b>\n");
    for (label, value) in &notification.fields {
        let multiline = value.contains('\n');
        let value = escape_within(value, &mut budget);
        if multiline {
            text.push_str(&format!("\n<b>{label}:</b>\n{value}\n"));
        } else {
            text.push_str(&format!("\n<b>{label}:</b> {value}"));
        }
    }
    if let Some(link) = link {
        text.push_str(&format!("\n\n{link}"));
    }
    text
}

/// Escapes `value` into at most `budget` UTF-16 code units and takes them off the
/// budget. A value that doesn't fit is cut as raw text at a character boundary,
/// gets "…", and only then is escaped.
fn escape_within(value: &str, budget: &mut usize) -> String {
    let full: usize = value.chars().map(escaped_len).sum();
    if full <= *budget {
        *budget -= full;
        return escape_html(value);
    }
    if *budget == 0 {
        return String::new();
    }
    let room = *budget - 1; // one character is kept for the ellipsis
    let mut used = 0;
    let mut end = 0;
    for (index, ch) in value.char_indices() {
        let len = escaped_len(ch);
        if used + len > room {
            break;
        }
        used += len;
        end = index + ch.len_utf8();
    }
    *budget -= used + 1;
    format!("{}…", escape_html(&value[..end]))
}

/// Length of `ch` after `escape_html`, in UTF-16 code units.
fn escaped_len(ch: char) -> usize {
    match ch {
        '&' => 5,       // &amp;
        '<' | '>' => 4, // &lt; &gt;
        '"' => 6,       // &quot;
        _ => ch.len_utf16(),
    }
}

/// Message length the way Telegram counts it.
fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
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

#[cfg(test)]
mod tests {
    use super::{escape_within, escaped_len, render, render_within, utf16_len, MESSAGE_LIMIT};
    use crate::services::notify::{escape_html, Notification};

    fn notification(fields: Vec<(&'static str, String)>) -> Notification {
        Notification {
            title: "📩 Новая заявка с сайта".to_string(),
            fields,
            link: Some("https://example.ru/admin#leads".to_string()),
            reply_to: None,
        }
    }

    /// Every `&` and `<` must start a complete entity or one of our tags.
    fn assert_well_formed(text: &str) {
        let mut rest = text;
        while let Some(position) = rest.find(['&', '<']) {
            let tail = &rest[position..];
            let token = ["&amp;", "&lt;", "&gt;", "&quot;", "<b>", "</b>"]
                .into_iter()
                .find(|token| tail.starts_with(token))
                .unwrap_or_else(|| panic!("broken markup at {tail:?}"));
            rest = &tail[token.len()..];
        }
        assert_eq!(text.matches("<b>").count(), text.matches("</b>").count());
    }

    #[test]
    fn escaped_len_matches_escape_html() {
        for ch in ['&', '<', '>', '"', 'a', 'ж', '€', '🛒'] {
            let escaped = escape_html(ch.encode_utf8(&mut [0; 4]));
            assert_eq!(escaped_len(ch), utf16_len(&escaped), "{ch}");
        }
    }

    #[test]
    fn short_message_is_kept_whole() {
        let text = render(&notification(vec![
            ("Имя", "Иван <Ко> & сыновья".to_string()),
            ("Смета", "— Грунт × 2\n— Работа × 1\n".to_string()),
        ]));
        assert_eq!(
            text,
            "<b>📩 Новая заявка с сайта</b>\n\
             \n<b>Имя:</b> Иван &lt;Ко&gt; &amp; сыновья\
             \n<b>Смета:</b>\n— Грунт × 2\n— Работа × 1\n\n\
             \n\nhttps://example.ru/admin#leads"
        );
        assert_well_formed(&text);
    }

    #[test]
    fn long_values_are_cut_before_escaping() {
        let estimate = (1..=20)
            .map(|i| format!("— Состав «Гидро-{i}» & <добавка> × {i} = {i}00.00 ₽"))
            .collect::<Vec<_>>()
            .join("\n");
        let fields = vec![
            ("Имя", "Иван".to_string()),
            ("Задача", "\"&<>".repeat(1_000)),
            ("Смета", format!("{estimate}\n")),
            ("Ориентировочно", "12 345.00 ₽".to_string()),
        ];
        let text = render(&notification(fields));
        assert!(utf16_len(&text) <= MESSAGE_LIMIT);
        assert_well_formed(&text);
        assert!(text.contains('…'));
        assert!(text.ends_with("https://example.ru/admin#leads"));
    }

    #[test]
    fn emoji_count_twice_like_in_telegram() {
        let text = render(&notification(vec![("Задача", "🛒".repeat(3_000))]));
        assert!(utf16_len(&text) <= MESSAGE_LIMIT);
        assert!(text.chars().count() < MESSAGE_LIMIT);
        assert!(text.contains('…'));
        assert_well_formed(&text);
    }

    #[test]
    fn every_cut_position_stays_well_formed() {
        let n = notification(vec![("Текст", "a&b<c>d\"e🛒".repeat(10))]);
        // With no room for values at all, only the fixed markup is left.
        let markup_only = utf16_len(&render_within(&n, 0));
        for limit in 0..250 {
            let text = render_within(&n, limit);
            assert_well_formed(&text);
            assert!(utf16_len(&text) <= limit.max(markup_only), "limit {limit}");
        }
    }

    #[test]
    fn escape_within_respects_the_budget() {
        let mut budget = 7;
        assert_eq!(escape_within("&&&", &mut budget), "&amp;…");
        assert_eq!(budget, 1);
        let mut budget = 0;
        assert_eq!(escape_within("abc", &mut budget), "");
        let mut budget = 3;
        assert_eq!(escape_within("abc", &mut budget), "abc");
        assert_eq!(budget, 0);
    }
}
