# 🌿 Git Workflow для Oracle Cloud деплоя

## 📋 Структура веток

```
main            - Основная ветка разработки (локальная)
  └── oracleDeploy  - Production ветка для Oracle Cloud
```

---

## 🔄 Workflow

### 1. Разработка (локально)

Все изменения делаются в ветке `main`:

```bash
# Работаем в main
git checkout main

# Делаем изменения
# ... редактируем файлы ...

# Коммитим
git add .
git commit -m "Add new feature"
git push origin main
```

### 2. Подготовка к деплою

Когда готовы к деплою, мерджим изменения в `oracleDeploy`:

```bash
# Переключаемся на production ветку
git checkout oracleDeploy

# Мерджим изменения из main
git merge main

# Пушим в GitHub
git push origin oracleDeploy
```

### 3. Деплой на Oracle Cloud

На сервере Oracle Cloud:

```bash
# SSH подключение к серверу
ssh -i your-key.key ubuntu@YOUR_IP

# Переходим в директорию проекта
cd /opt/barbitch-strapi

# Проверяем что находимся в правильной ветке
git branch

# Если нужно, переключаемся на oracleDeploy
sudo git checkout oracleDeploy

# Запускаем деплой (скрипт автоматически сделает git pull)
sudo ./deploy.sh
```

---

## 🎯 Первоначальная настройка на сервере

### При первом деплое на Oracle Cloud:

```bash
# 1. Клонируем репозиторий
cd /opt/barbitch-strapi
sudo git clone https://github.com/YOUR_USERNAME/barbitch-strapi.git .

# 2. Переключаемся на production ветку
sudo git checkout oracleDeploy

# 3. Проверяем что находимся в правильной ветке
git branch
# Вывод должен быть:
# * oracleDeploy
#   main

# 4. Создаем .env файл
sudo nano .env
# Вставьте production переменные окружения

# 5. Запускаем первый деплой
sudo ./deploy.sh
```

---

## 🔧 Полезные команды

### Проверка текущей ветки

```bash
git branch
# * oracleDeploy  <- текущая ветка отмечена звездочкой
#   main
```

### Просмотр истории

```bash
# Посмотреть последние коммиты
git log --oneline -10

# Сравнить с main
git log main..oracleDeploy --oneline
```

### Откат изменений (если что-то пошло не так)

```bash
# Откатить на предыдущий коммит
sudo git reset --hard HEAD~1

# Откатить на конкретный коммит
sudo git reset --hard <commit-hash>

# Затем пересобрать
sudo ./deploy.sh
```

---

## 📊 Примеры сценариев

### Сценарий 1: Обычное обновление

**Локально:**
```bash
# 1. Разработка в main
git checkout main
# ... делаем изменения ...
git add .
git commit -m "Update feature X"
git push origin main

# 2. Мерджим в production ветку
git checkout oracleDeploy
git merge main
git push origin oracleDeploy
```

**На сервере:**
```bash
# 3. Деплоим на Oracle Cloud
ssh ubuntu@YOUR_IP
cd /opt/barbitch-strapi
sudo ./deploy.sh  # автоматически сделает git pull из oracleDeploy
```

---

### Сценарий 2: Hotfix на production

Если нужно срочно исправить что-то на production:

**Локально:**
```bash
# 1. Переключаемся на oracleDeploy
git checkout oracleDeploy

# 2. Делаем исправление
# ... редактируем файлы ...
git add .
git commit -m "Hotfix: fix critical bug"
git push origin oracleDeploy

# 3. Не забудьте потом смерджить обратно в main!
git checkout main
git merge oracleDeploy
git push origin main
```

**На сервере:**
```bash
sudo ./deploy.sh
```

---

### Сценарий 3: Откат к предыдущей версии

Если новый деплой сломал что-то:

**На сервере:**
```bash
# 1. Смотрим историю
git log --oneline -10

# 2. Откатываемся на рабочую версию
sudo git reset --hard <commit-hash-рабочей-версии>

# 3. Пересобираем
sudo ./deploy.sh
```

**Локально (после того как исправили проблему):**
```bash
# Форсим пуш исправленной версии
git push origin oracleDeploy --force
```

---

## ⚠️ Важные замечания

### ❌ НЕ делайте:

1. **НЕ коммитьте .env файл** с реальными ключами
   - `.env` уже в `.gitignore`
   - Используйте `.env.production.example` как шаблон

2. **НЕ делайте force push без необходимости**
   ```bash
   # ❌ Опасно!
   git push --force
   ```

3. **НЕ работайте напрямую на сервере** (редактирование файлов)
   - Все изменения должны идти через git
   - Иначе при следующем деплое изменения потеряются

### ✅ Делайте:

1. **Всегда проверяйте ветку** перед коммитом
   ```bash
   git branch  # Проверить текущую ветку
   ```

2. **Делайте осмысленные commit сообщения**
   ```bash
   # ✅ Хорошо
   git commit -m "Add user authentication feature"

   # ❌ Плохо
   git commit -m "fix"
   ```

3. **Тестируйте локально** перед пушем в oracleDeploy

---

## 🔐 Работа с .env файлом

### Локально (main ветка)
```bash
# Используем локальную БД или dev БД
DATABASE_HOST=localhost
URL=http://localhost:1350
ADMIN_URL=http://localhost:1350/admin
```

### Production (oracleDeploy ветка на сервере)
```bash
# Используем production БД и домен
DATABASE_HOST=aws-0-eu-central-1.pooler.supabase.com
URL=https://demo-strapi.barbitch.cz
ADMIN_URL=https://demo-strapi.barbitch.cz/admin
STRAPI_ADMIN_BACKEND_URL=https://demo-strapi.barbitch.cz
NODE_ENV=production
```

**Важно:** `.env` файл НЕ коммитится в git!

---

## 📱 Автоматизация (опционально)

### GitHub Actions для автоматического деплоя

Можно настроить автоматический деплой при пуше в `oracleDeploy`:

```yaml
# .github/workflows/deploy.yml
name: Deploy to Oracle Cloud

on:
  push:
    branches:
      - oracleDeploy

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to Oracle Cloud
        uses: appleboy/ssh-action@master
        with:
          host: ${{ secrets.ORACLE_HOST }}
          username: ubuntu
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          script: |
            cd /opt/barbitch-strapi
            sudo ./deploy.sh
```

Но это опционально - можно деплоить вручную.

---

## 🆘 Решение проблем

### Проблема: Конфликты при merge

```bash
# Если возникли конфликты при git merge main
git checkout oracleDeploy
git merge main

# Появились конфликты
# CONFLICT (content): Merge conflict in config/admin.ts

# Решаем конфликты вручную
nano config/admin.ts  # Редактируем файл, удаляем маркеры <<< === >>>

# Коммитим решение
git add .
git commit -m "Resolve merge conflicts"
git push origin oracleDeploy
```

### Проблема: Сервер не видит новые изменения

```bash
# На сервере
cd /opt/barbitch-strapi

# Проверьте что находитесь в правильной ветке
git branch

# Принудительно получите изменения
sudo git fetch origin
sudo git reset --hard origin/oracleDeploy

# Деплой
sudo ./deploy.sh
```

### Проблема: Случайно закоммитили в main вместо oracleDeploy

```bash
# Это нормально! oracleDeploy мерджится из main
# Просто смерджите main в oracleDeploy:
git checkout oracleDeploy
git merge main
git push origin oracleDeploy
```

---

## 📚 Дополнительные ресурсы

- [Основная инструкция деплоя](./ORACLE_CLOUD_SETUP.md)
- [Быстрый старт](./QUICK_START.md)
- [Сводка изменений](./CHANGES_SUMMARY.md)

---

**Следуя этому workflow, вы всегда будете знать какая версия кода где находится!** 🎯
