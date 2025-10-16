# 📁 Структура проекту Barbitch Strapi

## 🎯 Два типи проектів

### 1️⃣ Тестовий проект (цей)
- **Назва:** demo-strapi.barbitch.cz
- **База даних:** Supabase (зовнішня)
- **Медіа:** Cloudinary
- **Docker Compose:** `docker-compose.yml`
- **Env приклад:** `.env.example`

### 2️⃣ Production проекти (міграція з Wedos)
- **6 проектів** з локальною базою
- **База даних:** PostgreSQL в Docker
- **Медіа:** Cloudinary
- **Docker Compose:** `docker-compose.postgres.yml`
- **Env приклад:** `.env.postgres.example`

---

## 📂 Файли проекту

```
strapi/
│
├── 📘 Документація
│   ├── README.md                      # Загальна документація
│   ├── QUICK_DEPLOY.md                # 🆕 Швидкий деплой тестового проекту
│   ├── HETZNER_SETUP.md               # Повна інструкція Hetzner
│   ├── HETZNER_QUICK_START.md         # Швидкий старт
│   ├── HETZNER_FILES_INFO.md          # Опис файлів
│   ├── migrate-from-wedos.md          # Міграція 6 проектів з Wedos
│   ├── PROJECT_STRUCTURE.md           # 🆕 Цей файл
│   ├── CLEANUP_SUMMARY.md             # Звіт про очищення
│   └── GIT_WORKFLOW.md                # Git інструкції
│
├── 🐳 Docker (тестовий проект з Supabase)
│   ├── docker-compose.yml             # 🆕 Supabase + Cloudinary (БЕЗ PostgreSQL!)
│   └── Dockerfile                     # Strapi образ
│
├── 🐳 Docker (для міграції з Wedos)
│   └── docker-compose.postgres.yml    # 🆕 PostgreSQL + Strapi (для інших проектів)
│
├── 🔧 Скрипти
│   ├── setup-server.sh                # Налаштування Hetzner
│   └── deploy.sh                      # 🆕 Деплой (оновлено для Supabase)
│
├── ⚙️ Конфігурація
│   ├── .env.example                   # 🆕 Приклад для Supabase (тестовий)
│   ├── .env.postgres.example          # 🆕 Приклад для PostgreSQL (інші проекти)
│   ├── .gitignore
│   ├── package.json
│   └── tsconfig.json
│
└── 📂 Код Strapi
    └── src/                           # Весь код Strapi
```

---

## 🚀 Як використовувати

### Тестовий проект (зараз):

```bash
# Використовує Supabase
docker-compose up -d

# Або
./deploy.sh
```

**Швидкий старт:** Дивись [QUICK_DEPLOY.md](./QUICK_DEPLOY.md)

---

### Production проекти (потім, після міграції з Wedos):

```bash
# Використовує локальну PostgreSQL
docker-compose -f docker-compose.postgres.yml up -d

# З іншим портом та іменем
PROJECT_NAME=project2 PORT=1351 docker-compose -f docker-compose.postgres.yml up -d
```

**Детальна інструкція:** Дивись [migrate-from-wedos.md](./migrate-from-wedos.md)

---

## 🔄 Відмінності

| Параметр | Тестовий (Supabase) | Production (PostgreSQL) |
|----------|---------------------|-------------------------|
| **Docker Compose** | `docker-compose.yml` | `docker-compose.postgres.yml` |
| **База даних** | Supabase (зовнішня) | PostgreSQL в Docker |
| **Медіа** | Cloudinary | Cloudinary |
| **Env приклад** | `.env.example` | `.env.postgres.example` |
| **Порт** | 1350 | 1351, 1352, тощо |
| **Проектів** | 1 | 6 |

---

## 💡 Для чого два Docker Compose?

### `docker-compose.yml` (Supabase)
✅ Простіший - тільки Strapi контейнер
✅ Швидший старт
✅ Не треба налаштовувати PostgreSQL
✅ Для тестування та розробки

### `docker-compose.postgres.yml` (PostgreSQL)
✅ Повна ізоляція - база в Docker
✅ Підтримка кількох проектів
✅ Легка міграція з Wedos
✅ Для production проектів

---

## 📝 Порядок дій

### 1. Зараз: Тестовий проект
```bash
# Використай QUICK_DEPLOY.md
# Deплой на Hetzner з Supabase
# Тестування та налагодження
```

### 2. Потім: Міграція з Wedos
```bash
# Використай migrate-from-wedos.md
# Експорт баз з Wedos
# Імпорт в PostgreSQL на Hetzner
# Налаштування кожного проекту з docker-compose.postgres.yml
```

---

## ✅ Готово!

Всі файли підготовлені для обох сценаріїв:
- ✅ Тестовий проект з Supabase (швидко стартувати)
- ✅ Production проекти з PostgreSQL (для міграції потім)

**Почни з [QUICK_DEPLOY.md](./QUICK_DEPLOY.md)** для тестового проекту! 🚀
