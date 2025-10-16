# ⚡ Быстрый старт - PM2 деплой

## 🎯 Минимальные команды для деплоя

### На сервере (157.90.169.205)

```bash
# 1. Подключись
ssh root@157.90.169.205

# 2. Останови Docker
docker-compose down
# или
docker stop $(docker ps -q)

# 3. Создай директорию
mkdir -p /opt/barbitch-strapi
cd /opt/barbitch-strapi

# 4. Загрузи файлы (через git или scp)
# Вариант A: Git
git clone https://github.com/YOUR_REPO/barbitch-strapi.git .

# Вариант B: С локальной машины через SCP
# На локале: scp -r d:\barbitch\strapi root@157.90.169.205:/opt/barbitch-strapi

# 5. Настрой .env
nano .env
# Скопируй содержимое из .env.production

# 6. Установи и запусти
yarn install
yarn build
chmod +x deploy-pm2.sh
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # Выполни команду которую выдаст PM2

# 7. Nginx (если еще не настроен)
sudo nano /etc/nginx/sites-available/demo-strapi.barbitch.cz
# Вставь конфиг из PM2_DEPLOY_GUIDE.md
sudo ln -s /etc/nginx/sites-available/demo-strapi.barbitch.cz /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# 8. SSL
sudo certbot --nginx -d demo-strapi.barbitch.cz
```

---

## 📋 Проверка

```bash
pm2 list                    # Проверь статус
pm2 logs barbitch-strapi    # Посмотри логи
curl http://localhost:1350  # Проверь Strapi
```

---

## 🔄 Обновление проекта

```bash
cd /opt/barbitch-strapi
git pull  # или загрузи новые файлы
./deploy-pm2.sh
```

---

## 📚 Полная документация

- **[PM2_DEPLOY_GUIDE.md](./PM2_DEPLOY_GUIDE.md)** - Полная инструкция по развертыванию
- **[STOP_DOCKER.md](./STOP_DOCKER.md)** - Как остановить Docker проект

---

## 🔑 Важные файлы

- `ecosystem.config.js` - PM2 конфигурация
- `.env.production` - Production переменные (шаблон)
- `deploy-pm2.sh` - Скрипт деплоя
- `.env` - Реальные переменные (НЕ коммитить!)

---

## ✅ База данных

Используется **Supabase Transaction Pooler**:
- ✅ IPv4 совместимый
- ✅ Работает с локалки и с сервера
- ✅ Порт: 6543
- ✅ Все данные сохранены

---

**Готово! 🚀**
