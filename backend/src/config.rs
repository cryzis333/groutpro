use anyhow::{bail, Context};
use dotenvy::dotenv;
use std::env;

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
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_user: String,
    pub smtp_password: String,
    pub smtp_from: String,
    pub admin_email: String,
    pub server_host: String,
    pub server_port: u16,
    pub upload_dir: String,
    pub site_url: String,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        dotenv().ok();
        let config = Self {
            database_url: required("DATABASE_URL")?,
            jwt_secret: required("JWT_SECRET")?,
            admin_username: required("ADMIN_USERNAME")?,
            admin_password_hash: required("ADMIN_PASSWORD_HASH")?,
            yookassa_shop_id: env::var("YOOKASSA_SHOP_ID").unwrap_or_default(),
            yookassa_secret_key: env::var("YOOKASSA_SECRET_KEY").unwrap_or_default(),
            telegram_bot_token: env::var("TELEGRAM_BOT_TOKEN").unwrap_or_default(),
            telegram_chat_id: env::var("TELEGRAM_CHAT_ID").unwrap_or_default(),
            smtp_host: env::var("SMTP_HOST").unwrap_or_else(|_| "smtp.yandex.ru".into()),
            smtp_port: env::var("SMTP_PORT")
                .unwrap_or_else(|_| "465".into())
                .parse()
                .context("SMTP_PORT must be a number")?,
            smtp_user: env::var("SMTP_USER").unwrap_or_default(),
            smtp_password: env::var("SMTP_PASSWORD").unwrap_or_default(),
            smtp_from: env::var("SMTP_FROM").unwrap_or_default(),
            admin_email: env::var("ADMIN_EMAIL").unwrap_or_default(),
            server_host: env::var("SERVER_HOST").unwrap_or_else(|_| "127.0.0.1".into()),
            server_port: env::var("SERVER_PORT")
                .unwrap_or_else(|_| "3100".into())
                .parse()
                .context("SERVER_PORT must be a number")?,
            upload_dir: env::var("UPLOAD_DIR").unwrap_or_else(|_| "uploads".into()),
            site_url: required("SITE_URL")?.trim_end_matches('/').to_string(),
        };
        if config.jwt_secret.len() < 32 {
            bail!("JWT_SECRET must contain at least 32 characters");
        }
        if !config.site_url.starts_with("https://") {
            bail!("SITE_URL must use https://");
        }
        Ok(config)
    }

    pub fn payments_enabled(&self) -> bool {
        !self.yookassa_shop_id.is_empty() && !self.yookassa_secret_key.is_empty()
    }
}

fn required(name: &str) -> anyhow::Result<String> {
    env::var(name).with_context(|| format!("{name} must be set"))
}
