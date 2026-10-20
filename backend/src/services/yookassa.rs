use crate::config::Config;
use reqwest::Client;
use serde_json::{json, Value};

pub struct YookassaService {
    client: Client,
    shop_id: String,
    secret_key: String,
}

impl YookassaService {
    pub fn new(config: &Config) -> Self {
        Self {
            client: Client::new(),
            shop_id: config.yookassa_shop_id.clone(),
            secret_key: config.yookassa_secret_key.clone(),
        }
    }

    pub async fn create_payment(
        &self,
        amount: i64,
        order_id: &str,
        description: &str,
        return_url: &str,
    ) -> anyhow::Result<Value> {
        let amount_rub = amount as f64 / 100.0;
        let payload = json!({
            "amount": {
                "value": format!("{:.2}", amount_rub),
                "currency": "RUB"
            },
            "capture": true,
            "confirmation": {
                "type": "redirect",
                "return_url": return_url
            },
            "description": description,
            "metadata": {
                "order_id": order_id
            },
            "payment_method_data": {
                "type": "sbp"
            }
        });

        let res = self
            .client
            .post("https://api.yookassa.ru/v3/payments")
            .basic_auth(&self.shop_id, Some(&self.secret_key))
            .header("Idempotence-Key", uuid::Uuid::new_v4().to_string())
            .json(&payload)
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;

        if !res.get("id").is_some_and(Value::is_string) || res.get("status").is_none() {
            return Err(anyhow::anyhow!("YooKassa rejected payment creation"));
        }
        Ok(res)
    }

    pub async fn get_payment(&self, payment_id: &str) -> anyhow::Result<Value> {
        if !is_valid_payment_id(payment_id) {
            anyhow::bail!("malformed YooKassa payment id");
        }
        let response = self
            .client
            .get(format!("https://api.yookassa.ru/v3/payments/{payment_id}"))
            .basic_auth(&self.shop_id, Some(&self.secret_key))
            .send()
            .await?
            .error_for_status()?;
        Ok(response.json::<Value>().await?)
    }
}

/// YooKassa payment ids are UUID-like strings. Anything else is rejected before
/// it is put into the API URL (it would otherwise reach other endpoints with the
/// shop's credentials).
pub fn is_valid_payment_id(payment_id: &str) -> bool {
    (1..=64).contains(&payment_id.len())
        && payment_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::is_valid_payment_id;

    #[test]
    fn accepts_yookassa_ids() {
        assert!(is_valid_payment_id("2d4f8c3e-000f-5000-9000-1b3c5e7a9d0f"));
        assert!(is_valid_payment_id("a"));
        assert!(is_valid_payment_id(&"A".repeat(64)));
    }

    #[test]
    fn rejects_malformed_ids() {
        assert!(!is_valid_payment_id(""));
        assert!(!is_valid_payment_id(&"a".repeat(65)));
        assert!(!is_valid_payment_id("../refunds"));
        assert!(!is_valid_payment_id("abc?x=1"));
        assert!(!is_valid_payment_id("abc/def"));
        assert!(!is_valid_payment_id("abc def"));
        assert!(!is_valid_payment_id("платёж"));
    }
}
