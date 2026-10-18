// Заметка о клиентке (s267): «сильно толстые ресницы», «аллергия на клей X».
// Одна на карточку, видна на каждой её брони — в отличие от `booking.comment`,
// который живёт у одной записи.
//
// Хранится в старом поле `clients.notes`. Туда же пишут ещё двое:
//   • импорт из Noona (booking-mirror) — заметки персонала из Noona, их показываем;
//   • слияние дублей (client-dedupe.merge) — техническая строка
//     «Sloučeno 2026-09-12: Jméno · mail · telefon (id=123)». Это след для владельца,
//     мастеру и администраторке её не показываем и при правке не теряем.
//
// 🟥 Зеркало этого правила — admin/src/lib/clientNote.ts (поиск клиента читает
// поле REST-ом сырым). Меняешь регулярку — меняй обе.

export const CLIENT_NOTE_MAX = 1000;

const MERGE_LINE_RE = /^Sloučeno \d{4}-\d{2}-\d{2}: .*\(id=\d+\)\s*$/;

const linesOf = (raw: unknown): string[] =>
  typeof raw === 'string' && raw ? raw.replace(/\r\n?/g, '\n').split('\n') : [];

/** Текст заметки для людей: сырое поле без строк слияния дублей; пусто → null. */
export const clientNoteOf = (raw: unknown): string | null => {
  const text = linesOf(raw)
    .filter((l) => !MERGE_LINE_RE.test(l))
    .join('\n')
    .trim();
  return text || null;
};

/**
 * Бронь для календаря: заметка о клиентке поднимается в `clientNote` (её читает
 * шторка брони у всех ролей), сырое `client.notes` из ответа убирается —
 * строки слияния дублей наружу не уходят.
 */
export const withBookingClientNote = <T extends { client?: any }>(b: T): T & { clientNote: string | null } => {
  if (!b || !b.client) return { ...b, clientNote: null };
  const { notes, ...client } = b.client;
  return { ...b, client, clientNote: clientNoteOf(notes) };
};

/**
 * Новое значение сырого поля: заметка людей + прежние строки слияния (в конце).
 * Пустая заметка без строк слияния → null.
 */
export const withClientNote = (raw: unknown, note: unknown): string | null => {
  const text = typeof note === 'string' ? note.replace(/\r\n?/g, '\n').trim() : '';
  const merges = linesOf(raw).filter((l) => MERGE_LINE_RE.test(l));
  const out = [text, ...merges].filter(Boolean).join('\n');
  return out || null;
};
