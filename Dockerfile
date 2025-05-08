# Используем совместимую версию Node.js
FROM node:20

# Установка рабочей директории
WORKDIR /app

# Копируем package.json и yarn.lock
COPY package.json yarn.lock ./

# Устанавливаем зависимости
RUN yarn install

# Копируем остальные файлы
COPY . .

# Собираем админку Strapi
RUN yarn build

# Указываем порт
EXPOSE 1350

# Запускаем Strapi
CMD ["yarn", "start"]