use dotenvy::dotenv;
use std::{collections::HashMap, env, io, path::Path};

/// Notification credentials (Telegram/MAX/SMTP) live in a separate file owned by
/// the service user, so the site owner can update them with
/// `groutpro-notify-setup.py` without sudo. Values there override /etc/groutpro.env.
const DEFAULT_NOTIFY_ENV_FILE: &str = "secrets/notify.env";

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
    pub server_port: u16,
    pub upload_dir: String,
    pub site_url: Option<String>,
    pub stats_objects_base: i64,
}

impl Config {
    pub fn from_env() -> Self {
        dotenv().ok();
        let overrides = notify_overrides();
        Self::build(|key| overrides.get(key).cloned().or_else(|| env::var(key).ok()))
    }

    /// Used by the `notify-test` CLI: an interactive shell doesn't have the
    /// systemd EnvironmentFile loaded, so read it directly.
    pub fn from_env_file(base: &Path) -> io::Result<Self> {
        let base_vars = read_env_file(base)?;
        let overrides = notify_overrides();
        Ok(Self::build(|key| {
            overrides
                .get(key)
                .or_else(|| base_vars.get(key))
                .cloned()
                .or_else(|| env::var(key).ok())
        }))
    }

    fn build(get: impl Fn(&str) -> Option<String>) -> Self {
        let or_default = |key: &str| get(key).unwrap_or_default();
        Self {
            database_url: get("DATABASE_URL").expect("DATABASE_URL must be set"),
            jwt_secret: get("JWT_SECRET").expect("JWT_SECRET must be set"),
            admin_username: get("ADMIN_USERNAME").unwrap_or_else(|| "admin".to_string()),
            admin_password_hash: get("ADMIN_PASSWORD_HASH")
                .expect("ADMIN_PASSWORD_HASH must be set"),
            yookassa_shop_id: get("YOOKASSA_SHOP_ID").expect("YOOKASSA_SHOP_ID must be set"),
            yookassa_secret_key: get("YOOKASSA_SECRET_KEY")
                .expect("YOOKASSA_SECRET_KEY must be set"),
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
            smtp_port: get("SMTP_PORT")
                .and_then(|v| v.parse().ok())
                .unwrap_or(465),
            smtp_user: or_default("SMTP_USER"),
            smtp_password: or_default("SMTP_PASSWORD"),
            smtp_from: or_default("SMTP_FROM"),
            admin_email: or_default("ADMIN_EMAIL"),
            server_port: get("SERVER_PORT")
                .unwrap_or_else(|| "3000".to_string())
                .parse()
                .unwrap(),
            upload_dir: get("UPLOAD_DIR").unwrap_or_else(|| "uploads".to_string()),
            site_url: get("SITE_URL"),
            stats_objects_base: get("STATS_OBJECTS_BASE")
                .and_then(|v| v.parse().ok())
                .unwrap_or(10),
        }
    }
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
