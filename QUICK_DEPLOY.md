# ⚡ Швидкий деплой тестового проекту на Hetzner

## Цей проект (demo-strapi.barbitch.cz)

**База даних:** Supabase (зовнішня)
**Медіа:** Cloudinary
**Час деплою:** 15 хвилин

---

## 🚀 Покроковий деплой

### 1. Створи Hetzner VPS (3 хв)

1. https://console.hetzner.cloud/
2. New Project → `barbitch-strapi`
3. Add Server:
   - **Location:** Nuremberg, Germany
   - **Image:** Ubuntu 22.04
   - **Type:** CPX21 (3 vCPU, 4 GB RAM, €5.39/міс)
   - **SSH Key:** Додай свій або використай пароль
   - **Name:** `barbitch-strapi-1`
4. Create & Buy
5. **Запиши IP:** `__.__.__.__`

---

### 2. Налаштуй DNS (2 хв)

У DNS провайдері barbitch.cz:

```
Type: A
Host: demo-strapi
Value: ТВІЙ_HETZNER_IP
TTL: 300
```

Зачекай 5 хвилин, перевір: `ping demo-strapi.barbitch.cz`

---

### 3. Підключись до сервера (1 хв)

```bash
ssh root@ТВІЙ_HETZNER_IP
```

---

### 4. Налаштуй сервер (5 хв)

```bash
# Оновлення
apt update && apt upgrade -y

# Пакети
apt install -y curl git nginx certbot python3-certbot-nginx ufw

# Docker
curl -fsSL https://get.docker.com | sh

# Docker Compose
curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose

# Файрвол
ufw --force enable
ufw allow ssh
ufw allow http
ufw allow https

# Директорія
mkdir -p /opt/barbitch-strapi
cd /opt/barbitch-strapi
```

---

### 5. Завантаж проект (2 хв)

```bash
cd /opt/barbitch-strapi

# Клонуй репозиторій (заміни URL!)
git clone https://github.com/YOUR_USERNAME/barbitch-strapi.git .

# Створи .env (скопіюй з локального!)
nano .env
```

**Вставте в .env:**

```env
HOST=0.0.0.0
PORT=1350
NODE_ENV=production

# Домен
URL=https://demo-strapi.barbitch.cz
ADMIN_URL=https://demo-strapi.barbitch.cz/admin
STRAPI_ADMIN_BACKEND_URL=https://demo-strapi.barbitch.cz

# Секрети (СКОПІЮЙ З ЛОКАЛЬНОГО .env!)
APP_KEYS=твої_ключі
API_TOKEN_SALT=твій_salt
ADMIN_JWT_SECRET=твій_secret
TRANSFER_TOKEN_SALT=твій_salt
JWT_SECRET=твій_secret

# Supabase (СКОПІЮЙ З ЛОКАЛЬНОГО .env!)
DATABASE_CLIENT=postgres
DATABASE_HOST=aws-0-eu-central-1.pooler.supabase.com
DATABASE_PORT=6543
DATABASE_NAME=postgres
DATABASE_USERNAME=postgres.scteabivlzjegofvqzwv
DATABASE_PASSWORD=твій_пароль_supabase
DATABASE_SSL=true
DATABASE_SSL_REJECT_UNAUTHORIZED=false

# Cloudinary (СКОПІЮЙ З ЛОКАЛЬНОГО .env!)
CLOUDINARY_NAME=твій_name
CLOUDINARY_KEY=твій_key
CLOUDINARY_SECRET=твій_secret

# OpenAI (якщо є)
OPENAI_API_KEY=твій_ключ
```

Збережи: `Ctrl+O`, `Enter`, `Ctrl+X`

---

### 6. Запусти Strapi (2 хв)

```bash
chmod +x deploy.sh
./deploy.sh
```

Зачекай 2-3 хвилини. Перевір:

```bash
docker-compose ps
curl http://localhost:1350
```

---

### 7. Налаштуй Nginx (2 хв)

```bash
nano /etc/nginx/sites-available/demo-strapi.barbitch.cz
```

**Вставте:**

```nginx
server {
    listen 80;
    server_name demo-strapi.barbitch.cz;

    location / {
        proxy_pass http://localhost:1350;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        proxy_connect_timeout 600s;
        proxy_send_timeout 600s;
        proxy_read_timeout 600s;

        client_max_body_size 100M;
    }
}
```

Збережи: `Ctrl+O`, `Enter`, `Ctrl+X`

**Активуй:**

```bash
ln -s /etc/nginx/sites-available/demo-strapi.barbitch.cz /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl restart nginx
```

**Перевір:** http://demo-strapi.barbitch.cz

---

### 8. Встанови SSL (1 хв)

```bash
certbot --nginx -d demo-strapi.barbitch.cz

# Email: твій email
# Agree: Yes
# Share: No
# Redirect: Yes (2)
```

**Готово!** https://demo-strapi.barbitch.cz 🎉

---

## 📝 Корисні команди

```bash
# Логи
docker-compose logs -f strapi

# Рестарт
docker-compose restart

# Оновлення
cd /opt/barbitch-strapi
git pull
./deploy.sh

# Статус
docker-compose ps
```

---

## 🔄 Наступні кроки

Коли цей проект працює, можна мігрувати інші 5 проектів з Wedos:
- Дивись [migrate-from-wedos.md](./migrate-from-wedos.md)

---

**Успішного деплою! 🚀**
