# 🔄 Миграция домена: demo-strapi.barbitch.cz → strapi.barbitch.cz

## Полная инструкция по переносу на новый домен

---

## Шаг 1: Обнови DNS записи (5 минут)

Зайди в панель управления DNS провайдера barbitch.cz и добавь новую A-запись:

```
Type: A
Host: strapi
Value: 157.90.169.205
TTL: 300
```

Проверь что запись работает (подожди 5-10 минут):

```bash
ping strapi.barbitch.cz
# Должен ответить 157.90.169.205
```

---

## Шаг 2: Обнови Nginx конфигурацию на сервере

### 2.1. Подключись к серверу

```bash
ssh root@157.90.169.205
```

### 2.2. Создай новую Nginx конфигурацию

```bash
sudo nano /etc/nginx/sites-available/strapi.barbitch.cz
```

Вставь следующее:

```nginx
server {
    listen 80;
    server_name strapi.barbitch.cz;

    location / {
        proxy_pass http://localhost:1350;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host $host;
        proxy_cache_bypass $http_upgrade;

        proxy_connect_timeout 600s;
        proxy_send_timeout 600s;
        proxy_read_timeout 600s;

        client_max_body_size 100M;
    }
}
```

Сохрани: `Ctrl+O`, `Enter`, `Ctrl+X`

### 2.3. Активируй конфигурацию

```bash
# Создай симлинк
sudo ln -s /etc/nginx/sites-available/strapi.barbitch.cz /etc/nginx/sites-enabled/

# Проверь конфигурацию
sudo nginx -t

# Перезагрузи Nginx
sudo systemctl reload nginx
```

### 2.4. Проверь доступность

Открой в браузере: http://strapi.barbitch.cz (без HTTPS пока)

---

## Шаг 3: Установи SSL сертификат для нового домена

```bash
# Установи Let's Encrypt сертификат
sudo certbot --nginx -d strapi.barbitch.cz

# Следуй инструкциям:
# - Email: твой email
# - Agree to Terms: Yes (Y)
# - Share email: No (N)
# - Redirect HTTP to HTTPS: Yes (2)
```

После установки проверь: https://strapi.barbitch.cz

---

## Шаг 4: Обнови переменные окружения в проекте

```bash
cd /opt/barbitch-strapi
nano .env
```

Измени строки с URL:

```env
# Было:
URL=https://demo-strapi.barbitch.cz
ADMIN_URL=https://demo-strapi.barbitch.cz/admin

# Стало:
URL=https://strapi.barbitch.cz
ADMIN_URL=https://strapi.barbitch.cz/admin
```

Также обнови PROXY_HOST (если есть):

```env
PROXY_HOST=strapi.barbitch.cz
```

Сохрани: `Ctrl+O`, `Enter`, `Ctrl+X`

---

## Шаг 5: Перезапусти Strapi

```bash
cd /opt/barbitch-strapi

# Перезапусти PM2
pm2 restart barbitch-strapi

# Проверь логи
pm2 logs barbitch-strapi --lines 50
```

Должна появиться строка: `🔒 Proxy mode enabled - trusting X-Forwarded-* headers`

---

## Шаг 6: Проверь что всё работает

### Тесты:

1. **Открой админку:** https://strapi.barbitch.cz/admin
2. **Залогинься** с твоими учётными данными
3. **Проверь API:** https://strapi.barbitch.cz/api/
4. **Проверь медиа:** Загрузи картинку и убедись что Cloudinary работает

---

## Шаг 7: (Опционально) Настрой редирект со старого домена

Если хочешь чтобы старый домен `demo-strapi.barbitch.cz` автоматически перенаправлял на новый:

```bash
sudo nano /etc/nginx/sites-available/demo-strapi.barbitch.cz
```

Добавь в начало файла:

```nginx
server {
    listen 80;
    listen 443 ssl;
    server_name demo-strapi.barbitch.cz;

    ssl_certificate /etc/letsencrypt/live/demo-strapi.barbitch.cz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/demo-strapi.barbitch.cz/privkey.pem;

    return 301 https://strapi.barbitch.cz$request_uri;
}
```

Перезагрузи Nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

---

## Шаг 8: Обнови локальные файлы (для будущих деплоев)

На локальной машине обнови `.env.production.example`:

```bash
cd d:\barbitch\strapi
nano .env.production.example
```

Измени:

```env
URL=https://strapi.barbitch.cz
ADMIN_URL=https://strapi.barbitch.cz/admin
STRAPI_ADMIN_BACKEND_URL=https://strapi.barbitch.cz
PROXY_HOST=strapi.barbitch.cz
```

Закоммить изменения:

```bash
git add .env.production.example
git commit -m "Update production domain to strapi.barbitch.cz"
git push origin hetznerDeploy
```

---

## Шаг 9: (Опционально) Удали старую Nginx конфигурацию

Когда убедишься что всё работает на новом домене:

```bash
# Удали симлинк
sudo rm /etc/nginx/sites-enabled/demo-strapi.barbitch.cz

# Перезагрузи Nginx
sudo systemctl reload nginx
```

---

## ✅ Чеклист миграции

- [ ] DNS запись создана для `strapi.barbitch.cz`
- [ ] Nginx конфигурация создана
- [ ] SSL сертификат установлен
- [ ] `.env` обновлён с новым доменом
- [ ] Strapi перезапущен
- [ ] Админка доступна на новом домене
- [ ] Логин работает
- [ ] API отвечает
- [ ] Медиа загружается
- [ ] Локальные файлы обновлены
- [ ] Старый домен настроен на редирект (опционально)

---

## 🔧 Troubleshooting

### Проблема: DNS не резолвится

```bash
# Проверь DNS
dig strapi.barbitch.cz
nslookup strapi.barbitch.cz

# Подожди 5-10 минут для распространения DNS
```

### Проблема: SSL сертификат не устанавливается

```bash
# Убедись что домен указывает на сервер
ping strapi.barbitch.cz

# Проверь что Nginx слушает на порту 80
sudo netstat -tulpn | grep :80

# Попробуй вручную
sudo certbot certonly --nginx -d strapi.barbitch.cz
```

### Проблема: 502 Bad Gateway

```bash
# Проверь что Strapi работает
pm2 list
curl http://localhost:1350

# Проверь логи
pm2 logs barbitch-strapi
sudo tail -f /var/log/nginx/error.log
```

### Проблема: Не могу залогиниться

```bash
# Убедись что URL в .env правильный
cat /opt/barbitch-strapi/.env | grep URL

# Перезапусти Strapi
pm2 restart barbitch-strapi

# Проверь логи
pm2 logs barbitch-strapi
```

---

## 📝 Примерное время выполнения

- DNS настройка: 2 минуты
- Ожидание DNS: 5-10 минут
- Nginx конфигурация: 3 минуты
- SSL установка: 2 минуты
- Обновление .env: 1 минута
- Перезапуск и проверка: 2 минуты

**Всего: ~15-20 минут**

---

**Успешной миграции! 🚀**
