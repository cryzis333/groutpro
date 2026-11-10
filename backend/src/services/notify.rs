use crate::config::Config;
use crate::services::{email::EmailService, max::MaxService, telegram::TelegramService};

/// A channel-agnostic message; each service renders it in its own format and
/// takes care of escaping, so callers pass raw user input.
pub struct Notification {
    pub title: String,
    pub fields: Vec<(&'static str, String)>,
    /// The customer's personal data: name, phone, email, address, company/INN and
    /// free text. Renderers never read it: `Notifier::spawn` either moves it in
    /// front of `fields` (NOTIFY_PERSONAL_DATA on) or drops it together with
    /// `reply_to`. Off by default: mailboxes and messengers may sit on servers
    /// abroad, and sending customers' data there is a cross-border transfer under
    /// 152-ФЗ. The admin panel behind `link` always has the full record.
    pub personal: Vec<(&'static str, String)>,
    pub link: Option<String>,
    /// The customer's email, so a reply goes straight to them. Personal data too.
    pub reply_to: Option<String>,
}

impl Notification {
    pub fn plain_text(&self) -> String {
        let mut text = format!("{}\n", self.title);
        for (label, value) in &self.fields {
            if value.contains('\n') {
                text.push_str(&format!("\n{label}:\n{value}\n"));
            } else {
                text.push_str(&format!("\n{label}: {value}"));
            }
        }
        if let Some(link) = &self.link {
            text.push_str(&format!("\n\n{link}"));
        }
        text
    }

    /// Applies the NOTIFY_PERSONAL_DATA setting (see `personal`).
    pub fn prepare(mut self, include_personal: bool) -> Self {
        if include_personal {
            let mut fields = std::mem::take(&mut self.personal);
            fields.append(&mut self.fields);
            self.fields = fields;
        } else {
            if !self.personal.is_empty() {
                self.fields.push((
                    "Подробности",
                    "в админке — персональные данные в уведомления не передаются".to_string(),
                ));
            }
            self.personal.clear();
            self.reply_to = None;
        }
        self
    }
}

/// `Ok(true)` — delivered, `Ok(false)` — channel not configured.
pub type DeliveryResult = anyhow::Result<bool>;

pub struct Notifier {
    telegram: TelegramService,
    max: MaxService,
    email: EmailService,
}

impl Notifier {
    pub fn new(config: &Config) -> Self {
        Self {
            telegram: TelegramService::new(config),
            max: MaxService::new(config),
            email: EmailService::new(config),
        }
    }

    pub async fn send(&self, notification: &Notification) -> Vec<(&'static str, DeliveryResult)> {
        let (telegram, max, email) = tokio::join!(
            self.telegram.send(notification),
            self.max.send(notification),
            self.email.send(notification),
        );
        vec![("Telegram", telegram), ("MAX", max), ("Email", email)]
    }

    /// Fire-and-forget delivery so a slow SMTP server never delays the HTTP response.
    pub fn spawn(config: &Config, notification: Notification) {
        let notifier = Self::new(config);
        let notification = notification.prepare(config.notify_personal_data);
        tokio::spawn(async move {
            for (channel, result) in notifier.send(&notification).await {
                if let Err(error) = result {
                    tracing::warn!(channel, error = %format!("{error:#}"), "notification failed");
                }
            }
        });
    }
}

/// `groutpro-backend notify-test` — sends a test message through every configured
/// channel using the exact production code path, and prints the outcome.
pub async fn cli_self_test() -> anyhow::Result<()> {
    let config = Config::from_env_file(std::path::Path::new("/etc/groutpro.env"))?;
    let notification = Notification {
        title: "✅ Тестовое уведомление ГраутПро".to_string(),
        fields: vec![(
            "Статус",
            "уведомления о заявках и заказах настроены".to_string(),
        )],
        personal: Vec::new(),
        link: config.site_url.clone(),
        reply_to: None,
    };
    let mut failed = false;
    for (channel, result) in Notifier::new(&config).send(&notification).await {
        match result {
            Ok(true) => println!("  {channel}: отправлено"),
            Ok(false) => println!("  {channel}: не настроен (пропущен)"),
            Err(error) => {
                failed = true;
                println!("  {channel}: ОШИБКА — {error:#}");
            }
        }
    }
    if failed {
        anyhow::bail!("не все каналы сработали");
    }
    Ok(())
}

/// Human-readable reqwest error that never includes the request URL
/// (Telegram URLs contain the bot token).
pub fn describe_http_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "сервер не ответил вовремя (возможно, заблокирован)".to_string()
    } else if error.is_connect() {
        "не удалось подключиться (возможно, заблокирован)".to_string()
    } else {
        "ошибка HTTP-запроса".to_string()
    }
}

pub fn split_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .collect()
}

pub fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        let mut cut: String = text.chars().take(max.saturating_sub(1)).collect();
        cut.push('…');
        cut
    }
}

pub fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::Notification;

    fn lead() -> Notification {
        Notification {
            title: "📐 Заявка на замер по смете".to_string(),
            fields: vec![("Ориентировочно", "12500.00 ₽".to_string())],
            personal: vec![
                ("Имя", "Иван Петров".to_string()),
                ("Телефон", "+7 900 123-45-67".to_string()),
                ("Задача", "ул. Садовая, 5 — течёт подвал".to_string()),
            ],
            link: Some("https://example.ru/admin#leads".to_string()),
            reply_to: Some("ivan@example.ru".to_string()),
        }
    }

    #[test]
    fn personal_data_is_left_out_by_default() {
        let n = lead().prepare(false);
        let text = n.plain_text();
        for secret in ["Иван", "900 123", "Садовая", "ivan@"] {
            assert!(!text.contains(secret), "{secret} leaked into: {text}");
        }
        assert!(n.personal.is_empty());
        assert_eq!(n.reply_to, None);
        assert!(text.contains("Ориентировочно: 12500.00 ₽"));
        assert!(text.contains("Подробности: в админке"));
        assert!(text.ends_with("https://example.ru/admin#leads"));
    }

    #[test]
    fn personal_data_goes_first_when_allowed() {
        let n = lead().prepare(true);
        let labels: Vec<_> = n.fields.iter().map(|(label, _)| *label).collect();
        assert_eq!(labels, ["Имя", "Телефон", "Задача", "Ориентировочно"]);
        assert!(n.personal.is_empty());
        assert_eq!(n.reply_to.as_deref(), Some("ivan@example.ru"));
    }

    #[test]
    fn no_details_note_without_personal_data() {
        let mut n = lead();
        n.personal.clear();
        let n = n.prepare(false);
        assert_eq!(n.fields.len(), 1);
    }
}
