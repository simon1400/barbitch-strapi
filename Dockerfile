# Используем совместимую версию Node.js
FROM node:18.19.0

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
EXPOSE 1337

# Запускаем Strapi
CMD ["yarn", "start"]