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

        let response = self
            .client
            .post("https://api.yookassa.ru/v3/payments")
            .basic_auth(&self.shop_id, Some(&self.secret_key))
            .header("Idempotence-Key", uuid::Uuid::new_v4().to_string())
            .json(&payload)
            .send()
            .await?
            .error_for_status()?;

        Ok(response.json::<Value>().await?)
    }

    pub async fn get_payment(&self, payment_id: &str) -> anyhow::Result<Value> {
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
