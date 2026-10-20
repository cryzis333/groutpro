use anyhow::Context;
use dotenvy::dotenv;
use std::{collections::HashMap, env, io, path::Path};

/// Notification credentials (Telegram/MAX/SMTP) live in a separate file owned by
/// the service user, so the site owner can update them with
/// `groutpro-notify-setup.py` without sudo. Values there override /etc/groutpro.env.
const DEFAULT_NOTIFY_ENV_FILE: &str = "secrets/notify.env";

/// Admin tokens are HS256-signed with JWT_SECRET; a short secret can be brute-forced
/// offline from any issued token.
const RECOMMENDED_JWT_SECRET_LEN: usize = 32;
const DEFAULT_SERVER_HOST: &str = "127.0.0.1";
/// nginx proxies /api/ to this port.
const DEFAULT_SERVER_PORT: u16 = 3100;

#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    pub jwt_secret: String,
    pub admin_username: String,
    pub admin_password_hash: String,
    pub yookassa_shop_id: String,
    pub yookassa_secret_key: String,
    pub telegram_bot_token: String,
    pub telegram_chat_id: String,
    pub telegram_api_base: String,
    pub telegram_proxy: String,
    pub max_bot_token: String,
    pub max_chat_id: String,
    pub max_api_base: String,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_user: String,
    pub smtp_password: String,
    pub smtp_from: String,
    pub admin_email: String,
    pub server_host: String,
    pub server_port: u16,
    pub upload_dir: String,
    pub site_url: Option<String>,
    pub stats_objects_base: i64,
}

impl Config {
    /// Server configuration. Fails (and the service refuses to start) when a
    /// required value is missing or JWT_SECRET is empty.
    pub fn from_env() -> anyhow::Result<Self> {
        dotenv().ok();
        let overrides = notify_overrides();
        let config = Self::build(|key| overrides.get(key).cloned().or_else(|| env::var(key).ok()))?;
        config.warn_about_disabled_features();
        Ok(config)
    }

    /// Used by the `notify-test` CLI: an interactive shell doesn't have the
    /// systemd EnvironmentFile loaded, so read it directly.
    pub fn from_env_file(base: &Path) -> anyhow::Result<Self> {
        let base_vars =
            read_env_file(base).with_context(|| format!("cannot read {}", base.display()))?;
        let overrides = notify_overrides();
        Self::build(|key| {
            overrides
                .get(key)
                .or_else(|| base_vars.get(key))
                .cloned()
                .or_else(|| env::var(key).ok())
        })
    }

    /// Online payment needs both YooKassa credentials. Without them the shop still
    /// works: invoices and leads are accepted, `/api/payments/create` explains that
    /// online payment is unavailable.
    pub fn payments_enabled(&self) -> bool {
        !self.yookassa_shop_id.is_empty() && !self.yookassa_secret_key.is_empty()
    }

    fn warn_about_disabled_features(&self) {
        if self.jwt_secret.chars().count() < RECOMMENDED_JWT_SECRET_LEN {
            tracing::warn!(
                "JWT_SECRET is shorter than {RECOMMENDED_JWT_SECRET_LEN} characters; \
                 use a long random value (e.g. openssl rand -hex 32)"
            );
        }
        if !self.payments_enabled() {
            tracing::warn!(
                "YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY are not set: online payment is disabled"
            );
        }
        match self.site_url.as_deref() {
            None => tracing::warn!(
                "SITE_URL is not set: online payment and links in notifications are disabled"
            ),
            Some(url) if !url.starts_with("https://") && !url.starts_with("http://") => {
                tracing::warn!(url, "SITE_URL should start with https://")
            }
            Some(_) => {}
        }
    }

    fn build(get: impl Fn(&str) -> Option<String>) -> anyhow::Result<Self> {
        let or_default = |key: &str| get(key).unwrap_or_default();
        let required = |key: &str| {
            get(key)
                .filter(|value| !value.trim().is_empty())
                .with_context(|| format!("{key} must be set and not empty"))
        };
        let server_port = match non_empty(get("SERVER_PORT")) {
            Some(value) => value
                .parse::<u16>()
                .with_context(|| format!("SERVER_PORT must be a port number, got {value:?}"))?,
            None => DEFAULT_SERVER_PORT,
        };
        Ok(Self {
            database_url: required("DATABASE_URL")?,
            jwt_secret: required("JWT_SECRET")?,
            admin_username: get("ADMIN_USERNAME").unwrap_or_else(|| "admin".to_string()),
            admin_password_hash: required("ADMIN_PASSWORD_HASH")?,
            yookassa_shop_id: non_empty(get("YOOKASSA_SHOP_ID")).unwrap_or_default(),
            yookassa_secret_key: non_empty(get("YOOKASSA_SECRET_KEY")).unwrap_or_default(),
            telegram_bot_token: or_default("TELEGRAM_BOT_TOKEN"),
            telegram_chat_id: or_default("TELEGRAM_CHAT_ID"),
            telegram_api_base: get("TELEGRAM_API_BASE")
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "https://api.telegram.org".to_string()),
            telegram_proxy: or_default("TELEGRAM_PROXY"),
            max_bot_token: or_default("MAX_BOT_TOKEN"),
            max_chat_id: or_default("MAX_CHAT_ID"),
            // platform-api2.max.ru is signed by the Russian Trusted CA, which isn't in
            // the system trust store; platform-api.max.ru serves the same API with a
            // publicly trusted certificate.
            max_api_base: get("MAX_API_BASE")
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "https://platform-api.max.ru".to_string()),
            smtp_host: get("SMTP_HOST").unwrap_or_else(|| "smtp.yandex.ru".to_string()),
            smtp_port: get("SMTP_PORT").and_then(|v| v.parse().ok()).unwrap_or(465),
            smtp_user: or_default("SMTP_USER"),
            smtp_password: or_default("SMTP_PASSWORD"),
            smtp_from: or_default("SMTP_FROM"),
            admin_email: or_default("ADMIN_EMAIL"),
            server_host: non_empty(get("SERVER_HOST"))
                .unwrap_or_else(|| DEFAULT_SERVER_HOST.to_string()),
            server_port,
            upload_dir: get("UPLOAD_DIR").unwrap_or_else(|| "uploads".to_string()),
            site_url: normalize_site_url(get("SITE_URL")),
            stats_objects_base: get("STATS_OBJECTS_BASE")
                .and_then(|v| v.parse().ok())
                .unwrap_or(10),
        })
    }
}

/// `KEY=` (or whitespace only) means the same as an absent key.
fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// SITE_URL is glued with paths like `/cart.html`, so a trailing slash would
/// produce `//cart.html`.
fn normalize_site_url(value: Option<String>) -> Option<String> {
    non_empty(value)
        .map(|v| v.trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty())
}

fn notify_overrides() -> HashMap<String, String> {
    let path = env::var("NOTIFY_ENV_FILE").unwrap_or_else(|_| DEFAULT_NOTIFY_ENV_FILE.to_string());
    match read_env_file(Path::new(&path)) {
        Ok(vars) => vars,
        Err(error) if error.kind() == io::ErrorKind::NotFound => HashMap::new(),
        Err(error) => {
            tracing::warn!(%error, path, "cannot read notification settings file");
            HashMap::new()
        }
    }
}

/// Parses systemd-EnvironmentFile-style `KEY=value` lines. Unlike dotenv, `$` is
/// never expanded (bcrypt hashes and passwords contain it). Single quotes are
/// literal; double quotes support `\"` and `\\`.
pub fn read_env_file(path: &Path) -> io::Result<HashMap<String, String>> {
    let content = std::fs::read_to_string(path)?;
    let mut vars = HashMap::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim().trim_start_matches("export ").trim();
        let value = value.trim();
        let value = if value.len() >= 2 && value.starts_with('\'') && value.ends_with('\'') {
            value[1..value.len() - 1].to_string()
        } else if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
            value[1..value.len() - 1]
                .replace("\\\"", "\"")
                .replace("\\\\", "\\")
        } else {
            value.to_string()
        };
        vars.insert(key.to_string(), value);
    }
    Ok(vars)
}
