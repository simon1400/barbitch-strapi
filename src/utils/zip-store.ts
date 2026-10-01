// @ts-nocheck
/**
 * ZIP без сжатия (метод STORE) потоком — «Скачать чеки месяца» (s238, Фаза 3 затрат).
 * Чеки — JPEG/PNG/WebP/PDF, они уже сжаты: deflate почти ничего не даёт, а без него
 * архив собирается без зависимостей и длина известна заранее (Content-Length).
 *
 * Порядок: `planZip` (CRC и размер каждого файла — первым чтением, до заголовков
 * ответа, чтобы ошибка была обычным JSON) → `zipStream` (второе чтение потоком).
 * Имена — UTF-8 (флаг 11), ZIP64 не нужен: общий размер ограничивает вызывающий.
 */

import fs from 'fs';
import { Readable } from 'stream';

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (как в zip/gzip); `prev` — CRC предыдущих кусков того же файла. */
export const crc32 = (buf: Uint8Array, prev = 0): number => {
  let c = (prev ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i += 1) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** Дата записи в формате DOS (полдень того дня); вне 1980–2107 — 01.01.1980. */
export const dosDateTime = (ymd: unknown): { date: number; time: number } => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ''));
  const y = m ? Number(m[1]) : 0;
  if (!m || y < 1980 || y > 2107) return { date: (1 << 5) | 1, time: 12 << 11 };
  return { date: ((y - 1980) << 9) | (Number(m[2]) << 5) | Number(m[3]), time: 12 << 11 };
};

const FLAG_UTF8 = 0x0800;
const VERSION = 20;

const localHeader = (e) => {
  const name = Buffer.from(e.name, 'utf8');
  const b = Buffer.alloc(30);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(VERSION, 4);
  b.writeUInt16LE(FLAG_UTF8, 6);
  b.writeUInt16LE(0, 8); // STORE
  b.writeUInt16LE(e.dos.time, 10);
  b.writeUInt16LE(e.dos.date, 12);
  b.writeUInt32LE(e.crc, 14);
  b.writeUInt32LE(e.size, 18);
  b.writeUInt32LE(e.size, 22);
  b.writeUInt16LE(name.length, 26);
  b.writeUInt16LE(0, 28);
  return Buffer.concat([b, name]);
};

const centralHeader = (e) => {
  const name = Buffer.from(e.name, 'utf8');
  const b = Buffer.alloc(46);
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE(VERSION, 4);
  b.writeUInt16LE(VERSION, 6);
  b.writeUInt16LE(FLAG_UTF8, 8);
  b.writeUInt16LE(0, 10);
  b.writeUInt16LE(e.dos.time, 12);
  b.writeUInt16LE(e.dos.date, 14);
  b.writeUInt32LE(e.crc, 16);
  b.writeUInt32LE(e.size, 20);
  b.writeUInt32LE(e.size, 24);
  b.writeUInt16LE(name.length, 28);
  // extra, comment, disk, internal attrs, external attrs — нули
  b.writeUInt32LE(e.offset, 42);
  return Buffer.concat([b, name]);
};

const endRecord = (count: number, cdSize: number, cdOffset: number) => {
  const b = Buffer.alloc(22);
  b.writeUInt32LE(0x06054b50, 0);
  b.writeUInt16LE(count, 8);
  b.writeUInt16LE(count, 10);
  b.writeUInt32LE(cdSize, 12);
  b.writeUInt32LE(cdOffset, 16);
  return b;
};

/** CRC и размер файла на диске одним чтением. */
export const fileCrc = async (full: string): Promise<{ crc: number; size: number }> => {
  let crc = 0;
  let size = 0;
  for await (const chunk of fs.createReadStream(full)) {
    crc = crc32(chunk, crc);
    size += chunk.length;
  }
  return { crc, size };
};

/**
 * План архива: `items` — `{ name, full, date }` (имена уже уникальные). Возвращает
 * записи со смещениями и итоговую длину архива.
 */
export const planZip = async (items: { name: string; full: string; date?: string }[]) => {
  const entries = [];
  let offset = 0;
  for (const it of items) {
    const { crc, size } = await fileCrc(it.full);
    const e = { name: it.name, full: it.full, crc, size, offset, dos: dosDateTime(it.date) };
    entries.push(e);
    offset += 30 + Buffer.byteLength(it.name, 'utf8') + size;
  }
  const cdSize = entries.reduce((s, e) => s + 46 + Buffer.byteLength(e.name, 'utf8'), 0);
  return { entries, length: offset + cdSize + 22, cdOffset: offset, cdSize };
};

/** Архив потоком по плану. Файл изменился между чтениями — поток обрывается ошибкой. */
export const zipStream = (plan: Awaited<ReturnType<typeof planZip>>): Readable => {
  async function* gen() {
    for (const e of plan.entries) {
      yield localHeader(e);
      let size = 0;
      for await (const chunk of fs.createReadStream(e.full)) {
        size += chunk.length;
        yield chunk;
      }
      if (size !== e.size) throw new Error(`zip: файл ${e.name} изменился во время выдачи`);
    }
    yield Buffer.concat(plan.entries.map(centralHeader));
    yield endRecord(plan.entries.length, plan.cdSize, plan.cdOffset);
  }
  return Readable.from(gen(), { objectMode: false });
};
