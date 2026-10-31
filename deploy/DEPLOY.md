# Выкладка ГраутПро на сервер

Как выкатить код этого репозитория в `/srv/apps/groutpro-next` на боевой (тестовый) сервер:
Ubuntu 26.04, PostgreSQL 18, nginx 1.28, сервис `groutpro.service`.

- **Время:** 30–40 минут, почти всё уходит на сборку.
- **Простой сайта:** только перезапуск сервиса, несколько секунд. Пока идёт сборка, работает старая версия.
- **База:** в этой версии новых миграций нет, схема остаётся на версии 15.
- **nginx:** при выкладке не меняется. Новый домен и лимиты запросов — в [DOMAIN_MIGRATION.md](DOMAIN_MIGRATION.md).

Команды выполняются под пользователем `cryzis` (владелец каталога проекта и Rust), `sudo` — там, где он написан.
На сервере нет утилиты для вывода первых строк, поэтому везде `sed -n '1,Np'`.

## Что изменилось для сервера

| Что | Было (снимок 801c7f2) | Стало | Нужно ли менять env |
|---|---|---|---|
| Адрес backend | `127.0.0.1` жёстко в коде | `SERVER_HOST`, по умолчанию `127.0.0.1` | нет; если в env есть `SERVER_HOST=0.0.0.0` — убрать (шаг 6) |
| Порт backend | `SERVER_PORT`, по умолчанию 3000 | по умолчанию 3100 | нет |
| `JWT_SECRET` | пустое значение принималось | пустое — сервис не стартует; короче 32 символов — предупреждение в журнале | проверить длину (шаг 6) |
| ЮKassa | без `YOOKASSA_*` сервис не стартовал | необязательна: без ключей онлайн-оплата выключена, счета и заявки работают | нет |
| `SITE_URL` | `/` в конце ломал ссылки | `/` в конце отбрасывается | лучше писать без `/` |
| `secrets/notify.env` | переопределяет любые ключи из `/etc/groutpro.env` | так же | проверить, что там нет `SITE_URL`, `JWT_SECRET`, `DATABASE_URL` |
| `/health` | маршрута не было | отвечает `ok` | — |

Порядок чтения настроек: `secrets/notify.env` → `/etc/groutpro.env` (systemd) → `.env` в каталоге проекта.

## 0. Переменные

Вставьте в каждую новую SSH-сессию. Ветку уточните перед выкладкой: в ней должны быть все исправления.

```bash
APP=/srv/apps/groutpro-next
BRANCH=claude/sweet-volta-u64kpl      # ветка с исправлениями (может называться иначе)
SERVICE=groutpro.service
ENV_FILE=/etc/groutpro.env
NOTIFY_FILE=$APP/secrets/notify.env
D=serious-company.ru                   # текущий домен сайта; после переезда — groutpro.ru
BK=/srv/backups/groutpro-next/$(date +%F-%H%M)
```

Если сессия оборвалась после шага 2, `BK` должен указывать на уже созданную копию, а не на новую:

```bash
BK=$(sudo ls -d /srv/backups/groutpro-next/*/ | sort | sed -n '$p'); BK=${BK%/}; echo "$BK"
```

## 1. Проверки перед началом (ничего не меняют)

```bash
id -un                                                   # cryzis
stat -c '%U %n' "$APP" "$APP/.git" "$APP/backend/target" # везде cryzis
cd "$APP"
git remote -v | sed -E 's#://[^/@]*@#://***@#'           # origin -> репозиторий проекта на GitHub (токен скрыт)
git fetch origin                                         # скачивает ветки, рабочие файлы не трогает
git log --oneline -8 "origin/$BRANCH"                    # верхние коммиты — нужные исправления
git rev-parse --short HEAD                               # 8985940 — так сейчас на сервере
git cat-file -t 801c7f2                                  # commit — снимок сервера есть локально
git diff --stat 801c7f2 "origin/$BRANCH" -- backend/migrations   # ПУСТО — миграции те же
```

- `git cat-file` ответил ошибкой — снимок лежит в ветке `server-snapshot`: `git fetch origin server-snapshot`.
- `git diff` по миграциям **не пустой** — дальше не идите: файлы миграций изменились, и sqlx не запустит
  backend на базе, где применены старые версии.

Сборка и место на диске:

```bash
cargo --version && rustc --version   # Rust stable; если сборка попросит версию новее — rustup update stable
df -h /srv /                         # на /srv свободно не меньше 3 ГБ
free -h                              # меньше 2 ГБ памяти — собирайте с -j 1 (шаг 5)
du -sh "$APP/backend/target" "$APP/uploads"
```

Полная диагностика. До выкладки скрипта в каталоге проекта ещё нет, поэтому берём его из ветки:

```bash
git -C "$APP" show "origin/$BRANCH:deploy/server-check.sh" > ~/server-check.sh
sudo bash ~/server-check.sh > ~/server-check-before.txt 2>&1
grep -- '->' ~/server-check-before.txt              # выводы и предупреждения
sed -n '1,250p' ~/server-check-before.txt           # весь отчёт (секреты в нём скрыты)
```

Ожидается: «рабочая копия совпадает со снимком 801c7f2», «миграции 1..15 применены»,
«все 15 применённых миграций совпадают с файлами». Предупреждения про `SERVER_HOST`, `JWT_SECRET`
и `SITE_URL` разбираются на шаге 6.

## 2. Резервная копия

Каталог копии доступен только root. Команды запускаются из `/`, чтобы `postgres` не ругался на
домашний каталог.

```bash
sudo install -d -m 700 "$BK"
cd /

# 2.1 Имя базы из DATABASE_URL — сам URL с паролем на экран не выводится
DB=$(sudo awk -F/ '/^DATABASE_URL=/{ sub(/[?"\047\r].*$/, "", $NF); print $NF }' "$ENV_FILE"); echo "БД: $DB"
sudo grep -c '^DATABASE_URL=' "$NOTIFY_FILE" 2>/dev/null   # 0 или пусто — notify.env базу не переопределяет

# 2.2 Дамп базы (custom-формат для pg_restore)
sudo -u postgres pg_dump -Fc -d "$DB" | sudo tee "$BK/db-$DB.dump" > /dev/null; echo "коды: ${PIPESTATUS[*]}"
sudo pg_restore -l "$BK/db-$DB.dump" | grep -c 'TABLE DATA'   # около 11 — таблицы с данными

# 2.3 Файлы проекта целиком (код, .git, uploads, secrets), кроме результатов сборки
sudo tar -C "$APP" --exclude=./backend/target -czf "$BK/files.tar.gz" .
sudo tar -tzf "$BK/files.tar.gz" | grep -c -E '^\./(frontend/index\.html|backend/src/main\.rs|backend/migrations/015_price_by_request\.sql|secrets/notify\.env)$'

# 2.4 Текущий бинарник и конфиги
sudo cp -a "$APP/backend/target/release/groutpro-backend" "$BK/groutpro-backend.prev"
sudo cp -a "$ENV_FILE" "$BK/groutpro.env"
sudo cp -a /etc/nginx/sites-available/groutpro "$BK/nginx-groutpro"
systemctl cat "$SERVICE" | sudo tee "$BK/groutpro.service.txt" > /dev/null
git -C "$APP" rev-parse HEAD | sudo tee "$BK/git-head.txt" > /dev/null
sudo sha256sum "$APP/backend/target/release/groutpro-backend" "$BK/groutpro-backend.prev"
sudo ls -la "$BK"
```

Проверка:

- `коды: 0 0` — дамп записан без ошибок; число `TABLE DATA` больше нуля;
- `grep -c` по архиву показал `4` (`3` — если `secrets/notify.env` на сервере нет);
- у бинарника и копии одинаковые суммы sha256.

## 3. Состояние базы

```bash
sudo -u postgres psql -X -d "$DB" -Atc "SELECT count(*), min(version), max(version), bool_and(success) FROM _sqlx_migrations"
```

| Ответ | Что значит |
|---|---|
| `15\|1\|15\|t` | всё как ожидается, продолжайте |
| max больше 15 | в базе миграции от другого кода — **стоп**, новый бинарник с ней не запустится |
| count меньше 15 | недостающие миграции backend применит сам при запуске (копия базы уже есть) |
| последнее поле `f` | одна из миграций упала — **стоп**, разбираться по журналу |

## 4. Переключение кода на ветку

### 4.1 Рабочая копия = снимок 801c7f2

Сейчас на сервере `HEAD` = 8985940, а файлы поверх него — незакоммиченное содержимое снимка 801c7f2.
Убедимся, что после снимка на сервере ничего не правили (сравнение через временный индекс,
настоящий индекс git не меняется):

```bash
cd "$APP"
T=$(mktemp) && GIT_INDEX_FILE=$T git read-tree 801c7f2 && GIT_INDEX_FILE=$T git update-index -q --refresh; GIT_INDEX_FILE=$T git diff --stat; rm -f "$T"
```

Пустой вывод — правок нет. Если что-то вывелось, эти правки сделаны на сервере после снимка:
посмотрите их (та же команда без `--stat`) и решите, нужны ли они. В любом случае они сохранены
в `$BK/files.tar.gz`.

### 4.2 Переключение

```bash
git checkout -f -B deploy "origin/$BRANCH"
git log --oneline -1                    # верхний коммит ветки
git status --short                      # пусто (строки «??» — см. ниже)
ls -ld secrets uploads backend/target   # всё на месте
```

Почему это безопасно:

- `-B deploy` создаёт (или переставляет) локальную ветку `deploy` на `origin/$BRANCH`. `-f` отбрасывает
  незакоммиченные изменения отслеживаемых файлов и перезаписывает неотслеживаемые файлы, которые
  есть в ветке. Сейчас эти изменения — ровно снимок 801c7f2: он хранится в GitHub
  (ветка `server-snapshot`) и в `$BK/files.tar.gz`, а шаг 4.1 подтвердил, что других правок нет.
- Файлы, которых нет в ветке, git не трогает: `secrets/`, содержимое `uploads/` и `backend/target/`
  (там текущий бинарник) остаются как были. В `.gitignore` ветки они тоже перечислены.
- База не меняется. Работающий процесс продолжает отвечать: бинарник уже загружен в память.
- **Не запускайте `git clean`**, особенно с `-x`: он удаляет неотслеживаемые и игнорируемые файлы,
  то есть `uploads/`, `secrets/` и сборку.

Строки `??` в `git status` — остатки снимка, которых нет в ветке. Они ни на что не влияют.

## 5. Сборка

```bash
cd "$APP/backend"
cargo build --release --locked          # 5–20 минут; при нехватке памяти: cargo build --release --locked -j 1
echo "код выхода: $?"                     # 0
ls -l --time-style='+%F %T' target/release/groutpro-backend   # время — только что
```

- Сборку лучше запускать в `tmux` или `screen`: если SSH оборвётся, она не прервётся.
- `--locked` собирает строго по `Cargo.lock` из репозитория. Ошибка «lock file needs to be updated»
  означает, что ветка собрана неправильно: не обходите её, сообщите разработчику.
- Если сборка упала, сайт продолжает работать на старом бинарнике. Код можно вернуть по шагу 10.1,
  бинарник при этом трогать не нужно.

## 6. Переменные окружения

Посмотреть, какие ключи заданы (только имена, без значений):

```bash
sudo sed -n -E 's/^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=.*/\1/p' "$ENV_FILE" | sort | tr '\n' ' '; echo
sudo sed -n -E 's/^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=.*/\1/p' "$NOTIFY_FILE" | sort | tr '\n' ' '; echo
```

Несекретные значения:

```bash
sudo grep -H -E '^(SITE_URL|SERVER_HOST|SERVER_PORT|UPLOAD_DIR)=' "$ENV_FILE" "$NOTIFY_FILE"
```

Ожидается:

- `SITE_URL=https://serious-company.ru` — без `/` в конце и только в `$ENV_FILE`;
- `SERVER_HOST` нет или `127.0.0.1`; `SERVER_PORT` нет или `3100`;
- `UPLOAD_DIR` нет или `/srv/apps/groutpro-next/uploads`. Другой путь из-за `ProtectSystem=strict`
  будет только для чтения, и загрузка фото сломается.

Исправления (копия env уже лежит в `$BK/groutpro.env`):

```bash
sudo sed -i 's/^SERVER_HOST=.*/SERVER_HOST=127.0.0.1/' "$ENV_FILE"   # если было 0.0.0.0
sudo sed -i -E 's#^(SITE_URL=.*[^/])/+$#\1#' "$ENV_FILE"             # убрать «/» в конце SITE_URL
```

Длина `JWT_SECRET` — сам секрет не печатается:

```bash
sudo awk '/^JWT_SECRET=/{ sub(/^JWT_SECRET=/, ""); sub(/\r$/, ""); gsub(/^["\047]|["\047]$/, ""); print FILENAME ": " length($0) }' "$ENV_FILE" "$NOTIFY_FILE"
```

- Ничего не вывелось или длина 0 — новая версия **не запустится**. Короче 32 — запустится, но
  секрет лучше заменить.
- Замена (старые входы в админку станут недействительны, войти нужно заново):

  ```bash
  NEW=$(openssl rand -hex 32); if sudo grep -q '^JWT_SECRET=' "$ENV_FILE"; then sudo sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$NEW/" "$ENV_FILE"; else echo "JWT_SECRET=$NEW" | sudo tee -a "$ENV_FILE" > /dev/null; fi; unset NEW
  ```

- Если `JWT_SECRET` есть в `secrets/notify.env`, действует именно он: правьте там или удалите
  оттуда эту строку.

ЮKassa:

```bash
sudo grep -c -E '^YOOKASSA_(SHOP_ID|SECRET_KEY)=.+' "$ENV_FILE" "$NOTIFY_FILE"
```

Сумма `2` — онлайн-оплата включена. `0` — выключена: это допустимо, работают счета для юрлиц и заявки.

## 7. Перезапуск и проверка backend

```bash
sudo systemctl restart "$SERVICE"
systemctl is-active "$SERVICE"                    # active
sudo journalctl -u "$SERVICE" -n 30 --no-pager    # «Server listening on 127.0.0.1:3100», без ERROR
curl -sS http://127.0.0.1:3100/health; echo       # ok
sudo ss -ltnp | grep ':3100'                      # 127.0.0.1:3100 — не 0.0.0.0 и не *
```

| В журнале | Причина | Что делать |
|---|---|---|
| `JWT_SECRET must be set and not empty` | секрет пустой | шаг 6 |
| `… must be set and not empty` (другой ключ) | нет `DATABASE_URL` или `ADMIN_PASSWORD_HASH` | вернуть из `$BK/groutpro.env` |
| `migration N was previously applied but is missing` | в базе миграция новее кода | откат, шаг 10.1 |
| `migration N was previously applied but has been modified` | файл миграции отличается от применённого | откат, шаг 10.1 |
| `Address already in use` | порт 3100 занят | `sudo ss -ltnp \| grep 3100` |
| `Read-only file system` / `Permission denied` про uploads | `UPLOAD_DIR` вне `ReadWritePaths` | шаг 6 |

## 8. Проверка через nginx

С самого сервера внешний IP может не открываться (домашний роутер), поэтому запросы идут на
127.0.0.1 с нужным именем сайта:

```bash
for p in / /shop /cart /account /privacy-policy /admin /admin/login /robots.txt /sitemap.xml /health "/api/products?page_size=1" /api/reviews; do
  printf '%-28s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' --resolve "$D:443:127.0.0.1" "https://$D$p")"
done
```

Везде `200`. Дальше:

```bash
curl -s --resolve "$D:443:127.0.0.1" "https://$D/health"; echo                    # ok
curl -s -w ' %{http_code}\n' --resolve "$D:443:127.0.0.1" "https://$D/api/admin/products"   # {"error":"…"} 401
ID=$(curl -s --resolve "$D:443:127.0.0.1" "https://$D/api/products?page_size=1" | grep -o '"id":"[0-9a-f-]*"' | sed -n '1s/.*"\([0-9a-f-]*\)"$/\1/p'); echo "товар: $ID"
curl -s -o /dev/null -w '%{http_code}\n' --resolve "$D:443:127.0.0.1" "https://$D/product.html?id=$ID"   # 200
curl -s --resolve "$D:443:127.0.0.1" "https://$D/api/products?page_size=1" | grep -o '"sort_order":[0-9-]*' | sed -n 1p
```

Если `/health` через nginx отдаёт 404, значит текущий конфиг nginx не проксирует `/health`. Сайт
от этого не страдает; итоговый конфиг из DOMAIN_MIGRATION.md это исправляет.

Руками, с телефона и компьютера:

- [ ] главная и мобильное меню, магазин (порядок позиций), карточка товара, корзина (до оплаты), `/account`;
- [ ] `/admin/login` → вход → «Товары» (видны и скрытые позиции, есть порядок), «Заказы», «Заявки»,
      «Аналитика» открывается без ошибки;
- [ ] тестовая заявка с главной дошла в Telegram / MAX / почту. Каналы можно проверить и без заявки:
      `cd "$APP" && sudo ./backend/target/release/groutpro-backend notify-test` (по строке на канал:
      «отправлено», «не настроен» или «ОШИБКА — …»). Журнал:
      `sudo journalctl -u "$SERVICE" -n 30 --no-pager | grep -i -E 'telegram|max|smtp|mail'`.

Повторная диагностика: `sudo bash "$APP/deploy/server-check.sh" > ~/server-check-after.txt 2>&1`.

## 9. Правки каталога в БД

Порядок услуг, «цена по запросу» для эпоксидной смолы и «Обмазочная гидроизоляция» без «в два слоя» —
скрипт [sql/content-2026-10.sql](sql/content-2026-10.sql). Названия ищутся по кускам слов, затронутые
строки печатаются. То же самое можно сделать руками в админке.

```bash
cd /
# Копия изменяемых полей товаров
sudo -u postgres psql -X -d "$DB" -c "COPY (SELECT id, sort_order, price, title, description FROM products) TO STDOUT WITH (FORMAT csv, HEADER)" | sudo tee "$BK/products-before-content.csv" > /dev/null
sudo sed -n '$=' "$BK/products-before-content.csv"    # число строк = товаров + 1

# 1) Предпросмотр: ROLLBACK вместо COMMIT — ничего не сохраняется
sed 's/^COMMIT;$/ROLLBACK;/' "$APP/deploy/sql/content-2026-10.sql" | sudo -u postgres psql -X -d "$DB"

# 2) Если таблицы «5. Проверка» и «6. Каталог после правок» верны — применить
sudo -u postgres psql -X -d "$DB" < "$APP/deploy/sql/content-2026-10.sql"
```

- Последняя строка вывода — `COMMIT` (сохранено) или `ROLLBACK` (предпросмотр или ошибка).
- «НЕ НАЙДЕНО» в проверке — позиция называется иначе; порядок задайте в админке, в карточке товара.
  «НЕСКОЛЬКО» — под шаблон подошли две позиции; проверьте их названия в таблице 6.
- Повторный запуск безопасен: ничего не изменится.

Откат только этих правок (вернуть порядок, цены, названия и описания из копии):

```bash
sudo cat "$BK/products-before-content.csv" | sudo -u postgres psql -X -d "$DB" -v ON_ERROR_STOP=1 \
  -c "BEGIN" \
  -c "CREATE TEMP TABLE prev (id uuid, sort_order integer, price bigint, title text, description text)" \
  -c "COPY prev FROM STDIN WITH (FORMAT csv, HEADER)" \
  -c "UPDATE products p SET sort_order = prev.sort_order, price = prev.price, title = prev.title, description = prev.description, updated_at = NOW() FROM prev WHERE p.id = prev.id" \
  -c "COMMIT"
```

## 10. Откат

### 10.1 Код и бинарник (база не меняется)

```bash
sudo systemctl stop "$SERVICE"
cd "$APP" && git checkout -f -B rollback 801c7f2
sudo cp "$BK/groutpro-backend.prev" "$APP/backend/target/release/groutpro-backend"
sudo systemctl start "$SERVICE"
systemctl is-active "$SERVICE"                                                  # active
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:3100/api/products"  # 200
sudo ss -ltnp | grep ':3100'
```

- `git checkout -f -B rollback 801c7f2` возвращает файлы ровно к снимку 801c7f2. `secrets/`, `uploads/`
  и `backend/target/` не трогаются.
- **После отката `git clean` запускать нельзя**: в `.gitignore` снимка нет `secrets/`, и он будет удалён.
- Если старый бинарник не стартует с `migration N was previously applied but is missing`, он собран
  из более старого кода. Соберите снимок: `cd "$APP/backend" && cargo build --release --locked`, затем
  `sudo systemctl start "$SERVICE"`. Код снимка требует в env `SERVER_PORT=3100` (иначе слушает 3000)
  и строки `YOOKASSA_SHOP_ID` / `YOOKASSA_SECRET_KEY` (значения могут быть пустыми).

### 10.2 Переменные окружения

```bash
sudo cp -a "$BK/groutpro.env" "$ENV_FILE" && sudo systemctl restart "$SERVICE"
```

### 10.3 База (только если её действительно испортили)

Выкладка схему не меняет, поэтому обычно этот шаг не нужен. Заказы и заявки, пришедшие после
копии, пропадут.

```bash
sudo systemctl stop "$SERVICE"
cd / && sudo cat "$BK/db-$DB.dump" | sudo -u postgres pg_restore -1 --clean --if-exists -d "$DB"; echo "коды: ${PIPESTATUS[*]}"
sudo systemctl start "$SERVICE"
sudo -u postgres psql -X -d "$DB" -Atc "SELECT max(version) FROM _sqlx_migrations"    # 15
```

Вернуться на новую версию после отката — снова шаги 4.2, 5 и 7.

## 11. Следующие выкладки

Коротко, когда сервер уже на ветке `deploy`:

```bash
# переменные из шага 0, затем:
cd "$APP" && git fetch origin
git log --oneline HEAD.."origin/$BRANCH"               # что придёт
git diff --stat HEAD "origin/$BRANCH" -- backend       # пусто — меняется только статика (11.1)
git diff --stat HEAD "origin/$BRANCH" -- backend/migrations   # не пусто — читайте миграции до выкладки
```

Дальше: копия (шаги 2.2 и 2.4), `git checkout -f -B deploy "origin/$BRANCH"`, сборка (5),
перезапуск и проверки (7, 8). Откат: `git checkout -f -B rollback <прошлый коммит из $BK/git-head.txt>`
плюс бинарник из копии.

### 11.1 Только статика

Если изменились только `frontend/` (и документация), пересобирать и перезапускать backend не нужно:
nginx отдаёт файлы прямо из каталога.

```bash
cd "$APP"
git rev-parse HEAD | sudo tee "/srv/backups/groutpro-next/static-$(date +%F-%H%M).git-head" > /dev/null
git checkout -f -B deploy "origin/$BRANCH"
git status --short                                       # пусто
curl -s -o /dev/null -w '%{http_code}\n' --resolve "$D:443:127.0.0.1" "https://$D/"   # 200
```

Откат: `git checkout -f -B deploy <коммит из сохранённого файла .git-head>`.

Старые копии занимают место: `sudo du -sh /srv/backups/groutpro-next/*`; ненужные удаляйте вручную.
