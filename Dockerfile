FROM node:18

WORKDIR /app
COPY . .

RUN npm ci
RUN npm run build

EXPOSE 1337
CMD ["npm", "start"]