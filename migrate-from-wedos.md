# 🔄 Міграція з Wedos на Hetzner

## Покрокова інструкція міграції проекту з Wedos

---

## Етап 1: Підготовка (на Wedos)

### 1.1 Експорт бази даних

**На Wedos сервері:**

```bash
# SSH на Wedos
ssh root@YOUR_WEDOS_IP

# Знайди ім'я бази даних та користувача
# (подивись у .env файлі проекту)
cd /path/to/your/strapi/project
cat .env | grep DATABASE

# Експорт бази даних
pg_dump -U postgres your_database_name > /tmp/strapi_backup.sql

# Або якщо PostgreSQL з користувачем:
pg_dump -U strapi_user -h localhost your_database_name > /tmp/strapi_backup.sql

# Стисни для швидшої передачі
gzip /tmp/strapi_backup.sql
# Результат: /tmp/strapi_backup.sql.gz
```

### 1.2 Завантаж бекап на свій комп'ютер

**З твого комп'ютера:**

```bash
# Завантаж бекап з Wedos
scp root@YOUR_WEDOS_IP:/tmp/strapi_backup.sql.gz ~/Desktop/

# Перевір розмір
ls -lh ~/Desktop/strapi_backup.sql.gz
```

---

## Етап 2: Перенесення на Hetzner

### 2.1 Завантаж бекап на Hetzner

**З твого комп'ютера:**

```bash
# Завантаж на Hetzner
scp ~/Desktop/strapi_backup.sql.gz root@YOUR_HETZNER_IP:/tmp/

# Підключись до Hetzner
ssh root@YOUR_HETZNER_IP
```

### 2.2 Імпорт бази даних

**На Hetzner сервері:**

```bash
cd /opt/barbitch-strapi

# Перевір що PostgreSQL контейнер працює
docker-compose ps

# Розпакуй бекап
gunzip /tmp/strapi_backup.sql.gz

# Імпорт в PostgreSQL
cat /tmp/strapi_backup.sql | docker exec -i barbitch-strapi-db psql -U strapi -d strapi

# Або якщо потрібно створити базу спочатку:
docker exec -i barbitch-strapi-db psql -U strapi -d postgres -c "DROP DATABASE IF EXISTS strapi;"
docker exec -i barbitch-strapi-db psql -U strapi -d postgres -c "CREATE DATABASE strapi;"
cat /tmp/strapi_backup.sql | docker exec -i barbitch-strapi-db psql -U strapi -d strapi
```

### 2.3 Перевірка імпорту

```bash
# Зайди в базу
docker exec -it barbitch-strapi-db psql -U strapi -d strapi

# В PostgreSQL консолі:
\dt                          # Покаже всі таблиці
SELECT COUNT(*) FROM users;  # Перевір кількість користувачів
\q                          # Вихід
```

### 2.4 Перезапусти Strapi

```bash
cd /opt/barbitch-strapi
docker-compose restart strapi

# Перевір логи
docker-compose logs -f strapi
```

---

## Етап 3: Перевірка та тестування

### 3.1 Перевір адмін панель

1. Відкрий: `https://demo-strapi.barbitch.cz/admin`
2. Залогінься зі своїм старим акаунтом
3. Перевір що всі дані на місці:
   - Content types
   - Записи
   - Медіа файли (якщо в Cloudinary - повинні бути)
   - Користувачі

### 3.2 Перевір API

```bash
# Перевір API endpoint
curl https://demo-strapi.barbitch.cz/api/articles

# Повинен повернути твої статті
```

### 3.3 Тестування фронтенду

1. Підключи фронтенд до нового Strapi URL
2. Перевір що всі дані відображаються
3. Перевір що можна створювати/редагувати контент

---

## Етап 4: Оновлення DNS та фронтенду

### 4.1 Оновлення DNS

**У DNS провайдері:**

```
# Стара A-запис (Wedos):
Type: A
Host: strapi
Value: OLD_WEDOS_IP

# Нова A-запись (Hetzner):
Type: A
Host: strapi
Value: NEW_HETZNER_IP
TTL: 300
```

**Зачекай 5-10 хвилин** поки DNS оновиться.

### 4.2 Оновлення фронтенду

**Якщо фронтенд на Vercel:**

```bash
# У .env.production фронтенду:
NEXT_PUBLIC_STRAPI_URL=https://demo-strapi.barbitch.cz

# Закоміть та задеплой
git add .
git commit -m "Update Strapi URL to Hetzner"
git push

# Vercel автоматично задеплоїть
```

---

## Етап 5: Міграція інших 5 проектів

### Структура на Hetzner для 6 проектів:

```
/opt/
├── strapi-project1/          # demo-strapi.barbitch.cz (вже готовий)
├── strapi-project2/          # project2.barbitch.cz
├── strapi-project3/          # project3.barbitch.cz
├── strapi-project4/          # project4.barbitch.cz
├── strapi-project5/          # project5.barbitch.cz
└── strapi-project6/          # project6.barbitch.cz
```

### 5.1 Для кожного проекту:

```bash
# 1. Створи директорію
mkdir -p /opt/strapi-project2
cd /opt/strapi-project2

# 2. Клонуй проект
git clone <project2-repo-url> .

# 3. Створи .env (змінюй порт: 1351, 1352, тощо)
nano .env

# 4. Змінюй docker-compose.yml:
#    - Контейнер name: project2-strapi, project2-db
#    - Порт: 1351 замість 1350
#    - Volume names: project2-postgres-data, тощо

# 5. Експорт/імпорт бази як вище

# 6. Запусти
./deploy.sh

# 7. Налаштуй nginx для нового домену
nano /etc/nginx/sites-available/project2.barbitch.cz
# (змінюй server_name та proxy_pass порт)

# 8. SSL
certbot --nginx -d project2.barbitch.cz
```

### 5.2 Приклад docker-compose для project2:

```yaml
version: '3.8'

services:
  postgres:
    container_name: project2-strapi-db  # Змінено!
    image: postgres:15-alpine
    restart: unless-stopped
    env_file: .env
    environment:
      POSTGRES_USER: strapi
      POSTGRES_DB: strapi
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - project2-postgres-data:/var/lib/postgresql/data  # Змінено!
    networks:
      - project2-network  # Змінено!
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U strapi"]
      interval: 10s
      timeout: 5s
      retries: 5

  strapi:
    container_name: project2-strapi  # Змінено!
    build:
      context: .
      dockerfile: Dockerfile
    image: project2-strapi:latest  # Змінено!
    restart: unless-stopped
    env_file: .env
    environment:
      NODE_ENV: production
      HOST: 0.0.0.0
      PORT: 1351  # Змінено! (1350 → 1351)
      DATABASE_CLIENT: postgres
      DATABASE_HOST: postgres
      DATABASE_PORT: 5432
      DATABASE_NAME: strapi
      DATABASE_USERNAME: strapi
      DATABASE_PASSWORD: ${DATABASE_PASSWORD}
      DATABASE_SSL: false
    ports:
      - '1351:1351'  # Змінено!
    volumes:
      - project2-uploads:/opt/app/public/uploads  # Змінено!
    networks:
      - project2-network  # Змінено!
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  project2-postgres-data:  # Змінено!
  project2-uploads:  # Змінено!

networks:
  project2-network:  # Змінено!
    driver: bridge
```

### 5.3 Nginx конфіг для project2:

```nginx
server {
    listen 80;
    server_name project2.barbitch.cz;

    location / {
        proxy_pass http://localhost:1351;  # Змінений порт!
        # ... решта як раніше
    }
}
```

---

## Етап 6: Мігруємо Meilisearch (якщо потрібно)

```bash
# Додай Meilisearch в окремий docker-compose
mkdir -p /opt/meilisearch
cd /opt/meilisearch

# docker-compose.yml
version: '3.8'
services:
  meilisearch:
    image: getmeili/meilisearch:latest
    container_name: meilisearch
    restart: unless-stopped
    ports:
      - '7700:7700'
    environment:
      MEILI_MASTER_KEY: YOUR_MASTER_KEY
    volumes:
      - meilisearch-data:/meili_data

volumes:
  meilisearch-data:

# Запусти
docker-compose up -d
```

---

## Етап 7: Очистка Wedos (після повної міграції)

### ⚠️ Робити тільки коли все працює на Hetzner!

```bash
# На Wedos:
# 1. Зупини всі PM2 процеси
pm2 stop all
pm2 delete all

# 2. Бекап на всякий випадок (ще раз!)
tar -czf /tmp/wedos_full_backup.tar.gz /path/to/all/projects

# 3. Завантаж бекап локально
scp root@WEDOS_IP:/tmp/wedos_full_backup.tar.gz ~/Backups/

# 4. Видали проекти (опціонально)
rm -rf /path/to/strapi/projects

# 5. Скасуй Wedos підписку через панель управління
```

---

## 📊 Чеклист міграції

### Для кожного проекту:

- [ ] Експортував базу даних з Wedos
- [ ] Завантажив бекап на Hetzner
- [ ] Імпортував базу в PostgreSQL
- [ ] Перевірив що всі дані на місці
- [ ] Запустив Strapi на Hetzner
- [ ] Налаштував Nginx + SSL
- [ ] Оновив DNS A-запис
- [ ] Оновив URL у фронтенді
- [ ] Протестував API endpoints
- [ ] Протестував фронтенд
- [ ] Зробив фінальний бекап

### Загальне:

- [ ] Всі 6 Strapi проектів працюють
- [ ] Всі фронтенди підключені
- [ ] Meilisearch мігрований (якщо потрібен)
- [ ] Зроблено повний бекап Wedos
- [ ] Скасовано Wedos підписку

---

## 💰 Економія

**До (Wedos):**
- 6 Strapi проектів + фронтенди + Meilisearch
- VPS ON: 6 GB RAM, 3 vCPU, 60 GB
- **7,874 CZK/рік** (~€315/рік)

**Після (Hetzner):**
- 6 Strapi проектів + Meilisearch
- CPX21: 4 GB RAM, 3 vCPU, 80 GB
- **1,714 CZK/рік** (~€65/рік)
- Фронтенди на Vercel: безкоштовно

**Економія: ~6,160 CZK/рік (~€250/рік)** 💰

---

## 🆘 Проблеми?

### База не імпортується

```bash
# Перевір формат бекапу
head -n 20 /tmp/strapi_backup.sql

# Спробуй з --clean
cat /tmp/strapi_backup.sql | docker exec -i barbitch-strapi-db psql -U strapi -d strapi --clean
```

### Strapi не бачить нову базу

```bash
# Очисти кеш Strapi
docker-compose down
docker volume rm barbitch-strapi-data
docker-compose up -d --build
```

### Конфлікт портів між проектами

Кожен проект повинен мати унікальний порт:
- Project 1: 1350
- Project 2: 1351
- Project 3: 1352
- тощо

---

Успішної міграції! 🚀
