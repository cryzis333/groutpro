use crate::config::Config;

#[allow(dead_code)]
pub struct VkService;

#[allow(dead_code)]
impl VkService {
    pub fn new(_config: &Config) -> Self {
        Self
    }

    pub async fn send_notification(&self, _message: &str) -> anyhow::Result<()> {
        // TODO: Реализуйте интеграцию с VK API / MAX / другим мессенджером
        // Для VK: https://dev.vk.com/api/bots/development
        // Для MAX (Mail.ru Agent) — API устарело, рекомендуется миграция на VK Messenger
        Ok(())
    }
}
