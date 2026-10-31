# ГраутПро

Сайт услуг и магазин ГраутПро (инъектирование, гидроизоляция, стабилизация грунта).

- **Backend:** Rust (Axum 0.7, sqlx 0.7) и PostgreSQL.
- **Frontend:** статический HTML/CSS/JS.
- **Оплата:** ЮKassa (СБП) или счёт для организаций.
- **Уведомления о заявках и заказах:** Telegram, MAX и почта.

## Архитектура

```
браузер ──HTTPS──> nginx ──┬─ frontend/ (статика, чистые адреса /shop -> shop.html)
                           ├─ /uploads/ (фото товаров, каталог UPLOAD_DIR)
                           └─ /api/, /health ──> backend 127.0.0.1:3100 ──> PostgreSQL
                                                    └─> ЮKassa API, Telegram, MAX, SMTP
```

| Каталог | Что там |
|---|---|
| `frontend/` | Страницы, `css/`, `js/`, `images/`, `sitemap.xml`, `robots.txt`. Все запросы к API относительные (`/api/...`), домен в коде не нужен. Домен встречается только в canonical/OG, sitemap и robots — меняется `deploy/change-domain.sh` |
| `backend/src/` | `main.rs` (маршруты), `config.rs` (переменные окружения), `handlers/` (API), `services/` (checkout, ЮKassa, уведомления), `middleware/auth.rs` (проверка JWT админа) |
| `backend/migrations/` | Миграции sqlx `001`–`015`. Встраиваются в бинарник при сборке и применяются при запуске. **Применённые файлы не редактировать**: изменится контрольная сумма, и backend не запустится. Новое — только новым файлом `016_…` |
| `uploads/` | Загруженные фото (в git только `.gitkeep`) |
| `secrets/notify.env` | Только на сервере, не в git: ключи уведомлений, переопределяют `/etc/groutpro.env` |
| `deploy/` | Выкладка, переезд на домен, nginx, диагностика, SQL (см. ниже) |

На сервере (`/srv/apps/groutpro-next`) backend запускается сервисом `groutpro.service`:

- `EnvironmentFile=/etc/groutpro.env`;
- `ProtectSystem=strict`, запись разрешена только в `uploads/`;
- nginx отдаёт статику сам и проксирует `/api/` и `/health` на `127.0.0.1:3100`.

Backend тоже умеет отдавать `frontend/` и `uploads/` — это нужно для локального запуска без nginx.

## Маршруты

Страницы (чистые адреса настраивает nginx: `try_files $uri $uri.html`):

| Адрес | Файл |
|---|---|
| `/` | `index.html`: услуги, смета, отзывы, заявка |
| `/shop` | `shop.html`: каталог |
| `/product.html?id=<uuid>` или `/product/<uuid>` | `product.html`: карточка товара |
| `/cart` | `cart.html`: корзина, оплата по СБП или счёт |
| `/account` | `account.html`: кабинет покупателя |
| `/privacy-policy` | политика конфиденциальности |
| `/admin`, `/admin/login` | админка и вход в неё |

API. Ошибки всегда приходят в виде `{"error": "текст по-русски"}`.

| Метод и путь | Назначение | Доступ |
|---|---|---|
| `GET /health` | проверка живости, ответ `ok` | все |
| `GET /api/products`, `GET /api/products/:id` | каталог с учётом скидок, порядок `sort_order`; цена 0 = «по запросу» | все |
| `POST /api/payments/create` | заказ и платёж ЮKassa (если ключи заданы) | все, сессия покупателя — по желанию |
| `POST /api/orders/invoice` | заказ со счётом для организации | все |
| `POST /api/payments/webhook` | уведомления ЮKassa (каждый платёж перепроверяется через API ЮKassa) | ЮKassa |
| `POST /api/contact`, `GET/POST /api/reviews`, `POST /api/analytics/view` | заявки, отзывы, статистика просмотров | все |
| `POST /api/auth/register`, `/login`, `/logout`, `GET /api/auth/me` | покупатели: cookie `groutpro_session` (HttpOnly, Secure, 14 дней) | все |
| `GET /api/account/orders`, `PATCH /api/account/profile` | кабинет покупателя | сессия покупателя |
| `POST /api/admin/login` | вход админа → JWT на 24 часа | все |
| `/api/admin/*` | товары (вкл. скрытые, порядок, фото), заказы, заявки, отзывы, скидки, аналитика | заголовок `Authorization: Bearer <JWT>` |

Как устроен вход в админку:

- токен хранится в `localStorage` браузера, `admin.js` добавляет его в каждый запрос;
- без токена или с просроченным токеном админка отправляет на `/admin/login`;
- токен подписан `JWT_SECRET`. Смена секрета выключает все выданные токены — админу нужно войти заново.

Лимиты частоты запросов на вход, формы и оформление заказа задаёт nginx: `deploy/nginx/`.

## Переменные окружения

Порядок чтения: `secrets/notify.env` (путь — `NOTIFY_ENV_FILE`) → переменные процесса (на сервере —
`/etc/groutpro.env` через systemd) → `.env` в текущем каталоге. Значения из `secrets/notify.env`
переопределяют **любые** ключи. Шаблон с комментариями — [`backend/.env.example`](backend/.env.example).

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `DATABASE_URL` | — (**обязательна**) | `postgres://пользователь:пароль@127.0.0.1/база` |
| `JWT_SECRET` | — (**обязательна**, не пустая) | подпись токенов админки; 32+ случайных символа (`openssl rand -hex 32`), иначе предупреждение в журнале |
| `ADMIN_USERNAME` | `admin` | логин админки |
| `ADMIN_PASSWORD_HASH` | — (**обязательна**) | bcrypt-хэш пароля админки |
| `SITE_URL` | нет | `https://домен` без `/` в конце: адрес возврата после оплаты, ссылки в уведомлениях, CORS. Без него онлайн-оплата и ссылки выключены |
| `SERVER_HOST` | `127.0.0.1` | адрес backend; `0.0.0.0` — только в контейнере |
| `SERVER_PORT` | `3100` | порт backend (на него проксирует nginx) |
| `UPLOAD_DIR` | `uploads` | каталог фото товаров. На сервере — `/srv/apps/groutpro-next/uploads` (единственный доступный для записи) |
| `YOOKASSA_SHOP_ID`, `YOOKASSA_SECRET_KEY` | пусто | ЮKassa. Без них онлайн-оплата выключена, счета и заявки работают |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | пусто | уведомления в Telegram; `CHAT_ID` — один или несколько через запятую |
| `TELEGRAM_API_BASE` | `https://api.telegram.org` | адрес Bot API (для своего зеркала) |
| `TELEGRAM_PROXY` | пусто | прокси для Telegram, например `socks5://127.0.0.1:1080` |
| `MAX_BOT_TOKEN`, `MAX_CHAT_ID` | пусто | уведомления в MAX |
| `MAX_API_BASE` | `https://platform-api.max.ru` | адрес API MAX |
| `SMTP_HOST`, `SMTP_PORT` | `smtp.yandex.ru`, `465` | почтовый сервер (SSL) |
| `SMTP_USER`, `SMTP_PASSWORD` | пусто | учётная запись SMTP; для Яндекса — пароль приложения |
| `SMTP_FROM` | = `SMTP_USER` | отправитель писем |
| `ADMIN_EMAIL` | пусто | получатели уведомлений, через запятую |
| `STATS_OBJECTS_BASE` | `10` | прибавка к числу выполненных объектов (обработанные заявки + оплаченные заказы) в `GET /api/stats` |
| `NOTIFY_ENV_FILE` | `secrets/notify.env` | файл с переопределениями (путь от рабочего каталога) |
| `RUST_LOG` | — | backend его не читает: в журнал пишется уровень info и выше |

Проверить каналы уведомлений на сервере (читает `/etc/groutpro.env` и `secrets/notify.env`):

```bash
cd /srv/apps/groutpro-next && sudo ./backend/target/release/groutpro-backend notify-test
```

## Локальная разработка и проверки

Нужны Rust stable (Cargo.lock v4 — Cargo 1.78+) и PostgreSQL. Запускать из корня репозитория:
относительно него ищутся `frontend/`, `uploads/` и `.env`.

```bash
cp backend/.env.example .env      # заполнить DATABASE_URL, JWT_SECRET, ADMIN_PASSWORD_HASH
cargo run --manifest-path backend/Cargo.toml
# сайт: http://127.0.0.1:3100 (без nginx чистые адреса не работают — открывайте /shop.html и т. п.)
```

bcrypt-хэш пароля админки (утилита из пакета `apache2-utils`; пароль спросит интерактивно):

```bash
htpasswd -nBC 12 admin | cut -d: -f2 | sed 's/^\$2y\$/$2b$/'
```

В `.env` хэш берите в одинарные кавычки (`ADMIN_PASSWORD_HASH='$2b$12$…'`): иначе dotenv примет `$…`
за переменные. В `/etc/groutpro.env` (systemd) кавычки не нужны.

Перед коммитом (первые четыре проверки — те же, что в CI, `.github/workflows/ci.yml`):

```bash
cd backend
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
cd ..
for f in frontend/js/*.js; do node --check "$f"; done
bash -n deploy/*.sh
```

CI также не пропускает в репозиторий `.env` и файлы с заполненными `YOOKASSA_SECRET_KEY` или
`SMTP_PASSWORD` (кроме `*.example`). Не коммитьте `.env`, `secrets/`, `uploads/`, дампы и ключи.

`docker-compose.yml` — только для локальной разработки: PostgreSQL наружу не публикуется, backend
доступен на `127.0.0.1:3100`.

## Выкладка и эксплуатация

| Документ | Для чего |
|---|---|
| [deploy/DEPLOY.md](deploy/DEPLOY.md) | выкладка на сервер: копия, сборка, проверки, откат |
| [deploy/DOMAIN_MIGRATION.md](deploy/DOMAIN_MIGRATION.md) | переезд serious-company.ru → groutpro.ru: ЕСИА, DNS, сертификат, ЮKassa, поисковики |
| [deploy/server-check.sh](deploy/server-check.sh) | диагностика сервера, только чтение, секреты скрыты |
| [deploy/change-domain.sh](deploy/change-domain.sh) | замена домена в файлах сайта |
| [deploy/nginx/](deploy/nginx/) | конфиг nginx для groutpro.ru, этап для certbot, зоны лимитов |
| [deploy/sql/content-2026-10.sql](deploy/sql/content-2026-10.sql) | порядок услуг и правки каталога по просьбе заказчика |

## Безопасность данных

- **Деньги и остатки:**
  - стоимость заказа вычисляет сервер; скидка в каталоге и при оплате считается одинаково;
  - заказ, позиции и списание остатков пишутся в одной транзакции;
  - количество, цена и остатки ограничены и в API, и в PostgreSQL.
- **ЮKassa:** webhook не доверяется — платёж перепроверяется через API ЮKassa (статус, сумма, валюта,
  номер заказа). Повторный webhook не меняет уже оплаченный заказ.
- **Загрузки:** только у админа, JPEG/PNG/WebP (проверяется сигнатура) до 5 МБ, не больше 10 файлов,
  имена — UUID.
- **Секреты в логах:** уведомления экранируют пользовательский ввод, URL с токенами в журнал не пишутся.
