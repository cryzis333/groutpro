use crate::config::Config;
use crate::services::{email::EmailService, max::MaxService, telegram::TelegramService};

/// A channel-agnostic message; each service renders it in its own format and
/// takes care of escaping, so callers pass raw user input.
pub struct Notification {
    pub title: String,
    pub fields: Vec<(&'static str, String)>,
    pub link: Option<String>,
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
