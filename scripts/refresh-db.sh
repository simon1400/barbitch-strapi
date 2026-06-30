#!/usr/bin/env bash
# Тянет свежий дамп прод-БД с сервера и разворачивает его в локальный Postgres.
# Секреты НЕ хранятся в этом файле:
#   - пароль прод-БД берётся из /opt/barbitch-strapi/.env прямо на сервере (через SSH);
#   - пароль локального PG читается из strapi/.env.local (он в .gitignore).
# Пропустить обновление: SKIP_DB_REFRESH=1 npm run dev
set -uo pipefail

# подстраховка: добавить бинарники PostgreSQL в PATH (если npm запустил без них)
for PGB in "/c/Program Files/PostgreSQL/17/bin" "/c/Program Files/PostgreSQL/16/bin"; do
  [ -d "$PGB" ] && case ":$PATH:" in *":$PGB:"*) ;; *) PATH="$PGB:$PATH";; esac
done

# ── конфиг прода ──────────────────────────────────────────────
SERVER="root@157.90.169.205"
REMOTE_ENV="/opt/barbitch-strapi/.env"
PROD_DB="barbitch_db"
PROD_USER="barbitch_user"
MIN_DUMP_BYTES=500000   # защита: дамп меньше — считаем битым, локальную БД не трогаем

# ── путь к env-файлу (Strapi грузит .env; .env.local — запасной) ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/../.env" ]; then ENV_FILE="$SCRIPT_DIR/../.env"; else ENV_FILE="$SCRIPT_DIR/../.env.local"; fi

if [ "${SKIP_DB_REFRESH:-0}" = "1" ]; then
  echo "↷ SKIP_DB_REFRESH=1 — пропускаю обновление БД, стартую на текущей локальной копии."
  exit 0
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "✗ Не найден $ENV_FILE" >&2; exit 1
fi

get_env() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\r'; }
LOCAL_DB="$(get_env DATABASE_NAME)"
LOCAL_USER="$(get_env DATABASE_USERNAME)"
LOCAL_PASS="$(get_env DATABASE_PASSWORD)"
LOCAL_HOST="$(get_env DATABASE_HOST)"; LOCAL_HOST="${LOCAL_HOST:-localhost}"
LOCAL_PORT="$(get_env DATABASE_PORT)"; LOCAL_PORT="${LOCAL_PORT:-5432}"

if [ -z "$LOCAL_DB" ] || [ -z "$LOCAL_USER" ]; then
  echo "✗ В $ENV_FILE не заданы DATABASE_NAME/USERNAME" >&2; exit 1
fi
# Пароль локально не обязателен (trust-авторизация для localhost)

DUMP_FILE="$SCRIPT_DIR/_prod-latest.dump"

echo "⤓ Снимаю дамп прод-БД с $SERVER ..."
# pg_dump запускается НА сервере (read-only), пароль берётся из серверного .env, поток → локальный файл
ssh -o ConnectTimeout=15 "$SERVER" \
  "export PGPASSWORD=\$(grep -E '^DATABASE_PASSWORD=' '$REMOTE_ENV' | cut -d= -f2-); \
   pg_dump -h localhost -U '$PROD_USER' -d '$PROD_DB' -F c --no-owner --no-privileges" \
  > "$DUMP_FILE"
SSH_RC=$?

DUMP_SIZE=$(wc -c < "$DUMP_FILE" 2>/dev/null || echo 0)
if [ "$SSH_RC" -ne 0 ] || [ "$DUMP_SIZE" -lt "$MIN_DUMP_BYTES" ]; then
  echo "✗ Дамп не получен (rc=$SSH_RC, size=$DUMP_SIZE). Локальную БД НЕ трогаю — стартую на текущей копии." >&2
  rm -f "$DUMP_FILE"
  exit 0   # не валим запуск: работаем на том, что уже есть локально
fi
echo "✓ Дамп получен: $((DUMP_SIZE/1024)) KB"

[ -n "$LOCAL_PASS" ] && export PGPASSWORD="$LOCAL_PASS"
PG_ARGS=(-h "$LOCAL_HOST" -p "$LOCAL_PORT" -U "$LOCAL_USER")

echo "↻ Пересоздаю локальную БД '$LOCAL_DB' ..."
dropdb "${PG_ARGS[@]}" --if-exists --force "$LOCAL_DB"
createdb "${PG_ARGS[@]}" -O "$LOCAL_USER" "$LOCAL_DB"

echo "⤒ Разворачиваю дамп ..."
pg_restore "${PG_ARGS[@]}" --no-owner --no-privileges -d "$LOCAL_DB" "$DUMP_FILE"
# pg_restore может вернуть ненулевой код на безобидных warning'ах — данные при этом восстановлены
echo "✓ Локальная БД '$LOCAL_DB' обновлена прод-данными."
