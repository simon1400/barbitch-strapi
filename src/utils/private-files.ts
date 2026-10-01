// @ts-nocheck
/**
 * Закрытые файлы на диске сервера (вне репозитория и public/, не медиатека Strapi):
 * сканы документов сотрудников (s224, `STAFF_FILES_DIR`) и чеки затрат (s237,
 * `COST_FILES_DIR`). Вынесено из services/staff.ts — общее у обоих.
 *
 * Правила:
 *   • тип файла — по сигнатуре (JPEG/PNG/WebP/PDF), не по расширению и не по заголовку браузера;
 *   • имя на диске — 32 hex (`storedName`), наружу не отдаётся; имя для показа — `safeFileName`;
 *   • каталог 700, файл 600; запись во временный `.part` → rename (без огрызков при сбое);
 *   • выдача — потоком, только через ручку с проверкой доступа.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const MAX_FILE_NAME = 150;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const STORED_NAME = /^[a-f0-9]{32}$/;

/** Тип файла по сигнатуре (не по расширению и не по заголовку браузера). */
export const detectFile = (head: Buffer | Uint8Array) => {
  const b = Buffer.from(head || []);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg', image: true };
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', ext: 'png', image: true };
  }
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp', image: true };
  }
  if (b.length >= 5 && b.toString('latin1', 0, 5) === '%PDF-') return { mime: 'application/pdf', ext: 'pdf', image: false };
  return null;
};

/** Имя файла для показа: без пути и управляющих символов, с нормальной длиной. */
export const safeFileName = (raw: unknown, ext = '', fallback = 'dokument'): string => {
  let s = String(raw ?? '').split(/[\\/]/).pop() || '';
  s = s.replace(/[\u0000-\u001f\u007f"<>|*?:]/g, '').replace(/\s+/g, ' ').trim();
  if (!s || /^\.+$/.test(s)) s = ext ? `${fallback}.${ext}` : fallback;
  if (s.length > MAX_FILE_NAME) {
    const dot = s.lastIndexOf('.');
    const tail = dot > 0 && s.length - dot <= 6 ? s.slice(dot) : '';
    s = s.slice(0, MAX_FILE_NAME - tail.length) + tail;
  }
  return s;
};

/** Content-Disposition с именем в UTF-8 (чешские и русские буквы). */
export const contentDisposition = (name: string): string => {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
};

/**
 * Каталог из переменной окружения: абсолютный путь, создаётся с 700, а созданный
 * руками (шаг деплоя — mode у mkdir его не касается) поджимается до 700.
 * Нет переменной или путь относительный — `null` (вызывающий отвечает 503).
 */
export const privateDir = async (envValue: unknown, label: string): Promise<string | null> => {
  const dir = String(envValue ?? '').trim();
  if (!dir || !path.isAbsolute(dir)) return null;
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await fs.promises.stat(dir);
  if (st.mode & 0o077) {
    await fs.promises.chmod(dir, 0o700).catch((e) => strapi.log.warn(`${label}: права каталога ${dir} не поджаты: ${e.message}`));
  }
  return dir;
};

/** Первые байты загруженного файла — для `detectFile`. */
export const readHead = async (filepath: string) => {
  const fh = await fs.promises.open(filepath, 'r');
  try {
    const buf = Buffer.alloc(16);
    const { bytesRead } = await fh.read(buf, 0, 16, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
};

/** Копия загруженного файла в каталог: `.part` (600) → rename. Возвращает storedName. */
export const storePrivateFile = async (dir: string, srcPath: string): Promise<{ storedName: string; full: string }> => {
  const storedName = crypto.randomBytes(16).toString('hex');
  const full = path.join(dir, storedName);
  const part = `${full}.part`;
  try {
    await fs.promises.copyFile(srcPath, part);
    await fs.promises.chmod(part, 0o600);
    await fs.promises.rename(part, full);
  } catch (e) {
    await fs.promises.unlink(part).catch(() => {});
    throw e;
  }
  return { storedName, full };
};

/** Поток файла для выдачи; `null` — имени нет или файла на диске нет. */
export const openPrivateFile = async (dir: string, storedName: unknown) => {
  if (!STORED_NAME.test(String(storedName ?? ''))) return null;
  const full = path.join(dir, String(storedName));
  const stat = await fs.promises.stat(full).catch(() => null);
  if (!stat?.isFile()) return null;
  return { stream: fs.createReadStream(full), size: stat.size };
};

/** Удалить файл с диска. Нет файла — не ошибка; прочие сбои — в лог, не наружу. */
export const removePrivateFile = async (dir: string | null, storedName: unknown, what: string): Promise<void> => {
  if (!dir || !STORED_NAME.test(String(storedName ?? ''))) return;
  await fs.promises.unlink(path.join(dir, String(storedName))).catch((e) => {
    if (e?.code !== 'ENOENT') strapi.log.error(`${what} не удалён с диска: ${e.message}`);
  });
};

/** Полный путь к файлу в каталоге и его размер; `null` — имени нет или файла на диске нет. */
export const privateFileStat = async (dir: string, storedName: unknown): Promise<{ full: string; size: number } | null> => {
  if (!STORED_NAME.test(String(storedName ?? ''))) return null;
  const full = path.join(dir, String(storedName));
  const stat = await fs.promises.stat(full).catch(() => null);
  return stat?.isFile() ? { full, size: stat.size } : null;
};
