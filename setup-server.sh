#!/bin/bash

# Скрипт для налаштування Hetzner Cloud сервера для Strapi
# Запускати з правами root

set -e

echo "🚀 Починаємо налаштування Hetzner Cloud сервера для Strapi..."

# Оновлюємо систему
echo "📦 Оновлюємо пакети..."
apt-get update
apt-get upgrade -y

# Встановлюємо необхідні пакети
echo "📦 Встановлюємо залежності..."
apt-get install -y \
    curl \
    git \
    nginx \
    certbot \
    python3-certbot-nginx \
    ufw \
    htop \
    ncdu

# Встановлюємо Docker
echo "🐳 Встановлюємо Docker..."
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    rm get-docker.sh
    systemctl enable docker
    systemctl start docker
    echo "✅ Docker встановлено"
else
    echo "✅ Docker вже встановлено"
fi

# Встановлюємо Docker Compose
echo "🐳 Встановлюємо Docker Compose..."
if ! command -v docker-compose &> /dev/null; then
    DOCKER_COMPOSE_VERSION=$(curl -s https://api.github.com/repos/docker/compose/releases/latest | grep 'tag_name' | cut -d\" -f4)
    curl -L "https://github.com/docker/compose/releases/download/${DOCKER_COMPOSE_VERSION}/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
    docker-compose --version
    echo "✅ Docker Compose встановлено"
else
    echo "✅ Docker Compose вже встановлено"
fi

# Налаштовуємо файрвол
echo "🔥 Налаштовуємо UFW файрвол..."
ufw --force enable
ufw allow ssh
ufw allow http
ufw allow https
ufw status
echo "✅ Файрвол налаштовано"

# Налаштовуємо swap (для 4GB RAM)
echo "💾 Налаштовуємо swap..."
if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' | tee -a /etc/fstab
    sysctl vm.swappiness=10
    echo 'vm.swappiness=10' | tee -a /etc/sysctl.conf
    echo "✅ Swap створено (2GB)"
else
    echo "✅ Swap вже існує"
fi

# Створюємо директорію для проекту
echo "📁 Створюємо директорію для проекту..."
mkdir -p /opt/barbitch-strapi
cd /opt/barbitch-strapi

# Налаштовуємо автоматичне оновлення системи
echo "🔄 Налаштовуємо автоматичне оновлення безпеки..."
apt-get install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades

echo ""
echo "✅ Сервер повністю налаштовано!"
echo ""
echo "📝 Наступні кроки:"
echo "1. Клонуй репозиторій: cd /opt/barbitch-strapi && git clone <your-repo-url> ."
echo "2. Створи файл .env з потрібними змінними"
echo "3. Запусти: ./deploy-hetzner.sh"
echo "4. Налаштуй nginx для домену"
echo "5. Встанови SSL: certbot --nginx -d demo-strapi.barbitch.cz"
echo ""
echo "🎉 Готово! Ласкаво просимо на Hetzner Cloud!"
