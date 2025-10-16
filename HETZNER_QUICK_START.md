# ⚡ Швидкий старт - Hetzner Cloud

## 📦 Що потрібно заздалегідь:

1. Акаунт на Hetzner Cloud (https://accounts.hetzner.com/signUp)
2. Мінімум €10 на рахунку
3. Твій GitHub репозиторій з цим проектом
4. Доступ до DNS налаштувань домену barbitch.cz

---

## 🚀 Швидке розгортання (15 хвилин)

### Крок 1: Створи сервер на Hetzner (3 хв)

1. Зайди на https://console.hetzner.cloud/
2. Створи новий проект: `barbitch-strapi`
3. **Add Server:**
   - Location: **Nuremberg, Germany**
   - Image: **Ubuntu 22.04**
   - Type: **Shared vCPU** → **CPX21** (€5.39/міс)
   - SSH Key: додай свій (або пропусти, пароль прийде на email)
   - Firewall: створи з портами 22, 80, 443
   - Name: `barbitch-strapi-1`
4. **Create & Buy now**
5. **Запиши IP адресу** (наприклад: `95.217.123.45`)

---

### Крок 2: Налаштуй DNS (2 хв)

У DNS провайдері (де barbitch.cz):

```
Type: A
Host: demo-strapi
Value: 95.217.123.45  (твій Hetzner IP)
TTL: 300
```

Зачекай 5 хвилин.

---

### Крок 3: Підключись до сервера (1 хв)

```bash
ssh root@95.217.123.45
# Введи пароль з email (якщо не використовував SSH ключ)
```

---

### Крок 4: Налаштуй сервер (5 хв)

**На сервері виконай:**

```bash
# Завантаж та запусти скрипт налаштування
curl -o setup.sh https://raw.githubusercontent.com/YOUR_GITHUB/barbitch-strapi/main/setup-server.sh
chmod +x setup.sh
./setup.sh
```

Або вручну (копіюй по черзі):

```bash
# Оновлення системи
apt update && apt upgrade -y

# Встановлення пакетів
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

# Проект
mkdir -p /opt/barbitch-strapi
cd /opt/barbitch-strapi
```

---

### Крок 5: Завантаж проект (2 хв)

```bash
cd /opt/barbitch-strapi

# Клонуй репозиторій (заміни URL!)
git clone https://github.com/YOUR_USERNAME/barbitch-strapi.git .

# Створи .env файл
nano .env
```

**Вставте в .env (заміни дані!):**

```env
HOST=0.0.0.0
PORT=1350
NODE_ENV=production

# ⚠️ ЗАМІНИ ДОМЕН!
URL=https://demo-strapi.barbitch.cz
ADMIN_URL=https://demo-strapi.barbitch.cz/admin
STRAPI_ADMIN_BACKEND_URL=https://demo-strapi.barbitch.cz

# Секрети зі свого локального .env
APP_KEYS=твої_ключі_тут
API_TOKEN_SALT=твій_сіль
ADMIN_JWT_SECRET=твій_секрет
TRANSFER_TOKEN_SALT=твій_сіль
JWT_SECRET=твій_секрет

# PostgreSQL
DATABASE_CLIENT=postgres
DATABASE_HOST=postgres
DATABASE_PORT=5432
DATABASE_NAME=strapi
DATABASE_USERNAME=strapi
DATABASE_PASSWORD=StrongPassword123!
DATABASE_SSL=false

POSTGRES_PASSWORD=StrongRootPassword456!

# ⚠️ ЗАМІНИ НА СВОЇ!
CLOUDINARY_NAME=твій_name
CLOUDINARY_KEY=твій_key
CLOUDINARY_SECRET=твій_secret

OPENAI_API_KEY=твій_ключ_якщо_потрібен
```

Збережи: `Ctrl+O`, `Enter`, `Ctrl+X`

---

### Крок 6: Запусти Strapi (2 хв)

```bash
chmod +x deploy.sh
./deploy.sh
```

Зачекай 2-3 хвилини поки все збудується та запуститься.

**Перевір:**
```bash
docker-compose ps
curl http://localhost:1350
```

---

### Крок 7: Налаштуй Nginx (2 хв)

```bash
# Створи конфіг
nano /etc/nginx/sites-available/demo-strapi.barbitch.cz
```

**Вставте (заміни домен!):**

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

**Перевір:** Відкрий http://demo-strapi.barbitch.cz у браузері!

---

### Крок 8: Встанови SSL (1 хв)

```bash
certbot --nginx -d demo-strapi.barbitch.cz

# Email: твій email
# Agree: Yes
# Share: No
# Redirect: Yes (2)
```

**Готово!** Відкрий https://demo-strapi.barbitch.cz 🎉

---

## 🔧 Корисні команди

```bash
# Логи
docker-compose logs -f strapi

# Рестарт
docker-compose restart

# Оновлення проекту
cd /opt/barbitch-strapi
git pull
./deploy.sh

# Статус
docker-compose ps

# Зайти в контейнер
docker exec -it barbitch-strapi sh

# База даних
docker exec -it barbitch-strapi-db psql -U strapi -d strapi
```

---

## 🆘 Проблеми?

### Strapi не запускається

```bash
docker-compose logs strapi
```

### 502 Bad Gateway

```bash
docker-compose restart
systemctl restart nginx
```

### База не підключається

```bash
docker-compose logs postgres
```

---

## ✅ Готово!

Твій Strapi працює на Hetzner!

**Вартість:** €5.39/міс = ~143 CZK/міс
**Економія порівняно з Wedos:** ~500 CZK/міс 💰

**Наступні кроки:**
1. Протестуй проект
2. Мігруй інші 5 Strapi проектів
3. Перенеси фронтенди на Vercel
4. Скасуй Wedos після повної міграції

Потрібна допомога? Питай! 🚀
