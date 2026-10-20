use crate::config::Config;
use crate::services::notify::{escape_html, split_list, Notification};
use anyhow::{anyhow, Context};
use lettre::{
    message::{Mailbox, MultiPart},
    transport::smtp::authentication::Credentials,
    AsyncSmtpTransport, AsyncTransport, Message,
};
use std::time::Duration;

pub struct EmailService {
    host: String,
    port: u16,
    user: String,
    password: String,
    from: String,
    recipients: Vec<String>,
}

impl EmailService {
    pub fn new(config: &Config) -> Self {
        Self {
            host: config.smtp_host.clone(),
            port: config.smtp_port,
            user: config.smtp_user.clone(),
            password: config.smtp_password.clone(),
            from: if config.smtp_from.is_empty() {
                config.smtp_user.clone()
            } else {
                config.smtp_from.clone()
            },
            recipients: split_list(&config.admin_email),
        }
    }

    pub async fn send(&self, notification: &Notification) -> anyhow::Result<bool> {
        if self.user.is_empty() || self.from.is_empty() || self.recipients.is_empty() {
            return Ok(false);
        }

        // 587 speaks STARTTLS; 465 (and anything else) uses implicit TLS.
        let builder = if self.port == 587 {
            AsyncSmtpTransport::<lettre::Tokio1Executor>::starttls_relay(&self.host)
        } else {
            AsyncSmtpTransport::<lettre::Tokio1Executor>::relay(&self.host)
        }
        .map_err(|_| anyhow!("неверный SMTP_HOST"))?;
        let mailer = builder
            .port(self.port)
            .credentials(Credentials::new(self.user.clone(), self.password.clone()))
            .timeout(Some(Duration::from_secs(20)))
            .build();

        let mut message = Message::builder()
            .from(self.from.parse::<Mailbox>().context("неверный SMTP_FROM")?)
            .subject(&notification.title);
        for recipient in &self.recipients {
            message = message.to(recipient
                .parse::<Mailbox>()
                .with_context(|| format!("неверный адрес получателя {recipient}"))?);
        }
        if let Some(reply_to) = notification
            .reply_to
            .as_deref()
            .and_then(|r| r.parse::<Mailbox>().ok())
        {
            message = message.reply_to(reply_to);
        }
        let email = message.multipart(MultiPart::alternative_plain_html(
            notification.plain_text(),
            render_html(notification),
        ))?;

        mailer.send(email).await.context("SMTP")?;
        Ok(true)
    }
}

fn render_html(notification: &Notification) -> String {
    let rows: String = notification
        .fields
        .iter()
        .map(|(label, value)| {
            format!(
                "<tr><td style=\"padding:6px 16px 6px 0;color:#666;vertical-align:top;white-space:nowrap\">{label}</td>\
                 <td style=\"padding:6px 0;white-space:pre-wrap\">{}</td></tr>",
                escape_html(value)
            )
        })
        .collect();
    let link = notification
        .link
        .as_deref()
        .map(|l| {
            let l = escape_html(l);
            format!("<p style=\"margin-top:20px\"><a href=\"{l}\">{l}</a></p>")
        })
        .unwrap_or_default();
    format!(
        "<div style=\"font-family:Arial,sans-serif;font-size:15px;color:#111\">\
         <h2 style=\"margin:0 0 16px\">{}</h2><table style=\"border-collapse:collapse\">{rows}</table>{link}</div>",
        escape_html(&notification.title)
    )
}
