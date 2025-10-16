#!/bin/bash

# Скрипт для деплою/оновлення Strapi на Hetzner
# Запускати з директорії проекту

set -e

echo "🚀 Починаємо деплой Strapi на Hetzner..."

# Перевіряємо що знаходимося в правильній директорії
if [ ! -f "docker-compose.yml" ]; then
    echo "❌ Помилка: docker-compose.yml не знайдено"
    echo "Запусти скрипт з директорії проекту"
    exit 1
fi

# Перевіряємо наявність .env файлу
if [ ! -f ".env" ]; then
    echo "❌ Помилка: .env файл не знайдено"
    echo "Створи .env файл з необхідними змінними"
    exit 1
fi

# Перевіряємо що DATABASE_PASSWORD встановлений
if ! grep -q "DATABASE_PASSWORD=" .env; then
    echo "⚠️  УВАГА: Переконайся що DATABASE_PASSWORD встановлений в .env!"
    read -p "Продовжити? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Зупиняємо старі контейнери
echo "🛑 Зупиняємо старі контейнери..."
docker-compose down || true

# Отримуємо останні зміни з git (якщо використовується)
if [ -d ".git" ]; then
    echo "📥 Отримуємо останні зміни з Git..."

    # Перевіряємо поточну гілку
    CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
    echo "ℹ️  Поточна гілка: $CURRENT_BRANCH"

    # Пулимо зміни з поточної гілки
    git pull origin $CURRENT_BRANCH || echo "⚠️  Git pull пропущено"

    echo "✅ Оновлено з гілки: $CURRENT_BRANCH"
fi

# Видаляємо старі Docker образи (економія місця)
echo "🧹 Очищаємо старі Docker образи..."
docker image prune -f || true

# Збираємо новий образ
echo "🔨 Збираємо Docker образ..."
docker-compose build --no-cache

# Запускаємо контейнери
echo "▶️  Запускаємо контейнери..."
docker-compose up -d

# Чекаємо поки Strapi запуститься
echo "⏳ Чекаємо поки Strapi запуститься (це може зайняти 1-2 хвилини)..."
sleep 50

# Перевіряємо статус
echo "🔍 Перевіряємо статус контейнерів..."
docker-compose ps

# Перевіряємо логи
echo ""
echo "📋 Останні логи:"
docker-compose logs --tail=30

# Перевіряємо чи Strapi відповідає
echo ""
echo "🔍 Перевіряємо доступність Strapi..."
sleep 5
if curl -f http://localhost:1350/_health > /dev/null 2>&1; then
    echo "✅ Strapi працює!"
else
    echo "⚠️  Strapi ще запускається або є проблема. Перевір логи:"
    echo "   docker-compose logs -f strapi"
fi

echo ""
echo "✅ Деплой завершено!"
echo ""
echo "🔗 Корисні команди:"
echo "  Логи Strapi:     docker-compose logs -f strapi"
echo "  Логи PostgreSQL: docker-compose logs -f postgres"
echo "  Рестарт:         docker-compose restart"
echo "  Зупинка:         docker-compose down"
echo "  Статус:          docker-compose ps"
echo ""
echo "🌐 Перевір доступність:"
echo "  Локально:  curl http://localhost:1350"
echo "  З домену:  curl http://demo-strapi.barbitch.cz"
echo ""
