#!/usr/bin/env bash
# Диагностика сервера ГраутПро. Только читает и печатает — ничего не меняет
# (git запускается без блокировок индекса, от имени владельца репозитория).
# Пароли, токены, ключи и DATABASE_URL не выводятся: у секретов видно только
# «задано/пусто» (у JWT_SECRET — длина), строки журналов и конфигов маскируются.
#
#   sudo bash /srv/apps/groutpro-next/deploy/server-check.sh > ~/server-check.txt 2>&1
#   sed -n '1,200p' ~/server-check.txt
#
# До первой выкладки этого кода скрипта в каталоге проекта ещё нет — возьмите его из git:
#   git -C /srv/apps/groutpro-next fetch origin
#   git -C /srv/apps/groutpro-next show origin/<ветка>:deploy/server-check.sh > ~/server-check.sh
#   sudo bash ~/server-check.sh > ~/server-check.txt 2>&1
#
# Без sudo часть проверок (env-файлы, nginx -t, certbot, процессы в ss) пропускается.
# Пути и имена можно переопределить переменными окружения:
#   APP=/srv/apps/groutpro-next SERVICE=groutpro.service ENV_FILE=/etc/groutpro.env
#   PORT=3100 OLD_DOMAIN=serious-company.ru NEW_DOMAIN=groutpro.ru SNAPSHOT=801c7f2
set -uo pipefail
export LC_ALL=C.UTF-8 2>/dev/null || true

APP="${APP:-/srv/apps/groutpro-next}"
SERVICE="${SERVICE:-groutpro.service}"
ENV_FILE="${ENV_FILE:-/etc/groutpro.env}"
NOTIFY_FILE="${NOTIFY_FILE:-$APP/secrets/notify.env}"
PORT="${PORT:-3100}"
OLD_DOMAIN="${OLD_DOMAIN:-serious-company.ru}"
NEW_DOMAIN="${NEW_DOMAIN:-groutpro.ru}"
BACKUP_ROOT="${BACKUP_ROOT:-/srv/backups/groutpro-next}"
EXPECTED_MIGRATIONS="${EXPECTED_MIGRATIONS:-15}"
# Снимок кода, который работал на сервере до выкладки исправлений.
SNAPSHOT="${SNAPSHOT:-801c7f2}"

IS_ROOT=0
[[ "$(id -u)" -eq 0 ]] && IS_ROOT=1

section() { printf '\n===== %s =====\n' "$1"; }
note() { printf '  -> %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
# Первые / последние N строк — через sed и awk: на сервере нет привычной утилиты для этого.
first_lines() { sed -n "1,${1}p"; }
last_lines() { awk -v n="$1" '{ buf[NR % n] = $0 } END { s = NR - n + 1; if (s < 1) s = 1; for (i = s; i <= NR; i++) print buf[i % n] }'; }

# Маскирует секреты в произвольном тексте:
#  KEY=значение / KEY: значение, если в имени есть SECRET/PASSWORD/TOKEN/KEY/HASH/…;
#  пароль и логин в URL (postgres://user:pass@…, https://token@github.com);
#  токены Telegram-ботов, bcrypt-хэши, JWT, Bearer-токены, ключи ЮKassa.
mask() {
  sed -E \
    -e 's#([A-Za-z0-9_]*(SECRET|PASSWORD|PASSWD|PASS|TOKEN|KEY|HASH|DATABASE_URL|DSN|CREDENTIAL|PRIVATE|AUTH)[A-Za-z0-9_]*["'"'"']?[[:space:]]*[=:][[:space:]]*)("[^"]*"|'"'"'[^'"'"']*'"'"'|[^[:space:]"'"'"'][^"'"'"']*)#\1<скрыто>#Ig' \
    -e 's#([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@[:space:]:]+:[^/@[:space:]]*@#\1<скрыто>@#g' \
    -e 's#([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@[:space:]:]+@#\1<скрыто>@#g' \
    -e 's#[0-9]{6,12}:[A-Za-z0-9_-]{30,}#<скрыто>#g' \
    -e 's#\$2[abxy]?\$[0-9]{2}\$[./A-Za-z0-9]{53}#<скрыто>#g' \
    -e 's#eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}#<скрыто>#g' \
    -e 's#(Bearer|Basic)[[:space:]]+[A-Za-z0-9._~+/=-]{8,}#\1 <скрыто>#Ig' \
    -e 's#(live|test)_[A-Za-z0-9_-]{20,}#<скрыто>#g'
}

# Печатает команду и её вывод (не больше MAX строк), всё через mask.
run() {
  local max="${MAX:-60}"
  printf '$ %s\n' "$*" | mask
  "$@" 2>&1 | first_lines "$max" | mask
}

# Чтение файла KEY=value без вывода значений. Несекретные ключи показываются как есть.
env_value() { # $1 — файл, $2 — ключ; печатает значение без кавычек (для внутренних проверок)
  [[ -r "$1" ]] || return 0
  awk -v k="$2" -v q="'" '
    { sub(/\r$/, "") }
    /^[[:space:]]*#/ { next }
    {
      line = $0; sub(/^[[:space:]]*(export[[:space:]]+)?/, "", line)
      eq = index(line, "="); if (eq == 0) next
      key = substr(line, 1, eq - 1); gsub(/[[:space:]]+$/, "", key)
      if (key != k) next
      val = substr(line, eq + 1); gsub(/^[[:space:]]+|[[:space:]]+$/, "", val)
      first = substr(val, 1, 1); last = substr(val, length(val), 1)
      if (length(val) >= 2 && first == last && (first == "\"" || first == q)) val = substr(val, 2, length(val) - 2)
      found = val
    }
    END { if (found != "") printf "%s", found }
  ' "$1"
}

env_keys() { # ключи файла по порядку
  [[ -r "$1" ]] || return 0
  sed -n -E 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*/\2/p' "$1"
}

db_part() { # $1 — DATABASE_URL, $2 — name|host|port|user; без пароля
  local url="${1#*://}" auth="" hostpart path
  if [[ "$url" == *@* ]]; then auth="${url%@*}"; url="${url##*@}"; fi
  hostpart="${url%%/*}"; path="${url#*/}"; [[ "$path" == "$url" ]] && path=""
  case "$2" in
    name) path="${path%%\?*}"; printf '%s' "$path" ;;
    host) local h="${hostpart%%:*}"; printf '%s' "${h:-localhost}" ;;
    port) [[ "$hostpart" == *:* ]] && printf '%s' "${hostpart##*:}" || printf '5432' ;;
    user) printf '%s' "${auth%%:*}" ;;
    pass) [[ "$auth" == *:* ]] && printf '%s' "${auth#*:}" ;;
  esac
}

urldecode() { local s="${1//+/ }"; printf '%b' "${s//%/\\x}"; }

show_env_file() {
  local file="$1" key value
  if [[ ! -e "$file" ]]; then echo "  файла нет: $file"; return; fi
  if [[ ! -r "$file" ]]; then echo "  нет прав на чтение (запустите через sudo): $file"; return; fi
  printf '  %s (%s)\n' "$file" "$(stat -c '%U:%G %a' "$file" 2>/dev/null)"
  while IFS= read -r key; do
    value="$(env_value "$file" "$key")"
    case "$key" in
      SITE_URL|SERVER_HOST|SERVER_PORT|UPLOAD_DIR|SMTP_HOST|SMTP_PORT|ADMIN_USERNAME|TELEGRAM_API_BASE|MAX_API_BASE|STATS_OBJECTS_BASE|NOTIFY_ENV_FILE|RUST_LOG)
        printf '    %s=%s\n' "$key" "$value" | mask ;;
      DATABASE_URL)
        if [[ -n "$value" ]]; then
          printf '    %s=<задано; БД: %s, хост: %s:%s>\n' "$key" "$(db_part "$value" name)" "$(db_part "$value" host)" "$(db_part "$value" port)"
        else
          printf '    %s=<пусто>\n' "$key"
        fi ;;
      JWT_SECRET)
        printf '    %s=<%s, длина %s>\n' "$key" "$([[ -n "$value" ]] && echo задано || echo ПУСТО)" "${#value}"
        [[ ${#value} -lt 32 ]] && note "JWT_SECRET короче 32 символов — замените на длинный случайный (openssl rand -hex 32)" ;;
      *)
        if [[ -n "$value" ]]; then printf '    %s=<задано>\n' "$key"; else printf '    %s=<пусто>\n' "$key"; fi ;;
    esac
  done < <(env_keys "$file")
}

# Эффективное значение ключа: secrets/notify.env > /etc/groutpro.env > .env в каталоге проекта.
effective() {
  local v
  v="$(env_value "$NOTIFY_FILE" "$1")"; [[ -n "$v" ]] && { printf '%s' "$v"; return; }
  v="$(env_value "$ENV_FILE" "$1")"; [[ -n "$v" ]] && { printf '%s' "$v"; return; }
  env_value "$APP/.env" "$1"
}

repo_owner() { stat -c '%U' "$APP/.git" 2>/dev/null || echo "$(id -un)"; }
as_owner() { # запуск от владельца репозитория, чтобы root не создавал файлов в .git
  local owner; owner="$(repo_owner)"
  if [[ $IS_ROOT -eq 1 && "$owner" != "root" ]] && have runuser; then
    runuser -u "$owner" -- "$@"
  else
    "$@"
  fi
}
git_ro() { as_owner env GIT_OPTIONAL_LOCKS=0 git -c safe.directory="$APP" -C "$APP" "$@"; }

sha384_of() {
  if have sha384sum; then sha384sum "$1" | awk '{print $1}'
  elif have openssl; then openssl dgst -sha384 -r "$1" | awk '{print $1}'
  fi
}

# psql без вывода DATABASE_URL: под root — локально от postgres (peer), иначе через PG*-переменные.
DB_URL=""; DB_NAME=""
psql_q() {
  if [[ -z "$DB_NAME" ]]; then echo "  (БД неизвестна)"; return 1; fi
  if [[ $IS_ROOT -eq 1 ]] && id postgres >/dev/null 2>&1 && have runuser; then
    (cd / && runuser -u postgres -- psql -X -q -w -p "$(db_part "$DB_URL" port)" -d "$(urldecode "$DB_NAME")" -At -F ' | ' -c "$1")
  else
    PGHOST="$(db_part "$DB_URL" host)" PGPORT="$(db_part "$DB_URL" port)" \
    PGUSER="$(urldecode "$(db_part "$DB_URL" user)")" PGPASSWORD="$(urldecode "$(db_part "$DB_URL" pass)")" \
    PGDATABASE="$(urldecode "$DB_NAME")" psql -X -q -w -At -F ' | ' -c "$1"
  fi
}

echo "Отчёт ГраутПро: $(date '+%F %T %Z'), хост $(hostname 2>/dev/null), пользователь $(id -un)"
[[ $IS_ROOT -eq 1 ]] || echo "ВНИМАНИЕ: запущено без sudo — часть проверок будет пропущена."

section "Система и диск"
[[ -r /etc/os-release ]] && sed -n -E 's/^PRETTY_NAME="?([^"]*)"?/\1/p' /etc/os-release
run uptime
run df -h / /srv
run free -h
if [[ -d "$APP" ]]; then
  for d in "$APP/backend/target" "$APP/uploads" "$BACKUP_ROOT"; do
    [[ -d "$d" ]] && du -sh "$d" 2>/dev/null
  done
fi
for tool in git psql pg_dump curl nginx certbot dig whois openssl sha384sum; do
  if have "$tool"; then printf '  %-10s есть\n' "$tool"; else printf '  %-10s НЕТ\n' "$tool"; fi
done

section "Проект: $APP"
if [[ ! -d "$APP" ]]; then
  echo "  каталога нет — проверьте APP=…"
else
  run ls -la "$APP"
  run stat -c '%U:%G %a %n' "$APP" "$APP/.git" "$APP/backend" "$APP/backend/target" "$APP/uploads" "$APP/secrets"
fi

section "Git"
if [[ -d "$APP/.git" ]] && have git; then
  echo "  владелец репозитория: $(repo_owner)"
  MAX=10 run git_ro log --oneline --decorate -5
  MAX=40 run git_ro status --short --branch --untracked-files=normal
  git_ro remote -v 2>&1 | mask
  dirty="$(git_ro status --porcelain --untracked-files=no 2>/dev/null | wc -l)"
  if [[ "$dirty" -eq 0 ]]; then
    note "изменённых отслеживаемых файлов нет: рабочая копия = HEAD ($(git_ro rev-parse --short HEAD 2>/dev/null))"
  else
    note "изменённых отслеживаемых файлов: $dirty (до первой выкладки так и должно быть — это снимок $SNAPSHOT)"
  fi
  # Сравнение рабочей копии со снимком через временный индекс: настоящий индекс не трогается.
  if git_ro cat-file -e "$SNAPSHOT^{commit}" 2>/dev/null; then
    tmp_index="$(as_owner mktemp 2>/dev/null)"
    if [[ -n "$tmp_index" ]]; then
      as_owner env GIT_INDEX_FILE="$tmp_index" git -c safe.directory="$APP" -C "$APP" read-tree "$SNAPSHOT" 2>/dev/null
      as_owner env GIT_INDEX_FILE="$tmp_index" git -c safe.directory="$APP" -C "$APP" update-index -q --refresh >/dev/null 2>&1
      diffstat="$(as_owner env GIT_INDEX_FILE="$tmp_index" git -c safe.directory="$APP" -C "$APP" diff --stat 2>/dev/null | last_lines 15)"
      rm -f "$tmp_index"
      if [[ -z "$diffstat" ]]; then
        note "рабочая копия совпадает со снимком $SNAPSHOT (по файлам, которые в нём есть) — правок после снимка нет"
      else
        echo "  отличия рабочей копии от снимка $SNAPSHOT (после выкладки новой версии они ожидаемы):"
        printf '%s\n' "$diffstat"
      fi
    fi
    # Файлы миграций на диске против снимка (по хэшам git, отслеживаемые и нет).
    mig_bad=""
    while read -r _mode _type blob path; do
      [[ -n "${path:-}" ]] || continue
      if [[ ! -f "$APP/$path" ]]; then
        mig_bad+=" ${path##*/}(нет)"
      elif [[ "$(git_ro hash-object -- "$path" 2>/dev/null)" != "$blob" ]]; then
        mig_bad+=" ${path##*/}(изменён)"
      fi
    done < <(git_ro ls-tree "$SNAPSHOT" backend/migrations/ 2>/dev/null)
    for f in "$APP"/backend/migrations/*.sql; do
      [[ -e "$f" ]] || continue
      git_ro cat-file -e "$SNAPSHOT:backend/migrations/${f##*/}" 2>/dev/null || mig_bad+=" ${f##*/}(новый)"
    done
    if [[ -z "$mig_bad" ]]; then
      note "backend/migrations на диске совпадает со снимком $SNAPSHOT"
    else
      note "ВНИМАНИЕ: backend/migrations отличается от снимка $SNAPSHOT:$mig_bad — сверьте с _sqlx_migrations ниже"
    fi
  else
    note "коммита $SNAPSHOT в локальном репозитории нет (его скачает git fetch origin)"
  fi
else
  echo "  $APP/.git не найден"
fi

section "Rust у владельца репозитория (для cargo build)"
if [[ -d "$APP" ]]; then
  # Login-shell: rustup добавляет ~/.cargo/bin в PATH через ~/.profile.
  as_owner bash -lc 'if command -v cargo >/dev/null 2>&1; then cargo --version; rustc --version; else echo "cargo не найден (rustup ставит его в ~/.cargo/bin)"; fi' 2>&1 \
    | first_lines 5 | sed 's/^/  /'
fi

section "Переменные окружения (значения секретов скрыты)"
show_env_file "$ENV_FILE"
show_env_file "$NOTIFY_FILE"
for f in "$APP/.env" "$APP/backend/.env"; do [[ -e "$f" ]] && show_env_file "$f"; done
if [[ -r "$NOTIFY_FILE" && -r "$ENV_FILE" ]]; then
  overrides=""
  while IFS= read -r key; do
    [[ -n "$(env_value "$ENV_FILE" "$key")" ]] && overrides+=" $key"
  done < <(env_keys "$NOTIFY_FILE")
  [[ -n "$overrides" ]] && note "secrets/notify.env переопределяет ключи из $ENV_FILE:$overrides"
  for key in SITE_URL DATABASE_URL JWT_SECRET ADMIN_PASSWORD_HASH; do
    [[ -n "$(env_value "$NOTIFY_FILE" "$key")" ]] && note "ВНИМАНИЕ: $key задан в secrets/notify.env — он важнее $ENV_FILE"
  done
fi
site_url="$(effective SITE_URL)"
echo "  итоговый SITE_URL: ${site_url:-<не задан>}"
[[ "$site_url" == */ ]] && note "SITE_URL заканчивается на «/» — уберите его"
server_host="$(effective SERVER_HOST)"
[[ -n "$server_host" && "$server_host" != "127.0.0.1" && "$server_host" != "localhost" ]] \
  && note "SERVER_HOST=$server_host — backend будет доступен не только nginx; уберите строку (по умолчанию 127.0.0.1)"
server_port="$(effective SERVER_PORT)"
[[ -n "$server_port" && "$server_port" != "$PORT" ]] && note "SERVER_PORT=$server_port, а nginx ждёт $PORT"
if [[ -z "$(effective YOOKASSA_SHOP_ID)" || -z "$(effective YOOKASSA_SECRET_KEY)" ]]; then
  note "ЮKassa не настроена — онлайн-оплата выключена (счета и заявки работают)"
fi

section "База данных (_sqlx_migrations)"
DB_URL="$(effective DATABASE_URL)"
if [[ -n "$DB_URL" ]]; then
  DB_NAME="$(db_part "$DB_URL" name)"
  echo "  БД: $DB_NAME, хост: $(db_part "$DB_URL" host):$(db_part "$DB_URL" port)"
else
  echo "  DATABASE_URL не прочитан (нужен sudo или файл $ENV_FILE)"
fi
if have psql && [[ -n "$DB_NAME" ]]; then
  psql_q "SELECT 'PostgreSQL ' || current_setting('server_version') || ', ctype ' || datctype FROM pg_database WHERE datname = current_database()" 2>&1 | mask
  echo "  версия | успешно | описание | применена"
  psql_q "SELECT version, success, left(description, 40), installed_on::date FROM _sqlx_migrations ORDER BY version" 2>&1 | mask
  summary="$(psql_q "SELECT count(*) || ' ' || coalesce(max(version), 0) || ' ' || CASE WHEN coalesce(bool_and(success), true) THEN 'да' ELSE 'нет' END FROM _sqlx_migrations" 2>/dev/null)"
  read -r m_count m_max m_ok <<<"$summary"
  if [[ -n "${m_max:-}" ]]; then
    if [[ "$m_max" -gt "$EXPECTED_MIGRATIONS" ]]; then
      note "СТОП: в БД есть миграции новее $EXPECTED_MIGRATIONS — этот код с ней не запустится"
    elif [[ "$m_count" -eq "$EXPECTED_MIGRATIONS" && "$m_ok" == "да" ]]; then
      note "миграции 1..$EXPECTED_MIGRATIONS применены — так и должно быть"
    else
      note "применено $m_count, последняя $m_max, все успешны: $m_ok (ожидается $EXPECTED_MIGRATIONS, да)"
    fi
  fi
  # Контрольные суммы: sqlx хранит SHA-384 файла миграции; при расхождении новый бинарник не стартует.
  if [[ -d "$APP/backend/migrations" ]] && { have sha384sum || have openssl; }; then
    mismatches=0; checked=0
    while IFS=' |' read -r version checksum; do
      [[ -n "$version" ]] || continue
      checked=$((checked + 1))
      file="$(ls "$APP/backend/migrations/" 2>/dev/null | grep -E "^0*${version}_.*\.sql$" | first_lines 1)"
      if [[ -z "$file" ]]; then
        note "миграции $version нет в $APP/backend/migrations"; mismatches=$((mismatches + 1)); continue
      fi
      if [[ "$(sha384_of "$APP/backend/migrations/$file")" != "$checksum" ]]; then
        note "контрольная сумма $file не совпадает с применённой в БД"; mismatches=$((mismatches + 1))
      fi
    done < <(psql_q "SELECT version, encode(checksum, 'hex') FROM _sqlx_migrations ORDER BY version" 2>/dev/null)
    if [[ $checked -eq 0 ]]; then
      note "контрольные суммы не проверены: _sqlx_migrations не прочитана"
    elif [[ $mismatches -eq 0 ]]; then
      note "все $checked применённых миграций совпадают с файлами в $APP/backend/migrations"
    fi
  fi
  echo "  товары (не в архиве) | опубликовано | цена «по запросу» | заказы | заявки"
  psql_q "SELECT (SELECT count(*) FROM products WHERE archived_at IS NULL), (SELECT count(*) FROM products WHERE archived_at IS NULL AND is_published), (SELECT count(*) FROM products WHERE archived_at IS NULL AND price = 0), (SELECT count(*) FROM orders), (SELECT count(*) FROM contact_requests)" 2>&1 | mask
fi

section "Сервис $SERVICE"
if have systemctl; then
  run systemctl show "$SERVICE" -p ActiveState -p SubState -p MainPID -p ExecMainStartTimestamp -p NRestarts -p User -p WorkingDirectory -p EnvironmentFiles
  MAX=40 run systemctl cat "$SERVICE"
  bin="$(systemctl show "$SERVICE" -p ExecStart --value 2>/dev/null | sed -n -E 's/.*path=([^ ;]+).*/\1/p' | first_lines 1)"
  bin="${bin:-$APP/backend/target/release/groutpro-backend}"
  if [[ -e "$bin" ]]; then
    run ls -l --time-style='+%F %T' "$bin"
    started="$(systemctl show "$SERVICE" -p ExecMainStartTimestamp --value 2>/dev/null)"
    if [[ -n "$started" && "$started" != "n/a" ]]; then
      start_epoch="$(date -d "$started" +%s 2>/dev/null)"
      bin_epoch="$(stat -c %Y "$bin" 2>/dev/null)"
      if [[ -n "$start_epoch" && -n "$bin_epoch" && "$bin_epoch" -gt "$start_epoch" ]]; then
        note "бинарник новее запуска сервиса — после сборки не было перезапуска"
      fi
    fi
  fi
  pid="$(systemctl show "$SERVICE" -p MainPID --value 2>/dev/null)"
  if [[ -n "$pid" && "$pid" != "0" && -e "/proc/$pid/exe" ]]; then
    exe="$(readlink "/proc/$pid/exe" 2>/dev/null)"
    echo "  запущен файл: ${exe:-<нет доступа>}"
    [[ "$exe" == *"(deleted)"* ]] && note "работает удалённый/заменённый бинарник — нужен перезапуск"
  fi
  echo "  последние строки журнала:"
  journalctl -u "$SERVICE" -n 25 --no-pager 2>&1 | mask
fi

section "Порты"
if have ss; then
  ss -ltnp 2>/dev/null | awk -v p="$PORT" 'NR == 1 || $4 ~ (":(" p "|80|443|5432)$")' | mask
  listen3100="$(ss -ltn 2>/dev/null | awk -v p="$PORT" '$4 ~ (":" p "$") { print $4 }')"
  if [[ -z "$listen3100" ]]; then
    note "порт $PORT никто не слушает — backend не запущен?"
  elif grep -q -v -E '^127\.0\.0\.1:|^\[::1\]:' <<<"$listen3100"; then
    note "ВНИМАНИЕ: backend слушает $listen3100 — должен только 127.0.0.1:$PORT"
  else
    note "backend слушает только 127.0.0.1:$PORT — правильно"
  fi
else
  echo "  ss не найден"
fi

section "nginx"
if have nginx; then
  run nginx -v
  [[ $IS_ROOT -eq 1 ]] && run nginx -t
  run ls -l /etc/nginx/sites-enabled/ /etc/nginx/conf.d/
  grep -q -E '^[[:space:]]*include[[:space:]]+/etc/nginx/conf\.d/\*\.conf' /etc/nginx/nginx.conf 2>/dev/null \
    && note "conf.d/*.conf подключается в nginx.conf" || note "в nginx.conf нет include /etc/nginx/conf.d/*.conf"
  echo "  server_name во включённых сайтах:"
  grep -rn -E '^[[:space:]]*server_name' /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null | sed 's/^/    /'
  echo "  имена upstream / limit_req_zone / map (не должны совпадать между сайтами):"
  grep -rn -h -E '^[[:space:]]*(upstream|limit_req_zone|map)[[:space:]]' /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null | sed 's/^/    /'
  enabled="$(readlink -f /etc/nginx/sites-enabled/groutpro 2>/dev/null)"
  echo "  sites-enabled/groutpro -> ${enabled:-<нет>}"
  for f in /etc/nginx/sites-available/groutpro /etc/nginx/sites-available/groutprov \
           /etc/nginx/sites-available/groutpro-acme /etc/nginx/conf.d/groutpro-ratelimit.conf; do
    if [[ -r "$f" ]]; then
      echo "  ----- $f"
      sed -n '1,200p' "$f" | mask | sed 's/^/    /'
    elif [[ -e "$f" ]]; then
      echo "  ----- $f: нет прав на чтение"
    fi
  done
  for f in /etc/letsencrypt/options-ssl-nginx.conf /etc/letsencrypt/ssl-dhparams.pem /var/www/html; do
    [[ -e "$f" ]] && echo "  есть: $f" || echo "  НЕТ:  $f"
  done
  # limit_req считает запросы по IP клиента. Если роутер подменяет адрес (SNAT),
  # все посетители придут с одного локального IP и будут делить один лимит.
  if [[ -r /var/log/nginx/access.log ]]; then
    awk '{ print $1 }' /var/log/nginx/access.log | sort -u | awk '
      /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|::1$|fe80:|f[cd])/ { local_n++; next }
      { public_n++ }
      END {
        printf "  разных IP клиентов в access.log: внешних %d, локальных %d\n", public_n, local_n
        if (public_n == 0 && local_n > 0)
          print "  -> ВНИМАНИЕ: внешних адресов нет — роутер подменяет IP; лимиты limit_req будут общими на всех"
      }'
  fi
else
  echo "  nginx не найден"
fi

section "Сертификаты"
if have certbot && [[ $IS_ROOT -eq 1 ]]; then
  MAX=40 run certbot certificates
  grep -H -E '^(authenticator|installer|webroot_path|renew_hook)' /etc/letsencrypt/renewal/*.conf 2>/dev/null | sed 's/^/  /'
  systemctl list-timers --all 2>/dev/null | grep -i certbot | sed 's/^/  /'
else
  echo "  certbot не установлен или нет sudo"
fi

section "DNS"
for d in "$NEW_DOMAIN" "www.$NEW_DOMAIN" "$OLD_DOMAIN"; do
  if have dig; then
    printf '  %-24s A: %s  AAAA: %s\n' "$d" "$(dig +short A "$d" @8.8.8.8 2>/dev/null | tr '\n' ' ')" "$(dig +short AAAA "$d" @8.8.8.8 2>/dev/null | tr '\n' ' ')"
  else
    printf '  %-24s %s\n' "$d" "$(getent ahosts "$d" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')"
  fi
done
if have dig; then
  echo "  NS $NEW_DOMAIN: $(dig +short NS "$NEW_DOMAIN" @8.8.8.8 2>/dev/null | tr '\n' ' ')"
  echo "  MX $NEW_DOMAIN: $(dig +short MX "$NEW_DOMAIN" @8.8.8.8 2>/dev/null | tr '\n' ' ')"
  echo "  CAA $NEW_DOMAIN: $(dig +short CAA "$NEW_DOMAIN" @8.8.8.8 2>/dev/null | tr '\n' ' ')"
fi
# Статус домена в реестре .ru: нужны DELEGATED (DNS работает) и VERIFIED (администратор подтверждён).
if have whois; then
  echo "  whois $NEW_DOMAIN: $(whois "$NEW_DOMAIN" 2>/dev/null | sed -n -E 's/^state:[[:space:]]*//p' | first_lines 1)"
fi

# Код ответа и адрес редиректа одной строкой; ошибки curl (сертификат, таймаут) — туда же.
curl_status() {
  curl -sS -m 8 -o /dev/null -w '%{http_code} %{redirect_url}' --resolve "$2" "$1" 2>&1 | tr '\n' ' ' | mask
}

section "Проверка HTTP с самого сервера (через nginx на 127.0.0.1, без DNS и роутера)"
if have curl; then
  printf '  backend /health: '; curl -sS -m 5 "http://127.0.0.1:$PORT/health" 2>&1 | first_lines 1; echo
  printf '  backend /api/products: '; curl -sS -m 5 -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$PORT/api/products?page_size=1" 2>&1
  for d in "$OLD_DOMAIN" "$NEW_DOMAIN" "www.$NEW_DOMAIN"; do
    for path in / /shop /admin /admin/login /health "/api/products?page_size=1"; do
      printf '  https://%s%s -> %s\n' "$d" "$path" "$(curl_status "https://$d$path" "$d:443:127.0.0.1")"
    done
    printf '  http://%s/ -> %s\n' "$d" "$(curl_status "http://$d/" "$d:80:127.0.0.1")"
  done
  # Неизвестное событие backend отбрасывает ответом {"status":"ignored"}, ничего не меняя.
  printf '  POST https://%s/api/payments/webhook -> %s\n' "$OLD_DOMAIN" \
    "$(curl -sS -m 8 --resolve "$OLD_DOMAIN:443:127.0.0.1" -X POST -H 'Content-Type: application/json' \
         -d '{"event":"server-check"}' "https://$OLD_DOMAIN/api/payments/webhook" 2>&1 | first_lines 1 | mask)"
fi

section "Резервные копии"
if [[ -d "$BACKUP_ROOT" ]]; then
  ls -la "$BACKUP_ROOT" 2>&1 | last_lines 10
else
  echo "  каталога $BACKUP_ROOT нет"
fi

echo
echo "Готово. Секреты в отчёте скрыты; перед отправкой всё же просмотрите его."
