# 📁 Файли для розгортання на Hetzner

## Список нових файлів для Hetzner

### 📘 Документація

1. **[HETZNER_SETUP.md](./HETZNER_SETUP.md)** - Повна інструкція з усіма деталями
2. **[HETZNER_QUICK_START.md](./HETZNER_QUICK_START.md)** - Швидкий старт за 15 хвилин
3. **[HETZNER_FILES_INFO.md](./HETZNER_FILES_INFO.md)** - Цей файл, опис всіх файлів

### 🐳 Docker конфігурація

4. **[docker-compose.yml](./docker-compose.yml)**
   - Docker Compose конфігурація для Hetzner
   - Включає PostgreSQL + Strapi
   - Локальна база даних в Docker контейнері
   - Використання: `docker-compose up -d`

### 🔧 Скрипти автоматизації

5. **[setup-server.sh](./setup-server.sh)**
   - Скрипт першої налаштування сервера
   - Встановлює: Docker, Docker Compose, Nginx, Certbot, UFW
   - Налаштовує swap, файрвол, автооновлення
   - Запуск: `./setup-server.sh`

6. **[deploy.sh](./deploy.sh)**
   - Скрипт деплою/оновлення Strapi
   - Git pull + Docker build + Docker up
   - Використовується для оновлення проекту
   - Запуск: `./deploy.sh`

### ⚙️ Конфігураційні файли

7. **[.env.example](./.env.example)**
   - Приклад .env файлу для Hetzner
   - З PostgreSQL замість Supabase
   - Треба скопіювати в .env та заповнити своїми даними

8. **Nginx конфігурація** (в документації [HETZNER_SETUP.md](./HETZNER_SETUP.md))
   - Конфігурація Nginx для reverse proxy
   - Підтримка WebSocket, великих файлів (100MB)
   - Створюється в `/etc/nginx/sites-available/`

---

## 🔄 Відмінності від Oracle Cloud версії

| Параметр | Старі файли (Oracle) | Нові файли (Hetzner) |
|----------|----------------------|----------------------|
| **База даних** | Supabase (зовнішня) | PostgreSQL в Docker |
| **Docker Compose** | `docker-compose.yml` (Supabase) | `docker-compose.yml` (PostgreSQL) |
| **Deploy скрипт** | `deploy.sh` | `deploy.sh` (оновлено) |
| **Setup скрипт** | `setup-server.sh` (Oracle) | `setup-server.sh` (Hetzner) |
| **Ціна** | Безкоштовно (якщо є місця) | €5.39/міс |
| **RAM** | До 24 GB | 4 GB (CPX21) |

**Примітка:** Всі старі файли для Oracle Cloud видалені, залишилися тільки файли для Hetzner.

---

## 🚀 Швидкий старт

### 1. Локально (підготовка):

```bash
# Скопіюй .env.example в .env
cp .env.example .env

# Відредагуй .env (заповни свої дані!)
nano .env

# Закомічь зміни
git add .
git commit -m "Add Hetzner deployment configuration"
git push
```

### 2. На сервері Hetzner:

```bash
# Налаштуй сервер
./setup-server.sh

# Клонуй проект
cd /opt/barbitch-strapi
git clone https://github.com/YOUR_USER/barbitch-strapi.git .

# Створи .env (скопіюй з локального)
nano .env

# Запусти деплой
./deploy.sh
```

### 3. Налаштуй Nginx та SSL:

Дивись детальні інструкції в [HETZNER_SETUP.md](./HETZNER_SETUP.md) розділ 5.2 та 5.4

---

## 📊 Структура проекту після деплою

```
/opt/barbitch-strapi/
├── .env                          # Змінні оточення
├── docker-compose.hetzner.yml    # Docker конфігурація
├── deploy-hetzner.sh            # Скрипт деплою
├── Dockerfile                    # Docker образ
├── package.json                  # NPM залежності
├── src/                         # Код Strapi
└── ...

Docker volumes:
├── postgres-data/               # База даних PostgreSQL
└── strapi-uploads/              # Завантажені файли (якщо не Cloudinary)
```

---

## 🔐 Важливі нюанси

### Безпека .env файлу

⚠️ **НІКОЛИ не комітить .env з реальними паролями в Git!**

```bash
# .env вже в .gitignore, але перевір:
git status
# Не повинно показувати .env файл
```

### Бекап бази даних

```bash
# Експорт бази
docker exec barbitch-strapi-db pg_dump -U strapi strapi > backup.sql

# Імпорт бази
cat backup.sql | docker exec -i barbitch-strapi-db psql -U strapi -d strapi
```

### Моніторинг ресурсів

```bash
# Використання диску
df -h
docker system df

# Використання RAM
free -h

# Використання CPU
htop
```

---

## 🆘 Troubleshooting

### Контейнер не запускається

```bash
# Дивись логи
docker-compose logs

# Перебудуй без кешу
docker-compose build --no-cache

# Перезапусти
docker-compose restart
```

### База даних недоступна

```bash
# Перевір що PostgreSQL працює
docker-compose ps

# Зайди в базу вручну
docker exec -it barbitch-strapi-db psql -U strapi -d strapi
```

### Nginx не працює

```bash
# Перевір конфіг
nginx -t

# Дивись логи
tail -f /var/log/nginx/error.log

# Перезапусти
systemctl restart nginx
```

---

## 📞 Контакти та підтримка

Якщо виникли проблеми:
1. Перевір [HETZNER_SETUP.md](./HETZNER_SETUP.md) - повна інструкція
2. Подивись логи Docker: `docker-compose -f docker-compose.hetzner.yml logs`
3. Подивись логи Nginx: `tail -f /var/log/nginx/error.log`
4. Питай у чаті!

---

## ✅ Чеклист деплою

- [ ] Створив Hetzner акаунт
- [ ] Створив сервер CPX21
- [ ] Налаштував DNS (A-запис)
- [ ] Виконав setup-hetzner.sh
- [ ] Клонував проект
- [ ] Створив .env з правильними даними
- [ ] Запустив deploy-hetzner.sh
- [ ] Налаштував Nginx
- [ ] Встановив SSL через Certbot
- [ ] Перевірив що Strapi працює через HTTPS
- [ ] Зробив бекап бази даних

---

Успішного деплою! 🚀
