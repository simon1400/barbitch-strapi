# 🚀 Розгортання Strapi на Hetzner Cloud

## 📋 Зміст
1. [Створення Hetzner Cloud акаунту](#1-створення-hetzner-cloud-акаунту)
2. [Створення VPS сервера](#2-створення-vps-сервера)
3. [Налаштування сервера](#3-налаштування-сервера)
4. [Деплой Strapi](#4-деплой-strapi)
5. [Налаштування домену та SSL](#5-налаштування-домену-та-ssl)
6. [Міграція інших проектів](#6-міграція-інших-проектів)

---

## 1. Створення Hetzner Cloud акаунту

### 1.1 Реєстрація

1. Перейди на https://accounts.hetzner.com/signUp
2. Заповни форму:
   - Email
   - Пароль
   - Ім'я та прізвище
3. Підтверди email
4. Додай платіжний метод (карта/PayPal)
   - **Важливо:** Мінімальне поповнення рахунку €10

### 1.2 Створення нового проекту

1. Зайди в Hetzner Cloud Console: https://console.hetzner.cloud/
2. Натисни **"New Project"**
3. Назва проекту: `barbitch-strapi` (або будь-яка інша)
4. Натисни **"Add Project"**

---

## 2. Створення VPS сервера

### 2.1 Створення Cloud Server

1. У твоєму проекті натисни **"Add Server"**
2. **Location:** Nuremberg, Germany (найближчий до Чехії)
3. **Image:** Ubuntu 22.04
4. **Type:**
   - **Shared vCPU** → **CPX21**
   - 3 vCPU, 4 GB RAM, 80 GB SSD
   - **€5.39/міс** (~143 CZK/міс)
   - 20 TB трафіку

### 2.2 SSH ключ (РЕКОМЕНДОВАНО)

**Якщо у тебе вже є SSH ключ (наприклад від Wedos):**
1. Натисни **"+ Add SSH key"**
2. Скопіюй вміст твого публічного ключа (`~/.ssh/id_rsa.pub`)
3. Назва: `My SSH Key`
4. Натисни **"Add SSH key"**

**Якщо немає SSH ключа:**
- Пропусти цей крок, використаємо пароль root (прийде на email)

### 2.3 Firewall (опціонально, але рекомендовано)

1. Натисни **"Create Firewall"**
2. Назва: `strapi-firewall`
3. **Inbound правила:**
   - SSH: Port 22 (Source: 0.0.0.0/0)
   - HTTP: Port 80 (Source: 0.0.0.0/0)
   - HTTPS: Port 443 (Source: 0.0.0.0/0)
4. Натисни **"Create Firewall"**

### 2.4 Завершення створення

1. **Server name:** `barbitch-strapi-1`
2. Натисни **"Create & Buy now"**
3. Зачекай 1-2 хвилини поки сервер створюється
4. **Запиши IP адресу сервера** (наприклад: `95.217.123.45`)

**Якщо не використовував SSH ключ:**
- Пароль root прийде на email

---

## 3. Налаштування сервера

### 3.1 Підключення до сервера

**З SSH ключем:**
```bash
ssh root@YOUR_SERVER_IP
```

**З паролем (якщо немає SSH ключа):**
```bash
ssh root@YOUR_SERVER_IP
# Введи пароль з email
```

### 3.2 Автоматичне налаштування сервера

На сервері виконай:

```bash
# Завантаж скрипт налаштування
curl -o setup-server.sh https://raw.githubusercontent.com/YOUR_GITHUB_USERNAME/barbitch-strapi/main/setup-server.sh

# Зроби його виконуваним
chmod +x setup-server.sh

# Запусти
./setup-server.sh
```

**Або вручну:**

```bash
# Оновлюємо систему
apt update && apt upgrade -y

# Встановлюємо необхідні пакети
apt install -y curl git nginx certbot python3-certbot-nginx ufw

# Встановлюємо Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh
rm get-docker.sh

# Встановлюємо Docker Compose
curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose

# Налаштовуємо файрвол
ufw --force enable
ufw allow ssh
ufw allow http
ufw allow https

# Створюємо директорію для проекту
mkdir -p /opt/barbitch-strapi
cd /opt/barbitch-strapi

echo "✅ Сервер готовий!"
```

---

## 4. Деплой Strapi

### 4.1 Клонування проекту

**На сервері:**

```bash
cd /opt/barbitch-strapi

# Клонуй репозиторій (заміни на свій URL)
git clone https://github.com/YOUR_GITHUB_USERNAME/barbitch-strapi.git .

# Або якщо використовуєш SSH
git clone git@github.com:YOUR_GITHUB_USERNAME/barbitch-strapi.git .
```

### 4.2 Створення .env файлу

```bash
nano .env
```

**Вставте свої дані:**

```env
# Strapi
HOST=0.0.0.0
PORT=1350
NODE_ENV=production

# URL домену (поміняй на свій!)
URL=https://demo-strapi.barbitch.cz
ADMIN_URL=https://demo-strapi.barbitch.cz/admin
STRAPI_ADMIN_BACKEND_URL=https://demo-strapi.barbitch.cz

# Секретні ключі (використай ті самі що і локально або згенеруй нові!)
APP_KEYS=kdosxg0l90XEK/JB/AU1KA==,HdhP1ypiXv3r+tCDxX2i7A==,GYkriejQ1T2s7RbsrtqT7g==,nWSmDiLCgRCvRM4Koy/OPQ==
API_TOKEN_SALT=par/Ss6Jz5UJCed20DnN3A==
ADMIN_JWT_SECRET=UyC3k0IgfShbEsHNA8Ne8g==
TRANSFER_TOKEN_SALT=IpW7hKrUKUGAYITyQlQCkw==
JWT_SECRET=KYiPpREfCLIBApW//NeGxQ==

# PostgreSQL Database (локальна база в Docker)
DATABASE_CLIENT=postgres
DATABASE_HOST=postgres
DATABASE_PORT=5432
DATABASE_NAME=strapi
DATABASE_USERNAME=strapi
DATABASE_PASSWORD=STRONG_PASSWORD_HERE_CHANGE_ME
DATABASE_SSL=false

# PostgreSQL Root Password
POSTGRES_PASSWORD=STRONG_ROOT_PASSWORD_HERE_CHANGE_ME

# Cloudinary (твої дані)
CLOUDINARY_NAME=dvze1n6sj
CLOUDINARY_KEY=742916666524782
CLOUDINARY_SECRET=frwo0zihxaDY7AKL7V_ayVuQSCU

# OpenAI (якщо використовуєш)
OPENAI_API_KEY=your-openai-key-if-needed
```

**Збережи:** `Ctrl+O`, `Enter`, `Ctrl+X`

**⚠️ ВАЖЛИВО:** Згенеруй нові паролі для DATABASE_PASSWORD та POSTGRES_PASSWORD!

### 4.3 Запуск Strapi

```bash
# Зроби deploy скрипт виконуваним
chmod +x deploy.sh

# Запусти деплой
./deploy.sh
```

Або вручну:

```bash
# Збери та запусти контейнери
docker-compose up -d --build

# Перевір статус
docker-compose ps

# Подивись логи
docker-compose logs -f strapi
```

**Зачекай 2-3 хвилини** поки Strapi збудується та запуститься.

### 4.4 Перевірка

```bash
# Перевір чи працює Strapi
curl http://localhost:1350

# Повинно повернути HTML або JSON
```

---

## 5. Налаштування домену та SSL

### 5.1 DNS налаштування

**У твоєму DNS провайдері (де зареєстрований barbitch.cz):**

Додай A-запис:
```
Type: A
Host: demo-strapi
Value: YOUR_SERVER_IP (наприклад 95.217.123.45)
TTL: 300
```

**Зачекай 5-10 хвилин** поки DNS оновиться.

Перевір:
```bash
ping demo-strapi.barbitch.cz
# Повинен повернути твій Hetzner IP
```

### 5.2 Налаштування Nginx

**На сервері:**

```bash
# Створи nginx конфігурацію
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

**Збережи:** `Ctrl+O`, `Enter`, `Ctrl+X`

**Активуй конфігурацію:**

```bash
# Створи symlink
ln -s /etc/nginx/sites-available/demo-strapi.barbitch.cz /etc/nginx/sites-enabled/

# Видали дефолтний конфіг
rm -f /etc/nginx/sites-enabled/default

# Перевір конфігурацію
nginx -t

# Перезапусти nginx
systemctl restart nginx
```

### 5.3 Перевірка HTTP

Відкрий у браузері: `http://demo-strapi.barbitch.cz`

Повинна відкритися адмінка Strapi! 🎉

### 5.4 Встановлення SSL (Let's Encrypt)

```bash
# Встанови SSL сертифікат
certbot --nginx -d demo-strapi.barbitch.cz

# Відповіді:
# Email: твій email
# Agree to terms: Yes (Y)
# Share email: No (N)
# Redirect HTTP to HTTPS: Yes (2)
```

**Готово!** Тепер Strapi доступний через HTTPS: `https://demo-strapi.barbitch.cz` 🔒

### 5.5 Автооновлення SSL

```bash
# Перевір автооновлення
certbot renew --dry-run

# Все налаштовано автоматично, нічого робити не треба!
```

---

## 6. Міграція інших проектів

Коли цей тестовий проект працює, можемо перейти до міграції інших 5 Strapi проектів.

### 6.1 Експорт бази даних з Wedos

**На твоєму Wedos сервері:**

```bash
# Для кожного проекту експортуй базу
pg_dump -U strapi_user database_name > /tmp/project1_backup.sql
```

### 6.2 Структура на Hetzner для кількох проектів

```
/opt/
  ├── strapi-project1/   (demo-strapi.barbitch.cz)
  ├── strapi-project2/   (project2.barbitch.cz)
  ├── strapi-project3/   (project3.barbitch.cz)
  └── ...
```

Кожен проект матиме свій Docker Compose з власною базою PostgreSQL.

---

## 🔧 Корисні команди

### Docker
```bash
# Логи
docker-compose logs -f

# Рестарт
docker-compose restart

# Зупинка
docker-compose down

# Статус
docker-compose ps

# Зайти в контейнер
docker exec -it barbitch-strapi sh

# Зайти в PostgreSQL
docker exec -it barbitch-strapi-db psql -U strapi
```

### Nginx
```bash
# Перевірка конфігурації
nginx -t

# Перезапуск
systemctl restart nginx

# Логи помилок
tail -f /var/log/nginx/error.log

# Логи доступу
tail -f /var/log/nginx/access.log
```

### Оновлення проекту
```bash
cd /opt/barbitch-strapi
./deploy.sh
```

---

## 🆘 Проблеми та рішення

### Strapi не запускається

```bash
# Подивись логи
docker-compose logs strapi

# Перезапусти контейнери
docker-compose restart
```

### 502 Bad Gateway

```bash
# Перевір що Strapi працює
docker-compose ps

# Перевір логи
docker-compose logs
```

### База даних не підключається

```bash
# Перевір що PostgreSQL працює
docker-compose ps

# Зайди в базу
docker exec -it barbitch-strapi-db psql -U strapi -d strapi
```

### SSL не працює

```bash
# Перевір сертифікати
certbot certificates

# Переустанови
certbot --nginx -d demo-strapi.barbitch.cz --force-renewal
```

---

## 💰 Вартість

**Hetzner CPX21:**
- €5.39/міс = ~143 CZK/міс
- **64.68 EUR/рік** = ~1,714 CZK/рік

**Економія порівняно з Wedos:**
- Wedos: 7,874 CZK/рік
- Hetzner: 1,714 CZK/рік
- **Економія: 6,160 CZK/рік** (~€232) 💰

---

## ✅ Готово!

Твій Strapi тепер працює на Hetzner! 🎉

**Наступні кроки:**
1. Протестуй поточний проект
2. Експортуй бази з Wedos
3. Мігруй інші 5 проектів
4. Перенеси фронтенди на Vercel (або залиш на Hetzner з nginx)
5. Скасуй Wedos підписку після повної міграції

**Потрібна допомога?** Пиши, буду допомагати з міграцією інших проектів!
