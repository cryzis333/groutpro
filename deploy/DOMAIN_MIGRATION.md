# Переезд сайта на groutpro.ru

Сервер остаётся тем же: внешний IP `213.217.2.152`, домашний роутер, nginx, `groutpro.service`.
Меняется адрес сайта: `serious-company.ru` → `groutpro.ru`.

Старый домен не отключается:

- он отвечает 301-редиректом на тот же путь на `groutpro.ru`;
- принимает уведомления ЮKassa, пока в её кабинете не сменят адрес;
- продлевает свой сертификат.

Держите его так 6–12 месяцев и не забывайте продлевать регистрацию домена.

Другие сайты сервера (`groutprov`, `orders`, `ckan52`, `kay-coop`) этот переезд не затрагивает.

Перед началом код с каталогом `deploy/` должен быть выложен по [DEPLOY.md](DEPLOY.md): команды ниже
берут файлы из `$APP/deploy/`. Нужных утилит может не быть: `dig` ставится пакетом `bind9-dnsutils`,
`whois` — пакетом `whois`. Их можно запускать и со своего компьютера.

## Кто что делает

| # | Шаг | Кто | Когда |
|---|---|---|---|
| 1 | Подтверждение личности администратора домена через Госуслуги (ЕСИА) в reg.ru | **Дмитрий (заказчик), только он** | **срочно, сейчас** |
| 2 | Подготовка сервера: копии, зоны лимитов nginx | вы | в любой момент, сайт не затрагивает |
| 3 | DNS groutpro.ru в reg.ru: A-записи на сервер, удалить AAAA | Дмитрий или вы с его доступом к reg.ru | после шага 1 |
| 4 | nginx этап 1 и сертификат | вы | когда DNS указывает на сервер |
| 5 | nginx этап 2 — итоговый конфиг | вы | сразу после сертификата |
| 6 | `SITE_URL` и перезапуск backend | вы | сразу после этапа 2 |
| 7 | Новый домен в файлах сайта (`change-domain.sh`) | вы | сразу после этапа 2 |
| 8 | ЮKassa: адрес уведомлений и адрес сайта магазина | Дмитрий (или вы с доступом к кабинету) | после шагов 5–7 |
| 9 | Яндекс Вебмастер, Google Search Console | у кого доступ к аккаунтам | после шагов 5–7 |
| 10 | Отказ от хостинга reg.ru u3600055 (Host-0) | Дмитрий | только после проверки почты и NS (раздел 10) |

Шаги 4–7 занимают около получаса. Сайт работает всё время: до этапа 2 — на старом домене, после — на новом.

## 1. ЕСИА — срочно, делает только заказчик

Регистратор требует подтвердить личность администратора домена через Госуслуги (ЕСИА). Пока это
не сделано, домен могут не делегировать или снять с делегирования. Тогда никакие DNS-записи
не работают, и переезд невозможен. Сделать это может только сам администратор домена — Дмитрий,
со своей учётной записью Госуслуг:

1. Войти в личный кабинет reg.ru → «Домены» → `groutpro.ru`.
2. Нажать «Подтвердить через Госуслуги» (или баннер о подтверждении данных администратора) и
   разрешить доступ в ЕСИА.

Проверка (с любого компьютера, где есть `whois`, или на https://whois.tcinet.ru):

```bash
whois groutpro.ru | grep -i -E '^(state|nserver|paid-till)'
```

В строке `state` должны быть `DELEGATED` и `VERIFIED`. `NOT DELEGATED` или `UNVERIFIED` означают, что
нужно дождаться подтверждения, а если не помогает — писать в поддержку reg.ru. Заодно проверьте
`paid-till`: срок регистрации не должен скоро закончиться.

## 2. Подготовка сервера (до DNS; сайт не затрагивает)

```bash
APP=/srv/apps/groutpro-next
BK=/srv/backups/groutpro-next/domain-$(date +%F-%H%M)
R='--resolve groutpro.ru:443:127.0.0.1 --resolve www.groutpro.ru:443:127.0.0.1 --resolve serious-company.ru:443:127.0.0.1 --resolve groutpro.ru:80:127.0.0.1 --resolve www.groutpro.ru:80:127.0.0.1 --resolve serious-company.ru:80:127.0.0.1'
```

`$R` направляет curl на сам сервер. С сервера и из домашней сети внешний IP часто не открывается:
роутер не умеет «петлю» (hairpin NAT), поэтому проверки делаются через `--resolve`.

Резервные копии:

```bash
sudo install -d -m 700 "$BK"
sudo cp -a /etc/nginx/sites-available/groutpro "$BK/nginx-groutpro"
sudo cp -a /etc/groutpro.env "$BK/groutpro.env"
sudo nginx -T 2>/dev/null | sudo tee "$BK/nginx-T.txt" > /dev/null      # вся текущая конфигурация nginx
sudo tar -C /etc -czf "$BK/letsencrypt.tar.gz" letsencrypt
sudo ls -la "$BK"
```

Что есть сейчас:

```bash
nginx -v                                                      # 1.28.x — подходит «http2 on;»
ls -l /etc/nginx/sites-enabled/                               # groutpro -> ../sites-available/groutpro
grep -n 'conf.d' /etc/nginx/nginx.conf                        # include /etc/nginx/conf.d/*.conf; внутри http{}
grep -n -E 'listen|server_name|ssl_certificate ' /etc/nginx/sites-available/groutpro
sudo certbot certificates                                     # имена и пути сертификатов
sudo grep -E '^(authenticator|webroot_path|renew_hook)' /etc/letsencrypt/renewal/*.conf
ls -ld /var/www/html /etc/letsencrypt/options-ssl-nginx.conf /etc/letsencrypt/ssl-dhparams.pem
```

Запомните:

- **каталог сертификата serious-company.ru** — `Certificate Path` в `certbot certificates`, например
  `/etc/letsencrypt/live/serious-company.ru/` или `…/serious-company.ru-0001/`;
- **есть ли в текущем файле `listen [::]:…`** — если есть, в итоговом конфиге их нужно раскомментировать;
- **есть ли `options-ssl-nginx.conf` и `ssl-dhparams.pem`** — если нет, в итоговом конфиге эти две строки
  заменяются на `ssl_protocols TLSv1.2 TLSv1.3;`.

IP клиентов для лимитов: `sudo bash "$APP/deploy/server-check.sh" | grep 'IP клиентов'`. Если внешних
адресов 0, роутер подменяет IP, и лимиты станут общими для всех. В этом случае в
`groutpro-ratelimit.conf` увеличьте `rate` в 5–10 раз.

Зоны лимитов запросов. Файл только объявляет зоны, ничего не ограничивает и безопасен для
остальных сайтов:

```bash
sudo cp "$APP/deploy/nginx/groutpro-ratelimit.conf" /etc/nginx/conf.d/groutpro-ratelimit.conf
sudo nginx -t && sudo systemctl reload nginx
sudo nginx -T 2>/dev/null | grep -c 'zone=groutpro_'          # 4
```

## 3. DNS groutpro.ru в reg.ru

### 3.1 Где редактировать зону

```bash
dig +short NS groutpro.ru @8.8.8.8
```

| NS | Где правка | Примечание |
|---|---|---|
| `ns1.hosting.reg.ru`, `ns2.hosting.reg.ru` | панель хостинга **u3600055** (ISPmanager): «Доменные имена» → `groutpro.ru` → записи | зона живёт на хостинге — см. раздел 10 перед отказом от него |
| `ns1.reg.ru`, `ns2.reg.ru` | личный кабинет reg.ru → «Домены» → `groutpro.ru` → «DNS-серверы и управление зоной» | правка в «Управлении зоной» |

Редактор зоны в кабинете reg.ru на хостинговых NS **не действует**: правьте там, куда указывают NS.

### 3.2 Копия текущих записей

```bash
NS=$(dig +short NS groutpro.ru @8.8.8.8 | sed -n 1p); echo "NS: $NS"
for n in groutpro.ru www.groutpro.ru; do for t in A AAAA CNAME MX TXT CAA; do printf '%-16s %-5s %s\n' "$n" "$t" "$(dig +short $t $n @$NS | tr '\n' ' ')"; done; done | tee ~/groutpro.ru-dns-before.txt
dig +short A serious-company.ru @8.8.8.8      # 213.217.2.152 — тот же IP, что пропишем groutpro.ru
```

### 3.3 Записи

| Тип | Имя | Значение | Действие |
|---|---|---|---|
| A | `@` | `213.217.2.152` | изменить (сейчас `31.31.197.49` — хостинг reg.ru) |
| A | `www` | `213.217.2.152` | изменить или добавить. Если `www` — CNAME на `groutpro.ru.`, оставить как есть |
| AAAA | `@` | `2a00:f940:2:2:1:1:0:298` | **удалить** |
| AAAA | `www` | — | удалить, если есть |
| MX, TXT (SPF, DKIM, подтверждения), `mail`, `smtp`, `pop`, `imap` | — | — | **не трогать**: на них почта `info@groutpro.ru`, указанная на сайте |
| CAA | `@` | — | если есть, должна разрешать `letsencrypt.org`; иначе сертификат не выпустится |

- **TTL** изменённых записей — 300 (5 минут) на время переезда, через неделю можно вернуть 3600.
- **AAAA удалять обязательно**: у сервера нет публичного IPv6. Let's Encrypt предпочитает IPv6 и
  проверял бы старый хостинг; посетители с IPv6 тоже попадали бы туда.
- Если через несколько минут A-запись в панели хостинга сама вернулась на `31.31.197.49`, её
  перегенерирует хостинг. Тогда переведите домен на NS `ns1.reg.ru`/`ns2.reg.ru` (раздел 10, пункт 2)
  и заведите записи там.

### 3.4 Дождаться обновления

```bash
dig +short A groutpro.ru @$NS ; dig +short A www.groutpro.ru @$NS        # сразу: 213.217.2.152
for r in 8.8.8.8 1.1.1.1 77.88.8.8; do echo "$r: A=$(dig +short A groutpro.ru @$r | tr '\n' ' ') www=$(dig +short A www.groutpro.ru @$r | tr '\n' ' ') AAAA=$(dig +short AAAA groutpro.ru @$r | tr '\n' ' ')"; done
```

У всех трёх резолверов: A и www — `213.217.2.152`, AAAA — пусто. Обычно это занимает от 5 минут
до нескольких часов: старые записи держатся по их прежнему TTL.

### 3.5 Роутер

Сервер стоит за домашним роутером, порты 80 и 443 уже проброшены на него для serious-company.ru.
`groutpro.ru` указывает на тот же внешний IP, поэтому на роутере ничего менять не нужно: nginx
различает сайты по имени. Проверка снаружи — после этапа 1, с телефона через мобильный интернет
(не через домашний Wi-Fi).

## 4. nginx, этап 1: сертификат

Сертификата для groutpro.ru ещё нет, а итоговый конфиг на него ссылается. Поэтому сначала
включается маленький HTTP-блок: он отвечает на проверку Let's Encrypt, а остальных посетителей
`groutpro.ru` временно ведёт на работающий `serious-company.ru`.

```bash
sudo cp "$APP/deploy/nginx/groutpro.ru-stage1.conf" /etc/nginx/sites-available/groutpro-acme
sudo ln -s /etc/nginx/sites-available/groutpro-acme /etc/nginx/sites-enabled/groutpro-acme
sudo install -d /var/www/html/.well-known/acme-challenge
sudo nginx -t && sudo systemctl reload nginx

echo ok | sudo tee /var/www/html/.well-known/acme-challenge/groutpro-test > /dev/null
curl -s $R http://groutpro.ru/.well-known/acme-challenge/groutpro-test          # ok
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' $R http://groutpro.ru/shop   # 302 https://serious-company.ru/shop
```

С телефона через мобильный интернет откройте `http://groutpro.ru/.well-known/acme-challenge/groutpro-test`.
Должно показать `ok`: значит DNS, роутер и nginx в порядке. После этого:

```bash
sudo certbot certonly --webroot -w /var/www/html -d groutpro.ru -d www.groutpro.ru --deploy-hook "systemctl reload nginx"
sudo certbot certificates | grep -E 'Certificate Name|Domains|Expiry|Certificate Path'
sudo rm /var/www/html/.well-known/acme-challenge/groutpro-test
```

`--deploy-hook` сохраняется в настройках продления, и после каждого продления nginx перечитает
сертификат.

| Ошибка certbot | Причина |
|---|---|
| `Timeout during connect` | порт 80 не доходит до сервера: роутер, файрвол (`sudo ufw status`) |
| `Invalid response … 404` или чужая страница | DNS ещё указывает на хостинг, или осталась AAAA-запись |
| `CAA record … prevents issuance` | CAA-запись не разрешает `letsencrypt.org` |
| `too many failed authorizations` | лимит попыток Let's Encrypt: подождите час и сначала проверьте `--dry-run` |

## 5. nginx, этап 2: итоговый конфиг

```bash
sudo cp "$APP/deploy/nginx/groutpro.ru.conf" /etc/nginx/sites-available/groutpro
grep -n 'ssl_certificate ' /etc/nginx/sites-available/groutpro
```

- Пути `ssl_certificate` должны совпасть с `certbot certificates`. Если каталог старого сертификата
  называется иначе, поправьте его, например:
  `sudo sed -i 's#/live/serious-company.ru/#/live/serious-company.ru-0001/#' /etc/nginx/sites-available/groutpro`.
- Если в старом файле были `listen [::]:…`, раскомментируйте их: `sudo nano /etc/nginx/sites-available/groutpro`.

Включение. У итогового конфига свой блок `:80` для groutpro.ru, поэтому этап 1 больше не нужен:

```bash
sudo rm /etc/nginx/sites-enabled/groutpro-acme
sudo nginx -t && sudo systemctl reload nginx
```

Если `nginx -t` выдал ошибку, reload не выполняется и сайт работает по-старому. **Сразу** верните
файл, иначе ошибка всплывёт при следующем reload (например, после продления сертификата):

```bash
sudo cp -a "$BK/nginx-groutpro" /etc/nginx/sites-available/groutpro
sudo ln -sf /etc/nginx/sites-available/groutpro-acme /etc/nginx/sites-enabled/groutpro-acme
sudo nginx -t
```

HTTP/2: в nginx 1.28 включается директивой `http2 on;` внутри `server`, как в конфиге. Старая форма
`listen 443 ssl http2;` работает, но выдаёт предупреждение «deprecated». Если такие предупреждения
пишет `nginx -t` про другие сайты, это не ошибка.

Проверка с сервера:

```bash
curl -s -o /dev/null -w '%{http_code}\n' $R https://groutpro.ru/                                    # 200
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' $R https://www.groutpro.ru/shop            # 301 https://groutpro.ru/shop
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' $R 'https://serious-company.ru/shop?x=1'   # 301 https://groutpro.ru/shop?x=1
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' $R http://groutpro.ru/cart                 # 301 https://groutpro.ru/cart
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' $R http://serious-company.ru/              # 301 https://groutpro.ru/
curl -s $R -X POST https://serious-company.ru/api/payments/webhook -H 'Content-Type: application/json' -d '{"event":"check"}'; echo   # {"status":"ignored"}
curl -s $R https://groutpro.ru/health; echo                                                          # ok
for p in /shop /cart /account /privacy-policy /admin /admin/login /sitemap.xml /robots.txt "/api/products?page_size=1"; do printf '%-28s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' $R "https://groutpro.ru$p")"; done   # всё 200
curl -sI $R https://groutpro.ru/ | grep -i -E '^(HTTP|x-content-type-options|referrer-policy|x-frame-options)'
curl -s -o /dev/null -D - -H 'Accept-Encoding: gzip' $R https://groutpro.ru/css/style.css | grep -i -E '^(cache-control|content-encoding)'   # no-cache, gzip (GET: на HEAD nginx gzip не включает)
```

Лимит на вход в админку: первые 6 ответов — 4xx от backend, дальше 429 с JSON. После проверки
минуту входить в админку с самого сервера не получится, с других адресов — можно.

```bash
for i in $(seq 1 10); do curl -s -o /dev/null -w '%{http_code} ' $R -X POST https://groutpro.ru/api/admin/login -H 'Content-Type: application/json' -d '{}'; done; echo
```

Остальные сайты сервера должны отвечать как раньше:

```bash
sudo nginx -T 2>/dev/null | sed -n -E 's/^[[:space:]]*server_name[[:space:]]+([^;]*);/\1/p' | tr ' ' '\n' | sort -u
# для каждого чужого имени N:  curl -sI --resolve N:443:127.0.0.1 https://N/ | sed -n 1p
```

Продление обоих сертификатов: `sudo certbot renew --dry-run` должен закончиться «Congratulations, all simulated renewals succeeded».

Может не пройти serious-company.ru, если его продление настроено на другой `webroot_path`
(см. шаг 2), а проверочные файлы теперь отдаются из `/var/www/html`. Тогда перевыпустите его с тем же
набором имён, что в `certbot certificates`:

```bash
sudo certbot certonly --webroot -w /var/www/html --cert-name serious-company.ru -d serious-company.ru --deploy-hook "systemctl reload nginx"
```

Снаружи, с телефона через мобильный интернет: `https://groutpro.ru`, `https://www.groutpro.ru` → groutpro.ru,
`https://serious-company.ru/shop` → `https://groutpro.ru/shop`.

## 6. SITE_URL

От `SITE_URL` зависят адрес возврата после оплаты ЮKassa, ссылки в уведомлениях
(`…/admin#orders` и т. п.) и CORS.

```bash
sudo grep -n '^SITE_URL=' /etc/groutpro.env "$APP/secrets/notify.env"
if sudo grep -q '^SITE_URL=' /etc/groutpro.env; then sudo sed -i 's#^SITE_URL=.*#SITE_URL=https://groutpro.ru#' /etc/groutpro.env; else echo 'SITE_URL=https://groutpro.ru' | sudo tee -a /etc/groutpro.env > /dev/null; fi
sudo grep -n '^SITE_URL=' /etc/groutpro.env                   # SITE_URL=https://groutpro.ru — без «/» в конце
```

`secrets/notify.env` важнее `/etc/groutpro.env`. Если первая команда нашла `SITE_URL` и в нём, поправьте
и там: `sudo sed -i 's#^SITE_URL=.*#SITE_URL=https://groutpro.ru#' "$APP/secrets/notify.env"`.

```bash
sudo systemctl restart groutpro.service
systemctl is-active groutpro.service; curl -s http://127.0.0.1:3100/health; echo        # active, ok
sudo journalctl -u groutpro.service -n 15 --no-pager | grep -i site_url                # пусто — без предупреждений
```

## 7. Новый домен в файлах сайта

`deploy/change-domain.sh` меняет `serious-company.ru` на `groutpro.ru` (по умолчанию) в canonical,
Open Graph, JSON-LD, `sitemap.xml`, `robots.txt`, тексте политики конфиденциальности и
`backend/.env.example`. Скрипт можно запускать повторно и из любого каталога; `--dry-run` только
показывает diff.

**Вариант А — через репозиторий (рекомендуется).** В своей копии репозитория, на ветке выкладки:

```bash
bash deploy/change-domain.sh --dry-run     # посмотреть
bash deploy/change-domain.sh               # заменить; в конце — остатки и откат
git diff --stat && git commit -am "Сайт переезжает на groutpro.ru" && git push
```

Затем на сервере — «Только статика» из [DEPLOY.md](DEPLOY.md) (раздел 11.1). Backend не пересобирается.

**Вариант Б — сразу на сервере**, если нет времени. Правка действует сразу, но следующая выкладка
`git checkout -f` её сотрёт, если то же самое не закоммитить в ветку:

```bash
bash "$APP/deploy/change-domain.sh"
git -C "$APP" diff --stat
```

Проверка:

```bash
curl -s $R https://groutpro.ru/ | grep -o 'rel="canonical" href="[^"]*"'     # https://groutpro.ru/
curl -s $R https://groutpro.ru/robots.txt | grep -i sitemap                   # https://groutpro.ru/sitemap.xml
grep -rIl 'serious-company' "$APP/frontend" | wc -l                          # 0
```

В `frontend/privacy-policy.html` при необходимости обновите дату «Редакция от …».

## 8. ЮKassa

Делает Дмитрий или вы с доступом к личному кабинету ЮKassa.

1. «Интеграция» → «HTTP-уведомления»: URL `https://groutpro.ru/api/payments/webhook`, событие
   «Успешный платёж» (`payment.succeeded`). Сохранить.
2. Настройки магазина → адрес сайта: `https://groutpro.ru`. ЮKassa может проверить новый сайт.
   Это делает владелец договора, при необходимости через поддержку ЮKassa.

Пока адрес не сменили, уведомления на старый домен nginx пересылает в backend, так что оплаты
не теряются.

Проверка, если онлайн-оплата включена: оплатить недорогую позицию. После оплаты должно вернуть
на `https://groutpro.ru/cart.html?success=1&order=…`, а в админке заказ станет «Оплачен».

```bash
sudo journalctl -u groutpro.service --since '-15 min' --no-pager | grep -i -E 'webhook|payment|yookassa'
```

## 9. Поисковики

- **Яндекс Вебмастер.**
  1. Добавьте `https://groutpro.ru` и подтвердите права: TXT-запись в DNS или HTML-файл в
     `$APP/frontend/`. Неотслеживаемый файл переживает выкладки.
  2. «Индексирование» → «Файлы Sitemap» → `https://groutpro.ru/sitemap.xml`.
  3. В старом сайте `serious-company.ru`: «Индексирование» → «Переезд сайта» → `groutpro.ru`,
     отметить HTTPS.
- **Google Search Console.**
  1. Добавьте ресурс `groutpro.ru` (подтверждение TXT-записью) и Sitemap.
  2. В ресурсе `serious-company.ru`: «Настройки» → «Изменение адреса» → `groutpro.ru`.
- Обновите адрес сайта в Яндекс Бизнесе, 2ГИС и соцсетях, если он там указан.

## 10. Хостинг reg.ru u3600055 (Host-0)

После переезда сайт на хостинге не используется, и заказчик может отказаться от этой услуги.
**Сначала** проверьте две вещи — иначе пропадут почта или весь домен:

1. **Почта.** `dig +short MX groutpro.ru @8.8.8.8`. Если MX указывают на хостинг reg.ru
   (`mx1.hosting.reg.ru` и т. п.), ящик `info@groutpro.ru` с сайта живёт на этом хостинге.
   Перенесите почту (Яндекс 360, Mail.ru для бизнеса, почта reg.ru), смените MX и проверьте
   приём и отправку.
2. **NS.** Если NS — `ns1.hosting.reg.ru`/`ns2.hosting.reg.ru`, зона домена хранится на хостинге.
   1. В кабинете reg.ru: «Домены» → `groutpro.ru` → «DNS-серверы» → бесплатные `ns1.reg.ru`, `ns2.reg.ru`.
   2. В «Управлении зоной» заведите те же записи: A `@` и `www` → `213.217.2.152`, MX, TXT — по
      `~/groutpro.ru-dns-before.txt` и шагу 3.3.
   3. Подождите до суток и сверьте ответы `dig` от `@8.8.8.8` и `@ns1.reg.ru`.
3. Нужные файлы со старого хостинга заказчик сохраняет сам.

После этого Дмитрий отказывается от хостинга в кабинете reg.ru («Услуги» → хостинг → не продлевать
или удалить). Сам домен `groutpro.ru` — отдельная услуга: её продлевать.

## 11. Итоговая проверка

- [ ] `whois groutpro.ru`: `DELEGATED`, `VERIFIED`;
- [ ] `dig` A и www → `213.217.2.152`, AAAA пусто, MX и TXT на месте;
- [ ] `https://groutpro.ru` открывается с телефона, замок в браузере без предупреждений;
- [ ] `www` и `serious-company.ru` с путём и параметрами ведут на `https://groutpro.ru/<тот же путь>`;
- [ ] вход в админку `https://groutpro.ru/admin/login`, заявка с сайта приходит, ссылка в уведомлении ведёт на groutpro.ru;
- [ ] `sudo certbot renew --dry-run` — успешно для обоих сертификатов;
- [ ] ЮKassa: новый адрес уведомлений, тестовая оплата (если включена);
- [ ] Вебмастер и Search Console: переезд оформлен.

Покупателям и админу после переезда нужно войти заново: вход, корзина и тема хранятся отдельно
для каждого домена. Для тестового сайта это нормально.

Если отправитель писем (`SMTP_FROM`) будет на `@groutpro.ru` через Яндекс, домен нужно подключить
к Яндекс 360: MX `mx.yandex.net`, SPF `v=spf1 redirect=_spf.yandex.net`, DKIM. Иначе SMTP ответит
«553 not owned by auth user».

HSTS (`Strict-Transport-Security` в конфиге закомментирован) включайте через одну-две недели
стабильной работы HTTPS.

## 12. Откат

Каждый пункт независим — откатывайте только то, что сломалось.

```bash
# nginx — serious-company.ru снова обслуживает сайт как раньше
sudo cp -a "$BK/nginx-groutpro" /etc/nginx/sites-available/groutpro
sudo rm -f /etc/nginx/sites-enabled/groutpro-acme
sudo nginx -t && sudo systemctl reload nginx
curl -s -o /dev/null -w '%{http_code}\n' $R https://serious-company.ru/      # 200

# SITE_URL
sudo cp -a "$BK/groutpro.env" /etc/groutpro.env && sudo systemctl restart groutpro.service
sudo grep -n '^SITE_URL=' /etc/groutpro.env                                  # https://serious-company.ru

# файлы сайта: вариант А — git revert коммита с доменом и выкладка «Только статика»;
# вариант Б (правка на сервере, ещё не закоммичена):
git -C "$APP" checkout -- frontend backend/.env.example
```

- **ЮKassa:** вернуть адрес уведомлений `https://serious-company.ru/api/payments/webhook`.
- **DNS** можно не трогать: groutpro.ru, указывающий на сервер, ничему не мешает. Полный возврат —
  записи из `~/groutpro.ru-dns-before.txt` (A `31.31.197.49`, AAAA `2a00:f940:2:2:1:1:0:298`).
- **Зоны лимитов** в `/etc/nginx/conf.d/groutpro-ratelimit.conf` безвредны, их можно оставить. Удаление:
  `sudo rm /etc/nginx/conf.d/groutpro-ratelimit.conf && sudo nginx -t && sudo systemctl reload nginx`
  — только после возврата старого `groutpro`, который на них не ссылается.
- **Сертификат groutpro.ru** после отката nginx не продлится: блока `:80` для него больше нет.
  Если переезд отменён насовсем: `sudo certbot delete --cert-name groutpro.ru`.
