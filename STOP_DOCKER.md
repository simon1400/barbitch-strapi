# 🛑 Как остановить Docker проект на сервере

## Быстрые команды для остановки Docker

### 1. Найти запущенные Docker контейнеры

```bash
# Показать все запущенные контейнеры
docker ps

# Показать все контейнеры (включая остановленные)
docker ps -a
```

### 2. Остановить и удалить контейнеры

```bash
# Если используется docker-compose (САМЫЙ ПРОСТОЙ СПОСОБ)
cd /opt/barbitch-strapi  # или где находится docker-compose.yml
docker-compose down

# Остановить и удалить контейнеры + volumes (БД данные тоже удалятся!)
docker-compose down -v

# Остановить конкретный контейнер
docker stop CONTAINER_ID_OR_NAME

# Удалить остановленный контейнер
docker rm CONTAINER_ID_OR_NAME

# Остановить все запущенные контейнеры
docker stop $(docker ps -q)

# Удалить все остановленные контейнеры
docker rm $(docker ps -a -q)
```

### 3. Полная очистка Docker (ОСТОРОЖНО!)

```bash
# Удалить все неиспользуемые контейнеры, образы, volumes
docker system prune -a --volumes

# Или по частям:
docker container prune  # Удалить остановленные контейнеры
docker image prune -a   # Удалить неиспользуемые образы
docker volume prune     # Удалить неиспользуемые volumes
```

### 4. Освободить порты

```bash
# Проверить что занимает порт 1350
sudo lsof -i :1350

# Или через netstat
sudo netstat -tulpn | grep :1350

# Убить процесс на порту
sudo kill -9 PID_NUMBER
```

---

## Пошаговая инструкция для вашего сервера

### Шаг 1: Подключись к серверу

```bash
ssh root@157.90.169.205
```

### Шаг 2: Найди и останови Docker проект

```bash
# Посмотри что работает
docker ps

# Если есть docker-compose.yml
cd /opt/barbitch-strapi  # или другая директория где находится проект
docker-compose down

# Если нет docker-compose, останови контейнер напрямую
docker stop barbitch-strapi  # замени на имя контейнера из docker ps
```

### Шаг 3: Проверь что порт 1350 свободен

```bash
sudo lsof -i :1350
# Если ничего не выводит - порт свободен ✅
```

### Шаг 4: Удали Docker контейнеры (опционально)

```bash
# Удалить контейнер
docker rm barbitch-strapi

# Удалить образ
docker rmi IMAGE_NAME

# Полная очистка
docker system prune -a
```

### Шаг 5: Отключи автозапуск Nginx (если был настроен для Docker)

```bash
# Проверь конфиг Nginx
ls /etc/nginx/sites-enabled/

# Удали старый конфиг (если есть)
sudo rm /etc/nginx/sites-enabled/demo-strapi.barbitch.cz

# Перезагрузи Nginx
sudo systemctl reload nginx
```

---

## Проверка что всё остановлено

```bash
# Docker контейнеры
docker ps  # Должен быть пустой или без вашего проекта

# Порт 1350
sudo lsof -i :1350  # Должен быть пустой

# PM2 процессы
pm2 list  # Должен показывать только другие проекты, не barbitch-strapi
```

---

## Если что-то пошло не так

### Docker не останавливается

```bash
# Форсированная остановка
docker kill CONTAINER_ID

# Перезапуск Docker демона
sudo systemctl restart docker
```

### Порт всё ещё занят

```bash
# Найди процесс
sudo lsof -i :1350

# Убей процесс
sudo kill -9 PID

# Если это Docker
docker stop $(docker ps -q --filter "publish=1350")
```

### Nginx показывает ошибки

```bash
# Проверь конфиг
sudo nginx -t

# Перезапусти Nginx
sudo systemctl restart nginx

# Посмотри логи
sudo tail -f /var/log/nginx/error.log
```

---

## ✅ Готово!

После выполнения этих команд Docker проект будет полностью остановлен, и вы можете развернуть новый проект с PM2.
