# Используем Node.js 20 Alpine для меньшего размера
FROM node:20-alpine

# Устанавливаем зависимости для сборки
RUN apk update && apk add --no-cache \
    build-base \
    gcc \
    autoconf \
    automake \
    zlib-dev \
    libpng-dev \
    vips-dev \
    git

# Устанавливаем рабочую директорию
WORKDIR /opt/app

# Копируем package.json и package-lock.json
COPY package*.json ./

# Устанавливаем зависимости
RUN npm ci --only=production

# Копируем все файлы проекта
COPY . .

# Переменные окружения для сборки
ENV NODE_ENV=production

# Собираем Strapi
RUN npm run build

# Открываем порт
EXPOSE 1350

# Запускаем Strapi
CMD ["npm", "run", "start"]
