# Barbitch Strapi Backend

CMS backend для проекта Barbitch на Strapi v5.

## 🚀 Быстрый старт (локально)

### Требования
- Node.js 20.x
- npm >= 9.0.0

### Установка

```bash
# Установка зависимостей
npm install

# Создайте .env файл
cp .env.example .env
# Заполните переменные окружения

# Запуск в режиме разработки
npm run dev
```

Админка будет доступна на: http://localhost:1350/admin

## 📦 Основные команды

```bash
npm run dev        # Запуск в режиме разработки
npm run build      # Сборка для production
npm run start      # Запуск production сервера
```

## 🌐 Деплой на Hetzner Cloud

Полные инструкции:
- **[HETZNER_QUICK_START.md](./HETZNER_QUICK_START.md)** - Швидкий старт за 15 хвилин
- **[HETZNER_SETUP.md](./HETZNER_SETUP.md)** - Повна детальна інструкція
- **[migrate-from-wedos.md](./migrate-from-wedos.md)** - Міграція з Wedos

### Швидкий деплой

1. Створіть VPS на Hetzner Cloud (CPX21, €5.39/міс)
2. Підключіться до сервера та налаштуйте оточення:
   ```bash
   ./setup-server.sh
   ```
3. Клонуйте репозиторій:
   ```bash
   cd /opt/barbitch-strapi
   git clone <your-repo-url> .
   ```
4. Створіть `.env` файл з production змінними
5. Запустіть деплой:
   ```bash
   ./deploy.sh
   ```
6. Налаштуйте Nginx та SSL (дивись [HETZNER_SETUP.md](./HETZNER_SETUP.md))

## 🗂️ Структура проекта

```
strapi/
├── config/              # Конфигурация Strapi
│   ├── admin.ts        # Настройки админки
│   ├── api.ts          # API конфигурация
│   ├── database.ts     # Подключение к БД
│   ├── middlewares.ts  # Middleware (CORS, Security)
│   ├── plugins.ts      # Настройка плагинов
│   └── server.ts       # Серверные настройки
├── src/
│   ├── api/            # Content Types и API
│   ├── components/     # Переиспользуемые компоненты
│   ├── extensions/     # Расширения плагинов
│   └── index.ts        # Точка входа
├── Dockerfile          # Docker образ для деплоя
├── docker-compose.yml  # Docker Compose конфигурация
├── nginx.conf          # Конфигурация nginx для production
├── setup-server.sh     # Скрипт установки на сервер
└── deploy.sh           # Скрипт деплоя/обновления
```

## 🔌 Установленные плагины

- **CKEditor** - Расширенный текстовый редактор
- **Color Picker** - Выбор цвета
- **Cloudinary Provider** - Хранение файлов в Cloudinary
- **GPT Plugin** - Интеграция с OpenAI
- **Responsive Backend** - Адаптивные поля
- **Required Relation Field** - Обязательные связи

## 🗄️ База даних

**Production:** PostgreSQL в Docker контейнері

**Локальна розробка:** SQLite або підключення до тієї ж БД

## 🔐 Переменные окружения

Пример переменных окружения в `.env.production.example`.

**Важно:** Ключи `APP_KEYS`, `ADMIN_JWT_SECRET`, `JWT_SECRET` и т.д. должны быть **одинаковыми** на всех окружениях, иначе авторизация не будет работать!

## 📝 Content Types

Проект включает следующие типы контента:
- Articles (Статьи)
- Blog
- Clients (Клиенты)
- Cash (Касса)
- Offers (Предложения)
- и другие...

Полный список в `src/api/`

## 🛠️ Разработка

### Создание нового Content Type

```bash
npm run strapi generate
# Выберите: api
# Следуйте инструкциям
```

### Перегляд логів (production)

```bash
docker-compose logs -f
```

## 🔄 Оновлення

### Локально

```bash
git pull origin main
npm install
npm run build
npm run dev
```

### Production (Hetzner)

```bash
cd /opt/barbitch-strapi
git pull origin main
./deploy.sh
```

## 🆘 Проблемы и решения

### Ошибка авторизации в админке

Проверьте что:
1. Переменные `ADMIN_JWT_SECRET`, `JWT_SECRET`, `APP_KEYS` одинаковые локально и на production
2. `ADMIN_URL` и `STRAPI_ADMIN_BACKEND_URL` правильно настроены
3. База данных доступна

### 502 Bad Gateway

```bash
# Перевірте логи
docker-compose logs

# Перезапустіть контейнер
docker-compose restart
```

### Не можу завантажити файли

Перевірте налаштування Cloudinary в `.env`:
- `CLOUDINARY_NAME`
- `CLOUDINARY_KEY`
- `CLOUDINARY_SECRET`

## 📚 Документація

- [Strapi Documentation](https://docs.strapi.io)
- [Hetzner Quick Start](./HETZNER_QUICK_START.md) - Швидкий старт
- [Hetzner Setup Guide](./HETZNER_SETUP.md) - Повна інструкція
- [Міграція з Wedos](./migrate-from-wedos.md) - Як перенести проекти

---

## 🚀 Getting started with Strapi

Strapi comes with a full featured [Command Line Interface](https://docs.strapi.io/dev-docs/cli) (CLI) which lets you scaffold and manage your project in seconds.

### `develop`

Start your Strapi application with autoReload enabled. [Learn more](https://docs.strapi.io/dev-docs/cli#strapi-develop)

```
npm run develop
```

### `start`

Start your Strapi application with autoReload disabled. [Learn more](https://docs.strapi.io/dev-docs/cli#strapi-start)

```
npm run start
```

### `build`

Build your admin panel. [Learn more](https://docs.strapi.io/dev-docs/cli#strapi-build)

```
npm run build
```

## ✨ Community

- [Discord](https://discord.strapi.io) - Come chat with the Strapi community including the core team.
- [Forum](https://forum.strapi.io/) - Place to discuss, ask questions and find answers, show your Strapi project and get feedback or just talk with other Community members.
- [Awesome Strapi](https://github.com/strapi/awesome-strapi) - A curated list of awesome things related to Strapi.
