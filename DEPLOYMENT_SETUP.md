# GitHub Actions Auto-Deploy Setup

Этот репозиторий настроен для автоматического деплоя на продакшн сервер при каждом пуше в ветку `main`.

## Что было настроено:

1. **GitHub Actions Workflow** - файл [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
   - Автоматически запускается при пуше в `main`
   - Подключается к серверу по SSH
   - Выполняет git pull, npm install, npm build
   - Перезапускает PM2 процесс

## Настройка (нужно сделать один раз):

### Шаг 1: Создать SSH ключ для деплоя

На вашем **локальном компьютере** или **сервере** выполните:

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/github_deploy_key
```

Это создаст два файла:
- `~/.ssh/github_deploy_key` - приватный ключ (НЕ показывайте никому!)
- `~/.ssh/github_deploy_key.pub` - публичный ключ

### Шаг 2: Добавить публичный ключ на сервер

На **продакшн сервере** выполните:

```bash
# Войдите на сервер под пользователем, который запускает PM2
ssh your-user@your-server

# Добавьте публичный ключ в authorized_keys
cat >> ~/.ssh/authorized_keys << 'EOF'
# Вставьте сюда содержимое файла github_deploy_key.pub
EOF

# Установите правильные права
chmod 600 ~/.ssh/authorized_keys
```

Или просто скопируйте содержимое `github_deploy_key.pub` и добавьте в `~/.ssh/authorized_keys` на сервере.

### Шаг 3: Добавить Secrets в GitHub

1. Откройте ваш репозиторий на GitHub: https://github.com/simon1400/barbitch-strapi
2. Перейдите в **Settings** → **Secrets and variables** → **Actions**
3. Нажмите **New repository secret** и добавьте следующие секреты:

#### Обязательные секреты:

| Имя секрета | Значение | Описание |
|------------|----------|----------|
| `SERVER_HOST` | IP адрес или домен сервера | Например: `123.45.67.89` или `server.example.com` |
| `SERVER_USER` | Имя пользователя на сервере | Пользователь, под которым запущен PM2 |
| `SERVER_SSH_KEY` | Содержимое файла `github_deploy_key` (приватный ключ) | Весь текст включая `-----BEGIN OPENSSH PRIVATE KEY-----` и `-----END OPENSSH PRIVATE KEY-----` |

#### Опциональные секреты:

| Имя секрета | Значение | Описание |
|------------|----------|----------|
| `SERVER_PORT` | `22` | Порт SSH (по умолчанию 22, если не указан) |

### Шаг 4: Проверка настройки

1. Закоммитьте и запушьте изменения в `main`:
```bash
git add .
git commit -m "Add GitHub Actions auto-deploy"
git push origin main
```

2. Откройте GitHub → ваш репозиторий → вкладка **Actions**
3. Вы увидите запущенный workflow "Deploy to Production"
4. Кликните на него чтобы увидеть логи деплоя в реальном времени

### Шаг 5: Убедиться что на сервере настроен Git

На **продакшн сервере** проверьте:


```bash
cd /opt/barbitch-strapi

# Проверьте что это git репозиторий
git status

# Убедитесь что добавлен remote origin
git remote -v

# Если remote не настроен, добавьте:
git remote add origin git@github.com:simon1400/barbitch-strapi.git
# или через HTTPS:
git remote add origin https://github.com/simon1400/barbitch-strapi.git
```

## Как это работает:

1. Вы делаете изменения в коде локально
2. Коммитите и пушите в ветку `main`:
   ```bash
   git add .
   git commit -m "Update something"
   git push origin main
   ```
3. GitHub Actions автоматически:
   - Подключается к вашему серверу по SSH
   - Делает `git pull` для получения последних изменений
   - Запускает `npm install` для установки зависимостей
   - Запускает `npm run build` для сборки админки
   - Перезапускает PM2 процесс `barbitch-strapi`
4. Готово! Ваш сервер обновлён автоматически

## Мониторинг деплоя:

- **GitHub Actions**: https://github.com/simon1400/barbitch-strapi/actions
- **Логи на сервере**: `pm2 logs barbitch-strapi`

## Безопасность:

- ✅ Приватный SSH ключ хранится только в GitHub Secrets (зашифрован)
- ✅ Публичный ключ на сервере разрешает доступ только для этого ключа
- ✅ Деплой происходит только из ветки `main`
- ✅ Вы можете отозвать доступ в любой момент, удалив публичный ключ с сервера

## Troubleshooting:

### Ошибка: "Permission denied (publickey)"
- Убедитесь что публичный ключ добавлен в `~/.ssh/authorized_keys` на сервере
- Проверьте права: `chmod 600 ~/.ssh/authorized_keys`
- Проверьте что вы используете правильного пользователя в `SERVER_USER`

### Ошибка: "Could not resolve hostname"
- Проверьте что `SERVER_HOST` указан правильно в GitHub Secrets

### Деплой не запускается
- Проверьте что вы пушите в ветку `main` (не `master` или другую)
- Проверьте вкладку Actions на GitHub - там будут логи ошибок

### PM2 процесс не перезапускается
- Войдите на сервер и проверьте: `pm2 list`
- Убедитесь что процесс называется `barbitch-strapi`
- Проверьте логи: `pm2 logs barbitch-strapi`
