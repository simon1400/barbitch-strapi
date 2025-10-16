# 🚀 Развертывание Barbitch Strapi на сервере с PM2

## Информация о сервере
- **IP:** 157.90.169.205
- **OS:** Ubuntu 22.04
- **Node, Yarn, NPM, PM2:** Уже установлены
- **База данных:** Supabase PostgreSQL (Transaction Pooler)
- **Порт:** 1350

---

## Часть 1: Подготовка на локальной машине

### 1. Убедись что все изменения сохранены

```bash
cd d:\barbitch\strapi

# Проверь статус git (если используешь)
git status

# Убедись что все файлы на месте
ls -la ecosystem.config.js
ls -la deploy-pm2.sh
ls -la .env.production
```

---

## Часть 2: Остановка Docker на сервере

### 1. Подключись к серверу

```bash
ssh root@157.90.169.205
```

### 2. Останови Docker проект

```bash
# Проверь что работает
docker ps

# Останови docker-compose (если используется)
cd /opt/barbitch-strapi  # или где находится проект
docker-compose down

# Или останови контейнер напрямую
docker stop $(docker ps -q)

# Проверь что порт 1350 свободен
sudo lsof -i :1350
```

**Полная инструкция по остановке Docker:** См. файл [STOP_DOCKER.md](./STOP_DOCKER.md)

---

## Часть 3: Развертывание проекта на сервере

### 1. Создай директорию для проекта

```bash
# Создай директорию
sudo mkdir -p /opt/barbitch-strapi
sudo chown -R $USER:$USER /opt/barbitch-strapi

# Создай директорию для логов PM2
sudo mkdir -p /var/log/pm2
sudo chown -R $USER:$USER /var/log/pm2
```

### 2. Загрузи проект на сервер

**Вариант A: Через Git (рекомендуется)**

```bash
cd /opt/barbitch-strapi

# Клонируй репозиторий
git clone https://github.com/YOUR_USERNAME/barbitch-strapi.git .

# Или pull если уже есть
git pull origin main
```

**Вариант B: Через SCP/SFTP**

С локальной машины:

```bash
# Архивируй проект (без node_modules!)
cd d:\barbitch
tar -czf strapi.tar.gz --exclude=node_modules --exclude=.tmp --exclude=dist strapi/

# Загрузи на сервер
scp strapi.tar.gz root@157.90.169.205:/opt/

# На сервере распакуй
ssh root@157.90.169.205
cd /opt
tar -xzf strapi.tar.gz
mv strapi barbitch-strapi
cd barbitch-strapi
```

### 3. Настрой .env файл на сервере

```bash
cd /opt/barbitch-strapi

# Скопируй production env
cp .env.production .env

# Или создай вручную
nano .env
```

**Вставь следующие данные:**



### 4. Установи зависимости и собери проект

```bash
cd /opt/barbitch-strapi

# Установи зависимости
yarn install

# Собери admin панель
yarn build
```

### 5. Запусти проект через PM2

```bash
cd /opt/barbitch-strapi

# Сделай deploy скрипт исполняемым
chmod +x deploy-pm2.sh

# Запусти через PM2
pm2 start ecosystem.config.js

# Сохрани конфигурацию PM2
pm2 save

# Настрой автозапуск PM2
pm2 startup
# Выполни команду которую выдаст PM2
```

### 6. Проверь что проект работает

```bash
# Статус PM2
pm2 list

# Логи
pm2 logs barbitch-strapi

# Проверь что Strapi отвечает
curl http://localhost:1350
```

---

## Часть 4: Настройка Nginx

### 1. Создай конфигурацию Nginx

```bash
sudo nano /etc/nginx/sites-available/demo-strapi.barbitch.cz
```

**Вставь:**

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

        # Таймауты для админки
        proxy_connect_timeout 600s;
        proxy_send_timeout 600s;
        proxy_read_timeout 600s;

        # Размер загружаемых файлов
        client_max_body_size 100M;
    }
}
```

Сохрани: `Ctrl+O`, `Enter`, `Ctrl+X`

### 2. Активируй конфигурацию

```bash
# Создай симлинк
sudo ln -s /etc/nginx/sites-available/demo-strapi.barbitch.cz /etc/nginx/sites-enabled/

# Проверь конфигурацию
sudo nginx -t

# Перезапусти Nginx
sudo systemctl reload nginx
```

### 3. Проверь доступность

Открой в браузере: http://demo-strapi.barbitch.cz

---

## Часть 5: Установка SSL сертификата

```bash
# Установи Let's Encrypt сертификат
sudo certbot --nginx -d demo-strapi.barbitch.cz

# Следуй инструкциям:
# - Email: твой email
# - Agree to Terms: Yes (Y)
# - Share email: No (N)
# - Redirect HTTP to HTTPS: Yes (2)
```

**Готово!** 🎉

Твой проект доступен на: https://demo-strapi.barbitch.cz

---

## 📝 Полезные команды PM2

### Управление процессом

```bash
# Список процессов
pm2 list

# Логи
pm2 logs barbitch-strapi
pm2 logs barbitch-strapi --lines 100

# Остановить
pm2 stop barbitch-strapi

# Запустить
pm2 start barbitch-strapi

# Перезапустить
pm2 restart barbitch-strapi

# Удалить из PM2
pm2 delete barbitch-strapi

# Мониторинг
pm2 monit
```

### Обновление проекта

```bash
cd /opt/barbitch-strapi

# Pull изменений
git pull origin main

# Или загрузи новые файлы через SCP

# Запусти deploy скрипт
./deploy-pm2.sh
```

### Просмотр логов

```bash
# PM2 логи
pm2 logs barbitch-strapi

# Системные логи
tail -f /var/log/pm2/barbitch-strapi-error.log
tail -f /var/log/pm2/barbitch-strapi-out.log

# Nginx логи
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
```

---

## 🔧 Troubleshooting

### Проблема: Порт занят

```bash
sudo lsof -i :1350
sudo kill -9 PID
pm2 restart barbitch-strapi
```

### Проблема: PM2 не запускается после перезагрузки

```bash
pm2 startup
pm2 save
# Выполни команду которую выдаст PM2
```

### Проблема: База данных не подключается

```bash
# Проверь переменные окружения
cd /opt/barbitch-strapi
cat .env | grep DATABASE

# Проверь подключение к Supabase
psql "postgresql://postgres.scteabivlzjegofvqzwv:ryvgPeEnTQrE2d/@aws-0-eu-central-1.pooler.supabase.com:6543/postgres"
```

### Проблема: 502 Bad Gateway

```bash
# Проверь что Strapi работает
pm2 list
curl http://localhost:1350

# Проверь логи
pm2 logs barbitch-strapi

# Перезапусти
pm2 restart barbitch-strapi
sudo systemctl reload nginx
```

### Проблема: Build падает из-за памяти

```bash
# Увеличь лимит памяти для Node
export NODE_OPTIONS="--max-old-space-size=4096"
yarn build
```

---

## 📊 Проверка работы других проектов на PM2

```bash
# Список всех PM2 процессов
pm2 list

# Если нужно перезапустить другой проект
pm2 restart OTHER_PROJECT_NAME
```

---

## ✅ Чеклист развертывания

- [ ] Остановлен Docker проект
- [ ] Создана директория `/opt/barbitch-strapi`
- [ ] Проект загружен на сервер
- [ ] Файл `.env` настроен с правильными данными
- [ ] Выполнена `yarn install`
- [ ] Выполнена `yarn build`
- [ ] Проект запущен через PM2
- [ ] PM2 сохранен (`pm2 save`)
- [ ] PM2 автозапуск настроен (`pm2 startup`)
- [ ] Nginx конфигурация создана
- [ ] Nginx перезапущен
- [ ] SSL сертификат установлен
- [ ] Сайт доступен по HTTPS
- [ ] Логи проверены (`pm2 logs`)

---

**Успешного деплоя! 🚀**

Если возникнут вопросы - проверь логи: `pm2 logs barbitch-strapi`
