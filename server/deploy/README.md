# Развёртывание API на VPS

Рассчитано на Ubuntu 24.04 и домен `pomogator.ru`.

## 1. Что купить

| Что | Где | Цена |
|---|---|---|
| Домен `.ru` | reg.ru, timeweb, beget | 200–900 ₽/год |
| VPS 2 vCPU / 2 ГБ / 40 ГБ | Timeweb Cloud, Beget | 600–900 ₽/мес |

Итого около 1 000 ₽/мес. Больше для старта не нужно.

## 2. DNS

В панели домена добавить A-запись:

```
api.pomogator.ru  →  <IP VPS>
```

Подождать 5–15 минут, проверить: `nslookup api.pomogator.ru`.

## 3. Подготовка сервера

```bash
ssh root@<IP>

# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Caddy (HTTPS сам)
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  > /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy

# Пользователь
useradd --system --home /opt/pomogator --shell /usr/sbin/nologin pomogator
mkdir -p /opt/pomogator
```

## 4. Код и настройки

Скопировать папку `server` на сервер, например:

```bash
scp -r server root@<IP>:/opt/pomogator/
```

Затем:

```bash
cd /opt/pomogator/server
cp .env.example .env
nano .env
```

В `.env` обязательно поменять:

```
AUTH_SECRET=<длинная случайная строка>
ADMIN_TOKEN=<длинный случайный токен>
MAIL_MODE=resend
RESEND_API_KEY=<ключ Resend>
MAIL_FROM=Помогатор <login@pomogator.ru>
```

Сгенерировать секреты можно так:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Права:

```bash
chown -R pomogator:pomogator /opt/pomogator
chmod 600 /opt/pomogator/server/.env
```

## 5. Сервис

```bash
cp deploy/pomogator-api.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now pomogator-api
systemctl status pomogator-api
```

## 6. HTTPS

```bash
cp deploy/Caddyfile /etc/caddy/Caddyfile
# заменить домен, если он другой
systemctl reload caddy
```

Проверка:

```bash
curl https://api.pomogator.ru/health
```

## 7. Проверка входа

```bash
curl -X POST https://api.pomogator.ru/auth/request \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com"}'
```

Код придёт на почту. Дальше — окно входа в приложении.

## 8. Бэкап

Ежедневно в 03:00:

```bash
crontab -e
```

```
0 3 * * * cp /opt/pomogator/server/data/pomogator.db /opt/backup/pomogator-$(date +\%F).db
```

Лучше — на внешнее S3-хранилище, но на старте хватит локальной копии.

## 9. Обновление

```bash
scp -r server root@<IP>:/opt/pomogator/
systemctl restart pomogator-api
```

База и `.env` не перезаписываются, если копировать только `src`.
