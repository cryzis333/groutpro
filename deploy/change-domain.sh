#!/usr/bin/env bash
# Переводит статические файлы сайта на новый домен:
# canonical, Open Graph, schema.org, sitemap.xml, robots.txt, текст политики
# конфиденциальности и backend/.env.example.
#
#   bash deploy/change-domain.sh                      # serious-company.ru -> groutpro.ru
#   bash deploy/change-domain.sh --dry-run            # только показать diff, ничего не менять
#   bash deploy/change-domain.sh новый.ru             # serious-company.ru -> новый.ru
#   bash deploy/change-domain.sh новый.ru старый.ru   # любой старый домен -> новый
#
# Можно запускать из любого каталога: скрипт сам находит корень репозитория.
# Повторный запуск ничего не меняет. Заменяется:
#   https://serious-company.ru, http://…, https://www.…, //…  ->  https://<новый домен>
#   serious-company.ru в тексте (без протокола)                ->  <новый домен>
# Поддомены (v.serious-company.ru) и почтовые адреса (…@serious-company.ru)
# не трогаются — если они встретятся, скрипт покажет их в конце.
# Кириллический домен (.рф) в URL записывается в punycode (xn--…), в тексте
# HTML-страниц остаётся кириллицей.
#
# Скрипт меняет только файлы репозитория. Сервер (nginx, SSL, SITE_URL, ЮKassa)
# настраивается по deploy/DOMAIN_MIGRATION.md.
set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "-n" || "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
  shift
fi
if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
fi

NEW_INPUT="${1:-groutpro.ru}"
OLD_INPUT="${2:-serious-company.ru}"

die() { echo "Ошибка: $*" >&2; exit 1; }

# Оставляет только имя хоста: без протокола, пути, порта и точки в конце.
host_only() {
  local d="$1"
  d="${d#http://}"; d="${d#https://}"; d="${d#//}"
  d="${d%%/*}"; d="${d%%:*}"; d="${d%.}"
  printf '%s' "$d"
}

is_ascii() { LC_ALL=C grep -q '^[ -~]*$' <<<"$1"; }

# Кириллический домен -> punycode (нужен python3 или idn2).
to_ascii() {
  local d="$1"
  if is_ascii "$d"; then
    printf '%s' "$d" | tr 'A-Z' 'a-z'
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys; print(sys.argv[1].encode("idna").decode(), end="")' "$d"
  elif command -v idn2 >/dev/null 2>&1; then
    idn2 -- "$d" | tr -d '\n'
  else
    die "для кириллического домена нужен python3 или idn2 (перевод в punycode)"
  fi
}

# Обратное преобразование — для текста на страницах.
to_unicode() {
  local d="$1"
  if [[ "$d" == *xn--* ]] && command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys; print(sys.argv[1].encode().decode("idna"), end="")' "$d"
  else
    printf '%s' "$d"
  fi
}

command -v perl >/dev/null 2>&1 || die "нужен perl (есть в любой Ubuntu/Debian)"

NEW_HOST="$(host_only "$NEW_INPUT")"
OLD_HOST="$(host_only "$OLD_INPUT")"
NEW_ASCII="$(to_ascii "$NEW_HOST")"
OLD_ASCII="$(to_ascii "$OLD_HOST")"
NEW_TEXT="$(to_unicode "$NEW_ASCII")"

[[ "$NEW_ASCII" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] \
  || die "похоже, это не домен: $NEW_INPUT"
[[ "$OLD_ASCII" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] \
  || die "похоже, это не домен: $OLD_INPUT"
if [[ "$NEW_ASCII" == "$OLD_ASCII" ]]; then
  echo "Новый домен совпадает со старым ($NEW_ASCII) — менять нечего."
  exit 0
fi
# Если новый домен содержит старый (old.ru -> www.old.ru), замена не была бы идемпотентной.
if [[ "$NEW_ASCII" == *"$OLD_ASCII"* || "$NEW_TEXT" == *"$OLD_HOST"* ]]; then
  die "новый домен содержит старый ($OLD_ASCII) — такую замену скрипт не делает"
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ -d "$REPO/frontend" && -d "$REPO/backend" ]] || die "не найден корень репозитория рядом со скриптом: $REPO"
cd "$REPO"

FILES=()
for f in frontend/*.html frontend/sitemap.xml frontend/robots.txt backend/.env.example; do
  [[ -f "$f" ]] && FILES+=("$f")
done
[[ ${#FILES[@]} -gt 0 ]] || die "в $REPO нет файлов frontend/*.html"

# Варианты написания старого домена: punycode и, для .рф, кириллица.
OLD_VARIANTS=("$OLD_ASCII")
OLD_UNICODE="$(to_unicode "$OLD_ASCII")"
[[ "$OLD_UNICODE" != "$OLD_ASCII" ]] && OLD_VARIANTS+=("$OLD_UNICODE")
[[ "$OLD_HOST" != "$OLD_ASCII" && "$OLD_HOST" != "$OLD_UNICODE" ]] && OLD_VARIANTS+=("$OLD_HOST")

# $1 — файл. Правила (perl, побайтово; домен экранируется через \Q…\E):
#  1) (https?:)?//(www.)?СТАРЫЙ  -> https://НОВЫЙ  (в URL всегда punycode);
#  2) СТАРЫЙ в тексте, если перед ним нет буквы/цифры/точки/@/-//
#     (то есть не поддомен и не e-mail), а после — нет буквы/цифры/дефиса.
replace_in_file() {
  local file="$1" text_domain="$NEW_ASCII" old
  [[ "$file" == *.html ]] && text_domain="$NEW_TEXT"
  for old in "${OLD_VARIANTS[@]}"; do
    OLD="$old" NEW_URL="$NEW_ASCII" NEW_TEXT="$text_domain" perl -pi -e '
      BEGIN { $o = $ENV{OLD}; $u = $ENV{NEW_URL}; $t = $ENV{NEW_TEXT}; }
      s{(?:https?:)?//(?:www\.)?\Q$o\E(?![\w-])}{https://$u}gi;
      s{(?<![\w.@/-])(?:www\.)?\Q$o\E(?![\w-])}{$t}gi;
    ' "$file"
  done
}

count_old() {
  local file="$1" n=0 old c
  for old in "${OLD_VARIANTS[@]}"; do
    c="$(grep -c -i -F -- "$old" "$file" || true)"
    n=$((n + c))
  done
  echo "$n"
}

echo "Репозиторий: $REPO"
echo "Старый домен: ${OLD_VARIANTS[*]}"
if [[ "$NEW_TEXT" != "$NEW_ASCII" ]]; then
  echo "Новый домен:  $NEW_TEXT (в URL: $NEW_ASCII)"
else
  echo "Новый домен:  $NEW_ASCII"
fi
[[ $DRY_RUN -eq 1 ]] && echo "Режим --dry-run: файлы не меняются, показывается только diff."
echo

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

changed=0
CHANGED_FILES=()
for file in "${FILES[@]}"; do
  before="$(count_old "$file")"
  [[ "$before" -gt 0 ]] || continue
  work="$TMP_DIR/$(printf '%s' "$file" | tr '/' '_')"
  cp -p "$file" "$work"
  replace_in_file "$work"
  if cmp -s "$file" "$work"; then
    continue
  fi
  after="$(count_old "$work")"
  if [[ $DRY_RUN -eq 1 ]]; then
    diff -u --label "a/$file" --label "b/$file" "$file" "$work" || true
  else
    cat "$work" > "$file"   # сохраняет права и владельца исходного файла
  fi
  echo "  $file: строк со старым доменом было $before, осталось $after"
  changed=$((changed + 1))
  CHANGED_FILES+=("$file")
done

echo
if [[ $changed -eq 0 ]]; then
  echo "Изменений нет: старый домен в файлах сайта не найден (замена уже сделана?)."
elif [[ $DRY_RUN -eq 1 ]]; then
  echo "Будет изменено файлов: $changed. Запустите без --dry-run, чтобы применить."
else
  echo "Изменено файлов: $changed."
fi

# Всё, что осталось: поддомены, e-mail, упоминания в JS и т. п.
patterns=()
for old in "${OLD_VARIANTS[@]}"; do patterns+=(-e "$old"); done
leftovers="$(grep -rnIi -F "${patterns[@]}" -- frontend backend/.env.example 2>/dev/null || true)"
if [[ -n "$leftovers" && $DRY_RUN -eq 0 ]]; then
  echo
  echo "ВНИМАНИЕ: старый домен ещё встречается (поддомены и e-mail скрипт не меняет):"
  printf '%s\n' "$leftovers"
fi

[[ $DRY_RUN -eq 1 ]] && exit 0

cat <<EOF

Что сделать дальше (подробно — deploy/DOMAIN_MIGRATION.md):
  1. Проверьте изменения:  git -C "$REPO" diff
     Если меняли текст политики — обновите дату «Редакция от …» в frontend/privacy-policy.html.
  2. Закоммитьте и отправьте в репозиторий, затем выложите на сервер (deploy/DEPLOY.md, раздел
     «Только статика»): меняются только файлы сайта, пересобирать backend не нужно.
  3. Сервер: DNS ${NEW_ASCII} и www.${NEW_ASCII} -> IP сервера, сертификат (этап 1:
     deploy/nginx/groutpro.ru-stage1.conf), итоговый nginx (этап 2: deploy/nginx/groutpro.ru.conf).
  4. SITE_URL=https://${NEW_ASCII} в /etc/groutpro.env (без «/» в конце; secrets/notify.env
     не должен его переопределять), затем: sudo systemctl restart groutpro.service
  5. ЮKassa: HTTP-уведомления на https://${NEW_ASCII}/api/payments/webhook и адрес сайта магазина.
  6. Яндекс Вебмастер и Google Search Console: добавить ${NEW_ASCII} и оформить переезд.
EOF
if [[ $changed -gt 0 ]]; then
  echo "Откат этой замены (только изменённые файлы):"
  echo "  git -C \"$REPO\" checkout -- ${CHANGED_FILES[*]}"
fi
