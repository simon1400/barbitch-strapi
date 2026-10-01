// @ts-nocheck
/**
 * Карточка сотрудника (s224, план STAFF_CARD_NEXT_SESSION_PROMPT.md, шаги 2–3).
 * Раньше карточка `personal` и её личные данные велись только в Strapi CM, а прямой
 * REST из админки мог писать процент и ставку (закрыто в s223, admin-session).
 *
 * Здесь — чтение и запись карточки руководством (owner + manager, гейт в контроллере):
 *   - список (без личных данных) с признаками «чего не хватает»;
 *   - карточка (без личных данных) + учётка без пароля, заметки, история правок;
 *   - личные данные и документы — ОТДЕЛЬНОЙ ручкой: в браузер они едут только при
 *     раскрытии секции. Ключ ответа — `private`, не `oficial`: admin-session вырезает
 *     ключ `oficial` из любого ответа сессии сотрудника (s221);
 *   - запись секций `basic` / `booking` / `pay` / `private`, новая ставка «с даты»,
 *     файлы (фото — в медиатеку/ImageKit, оно публичное; сканы — в закрытый каталог
 *     STAFF_FILES_DIR, выдача потоком только сюда), заметки руководства.
 *
 * 🟥 Владелец скрыт от управляющей: карточка с именем учётки роли `owner` в её список
 * не попадает, по id — 404 (на проде у владельцев карточек нет, но код держит правило).
 *
 * Две версии карточки: пишем черновик (`update`) и сразу публикуем — как кнопка Publish
 * и как уже делают каталог, «Pořadí» и приоритет (REST `PUT ?status=published`).
 * Публикация пересоздаёт опубликованную строку — связи других коллекций Strapi
 * перепривязывает сам. Компоненты: `oficial` правится С `id` (на месте);
 * `rates` пишутся целым массивом, существующие записи — со своими `id`.
 *
 * Защита от одновременной правки: клиент шлёт `base` = updatedAt черновика, от которого
 * правил; не совпало — 409. Журнал — calendar_logs, entityType `staff`. 🟥 Значения
 * личных данных в журнал не пишутся — только названия изменённых полей.
 *
 * Шаг 4 (s225): новый сотрудник (+ учётка), учётка из карточки (создать / отключить /
 * включить / сбросить пароль), переименование (карточка + логин одним действием),
 * «Завершить работу» (предпросмотр и действие), стирание личных данных через 3 года
 * после ухода. Пароль генерирует сервер и отдаёт ОДИН раз; в журнал он не пишется.
 *
 * Верх файла — чистые функции (tests/staff.test.mjs), ниже — сервис.
 */

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { invalidateAdminAccount } from '../../../utils/admin-account';
import { findSessionPersonal } from '../../../utils/staff-identity';
import {
  MAX_FILE_BYTES,
  STORED_NAME,
  contentDisposition,
  detectFile,
  openPrivateFile,
  privateDir,
  readHead,
  removePrivateFile,
  safeFileName,
  storePrivateFile,
} from '../../../utils/private-files';
import { minToHHMM, pragueDateOf, pragueMinOf } from './slots-core';

const PERSONAL_UID = 'api::personal.personal';
const ADMIN_UID = 'api::admin-user.admin-user';
const DOC_UID = 'api::staff-document.staff-document';
const NOTE_UID = 'api::staff-note.staff-note';
const SCHEDULE_UID = 'api::master-schedule.master-schedule';
const TIME_OFF_UID = 'api::time-off.time-off';
const BOOKING_UID = 'api::booking.booking';
const LOG_UID = 'api::calendar-log.calendar-log';
const TIME_BLOCK_UID = 'api::time-block.time-block';
const CHECKLIST_UID = 'api::staff-checklist-item.staff-checklist-item';
const PLAN_KEY_PREFIX = 'own|plan|'; // как master-schedule.ts: блоки плана `own|plan|<personal.documentId>`

export class StaffError extends Error {
  status: number;
  code: string;
  details: any;
  constructor(status: number, code: string, message: string, details: any = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const POSITIONS = { master: 'mistr', administrator: 'administrátor', manager: 'manažerka' } as const;
export const TIERS = { senior: 'senior', junior: 'junior' } as const;
/** Роль входа по должности (решение владельца s222): меняется вместе с должностью, owner не трогается. */
export const ROLE_BY_POSITION = { master: 'master', administrator: 'administrator', manager: 'manager' } as const;

/** Типы документов — enum `staff-document.kind`. */
export const DOC_KINDS = {
  passport: 'Pas',
  residence: 'Povolení k pobytu',
  health: 'Zdravotní průkaz',
  contract: 'Smlouva',
  license: 'Živnostenský list',
  other: 'Jiný doklad',
} as const;

/** Личные данные: 7 полей прода (по ним «данные не заполнены») + 3 новых (§3.10). */
export const PRIVATE_FIELDS = {
  name: { cs: 'oficiální jméno', core: true },
  dateBirth: { cs: 'datum narození', core: true },
  addressInCz: { cs: 'adresa v ČR', core: true },
  addressInHome: { cs: 'adresa doma', core: true },
  documentNumber: { cs: 'číslo dokladu', core: true },
  phone: { cs: 'telefon', core: true },
  email: { cs: 'e-mail', core: true },
  bankAccount: { cs: 'číslo účtu', core: false },
  emergencyName: { cs: 'nouzový kontakt', core: false },
  emergencyPhone: { cs: 'telefon nouzového kontaktu', core: false },
} as const;
const PRIVATE_KEYS = Object.keys(PRIVATE_FIELDS);
export const CORE_PRIVATE_KEYS = PRIVATE_KEYS.filter((k) => PRIVATE_FIELDS[k].core);

export const MAX_TEXT = 200;
export const MAX_TITLE = 120;
export const MAX_NOTE = 2000;
// файлы — общие помощники закрытого хранилища (s237, utils/private-files.ts)
export { MAX_FILE_BYTES, MAX_FILE_NAME, contentDisposition, detectFile, safeFileName } from '../../../utils/private-files';
export const RATE_MAX = 1_000_000;
export const HOURLY_MAX = 10_000;
export const THRESHOLD_MAX = 1_000_000;
export const PRIORITY_MIN = -1000;
export const PRIORITY_MAX = 1000;
export const MIN_HIRED = '2015-01-01';
export const MIN_BIRTH_YEAR = 1940;
export const MIN_AGE = 14;
export const MAX_FUTURE_DAYS = 366;
export const HISTORY_LIMIT = 50;
export const NAME_MIN = 2;
export const NAME_MAX = 60;
export const PASSWORD_LENGTH = 12;
export const ERASE_AFTER_YEARS = 3;

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const DMY = /^\s*(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{4})\s*$/;
const DOC_ID = /^[a-z0-9]{10,40}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^\+\d{8,15}$/;

const hasOwn = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

const isPlain = (v: unknown): boolean => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

export const isValidYmd = (s: unknown): boolean => {
  const v = String(s ?? '');
  if (!YMD.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

export const addDaysYmd = (ymd: string, days: number): string => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

const ymdOf = (v: unknown): string | null => (v ? String(v).slice(0, 10) : null);
export const fmtDay = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}`;

/** Пробелы схлопнуты и обрезаны. */
export const cleanText = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim();

const lower = (v: unknown) => cleanText(v).toLowerCase();

/** Ушедший: карточка неактивна или служебная «❌» в имени (как lib/personals админки). */
export const isLeft = (p: any): boolean => p?.isActive === false || String(p?.name ?? '').includes('❌');

/** Карточка скрыта от сессии: владельца видит только владелец. */
export const hiddenFromSession = (name: unknown, ownerNames: Set<string>, role: unknown): boolean =>
  role !== 'owner' && ownerNames.has(lower(name));

/**
 * Учётка карточки (s229, §5а.1): сначала по связи `personalDocId`; у учёток без связи —
 * по имени (прежний инвариант username = personals.name, память master-rename-invariant).
 * Учётка, связанная с ДРУГОЙ карточкой, по совпадению имени не берётся.
 */
export const accountForCard = (card: { documentId?: unknown; name?: unknown } | null, accounts: any[]) => {
  const docId = cleanText(card?.documentId);
  if (docId) {
    const linked = accounts.find((a) => cleanText(a.personalDocId) === docId);
    if (linked) return linked;
  }
  const key = lower(card?.name);
  return key ? accounts.find((a) => !cleanText(a.personalDocId) && lower(a.username) === key) || null : null;
};

/**
 * Карточка — это сессия (s229): по связи учётки из базы (`sessionFromCtx`); без связи —
 * по id учётки карточки, а если учётки нет — по имени, как до s229.
 */
export const isSelfCard = (session: any, card: { documentId?: unknown; name?: unknown }, account: any): boolean => {
  const own = cleanText(session?.personalDocId);
  if (own) return own === cleanText(card?.documentId);
  if (account) return Number(account.id) === Number(session?.id);
  return lower(session?.username) === lower(card?.name);
};

// Телефон → канонический вид: +<код><номер>; 9 цифр без кода → чешский +420.
// Как normalizePhone движка (booking-engine.ts) — здесь своя копия, чтобы сервис
// не тянул модуль движка целиком.
export const normalizePhone = (raw): string => {
  let s = String(raw || '').replace(/[\s\-().]/g, '');
  if (!s) return '';
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (!s.startsWith('+')) {
    const digits = s.replace(/\D/g, '');
    s = digits.length === 9 ? `+420${digits}` : digits ? `+${digits}` : '';
  }
  return s;
};

const isRealDate = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

/**
 * Дата рождения для записи: «ГГГГ-ММ-ДД» (поле даты) или «ДД.ММ.ГГГГ» → строка
 * `ДД.ММ.ГГГГ` — так её хранит прод и так читает модуль дней рождения (s221).
 * Пустая строка — стереть.
 */
export const birthToStore = (raw: unknown, todayYear: number): string => {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  let y: number, m: number, d: number;
  const dmy = DMY.exec(s);
  if (dmy) [d, m, y] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];
  else if (YMD.test(s)) [y, m, d] = s.split('-').map(Number);
  else throw new StaffError(400, 'bad_birth', 'Дата рождения — ДД.ММ.ГГГГ');
  if (!isRealDate(y, m, d)) throw new StaffError(400, 'bad_birth', 'Такой даты нет');
  if (y < MIN_BIRTH_YEAR || y > todayYear - MIN_AGE) {
    throw new StaffError(400, 'bad_birth', 'Проверьте год рождения');
  }
  return `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}`;
};

/** Хранимая строка → «ГГГГ-ММ-ДД» для поля даты; не распознана — null (показать как есть). */
export const birthToYmd = (stored: unknown): string | null => {
  const s = String(stored ?? '').trim();
  const dmy = DMY.exec(s);
  if (dmy) {
    const [d, m, y] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];
    return isRealDate(y, m, d) ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
  }
  return isValidYmd(s) ? s : null;
};

/** Незаполненные поля из 7 основных (ключи, без значений). */
export const privateMissing = (oficial: any): string[] =>
  CORE_PRIVATE_KEYS.filter((k) => !cleanText(oficial?.[k]));

/** Текущие значения личных данных — только известные поля, строки. */
export const pickPrivate = (oficial: any) => {
  const out: Record<string, string> = {};
  for (const k of PRIVATE_KEYS) out[k] = oficial?.[k] == null ? '' : String(oficial[k]);
  return out;
};

const asString = (v: unknown, key: string): string => {
  if (v == null) return '';
  if (typeof v !== 'string' && typeof v !== 'number') {
    throw new StaffError(400, 'bad_field', `Поле ${key}: ожидается текст`);
  }
  return String(v);
};

/**
 * Секция «Личные данные». Меняются только присланные поля, остальные берутся из
 * текущих. Лишний ключ (в т.ч. `documents` — сканы пишутся только ручкой файлов) — 400.
 * Возвращает полный набор полей и список изменённых ключей.
 */
export const normalizePrivate = (data: any, current: any, todayYear: number) => {
  if (!isPlain(data)) throw new StaffError(400, 'bad_data', 'Нет данных для сохранения');
  const keys = Object.keys(data);
  if (!keys.length) throw new StaffError(400, 'nothing_to_save', 'Нет данных для сохранения');
  for (const k of keys) {
    if (!hasOwn(PRIVATE_FIELDS, k)) throw new StaffError(400, 'bad_field', `Неизвестное поле: ${k}`);
  }
  const cur = pickPrivate(current);
  const next = { ...cur };
  for (const k of keys) {
    const raw = asString(data[k], k);
    let v: string;
    if (k === 'dateBirth') v = birthToStore(raw, todayYear);
    else if (k === 'phone' || k === 'emergencyPhone') {
      v = normalizePhone(raw);
      if (v && !PHONE.test(v)) throw new StaffError(400, 'bad_phone', `${PRIVATE_FIELDS[k].cs}: неверный номер`);
    } else if (k === 'email') {
      v = raw.trim().toLowerCase();
      if (v && (!EMAIL.test(v) || v.length > MAX_TEXT)) throw new StaffError(400, 'bad_email', 'Неверный e-mail');
    } else if (k === 'bankAccount') {
      v = cleanText(raw).toUpperCase();
      if (v && !/^[0-9A-Z/ -]{5,40}$/.test(v)) throw new StaffError(400, 'bad_bank', 'Номер счёта — цифры, «-», «/» или IBAN');
    } else {
      v = cleanText(raw);
      if (v.length > MAX_TEXT) throw new StaffError(400, 'too_long', `${PRIVATE_FIELDS[k].cs}: не длиннее ${MAX_TEXT} символов`);
    }
    next[k] = v;
  }
  const changed = PRIVATE_KEYS.filter((k) => next[k] !== cur[k]);
  return { next, changed };
};

/** Целое в границах: число или строка из цифр. */
const intIn = (v: unknown, min: number, max: number, code: string, label: string): number => {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (!/^-?\d+$/.test(s)) throw new StaffError(400, code, `${label}: целое число`);
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new StaffError(400, code, `${label}: от ${min} до ${max}`);
  return n;
};

const onlyKeys = (data: any, allowed: string[]) => {
  if (!isPlain(data)) throw new StaffError(400, 'bad_data', 'Нет данных для сохранения');
  const keys = Object.keys(data);
  if (!keys.length) throw new StaffError(400, 'nothing_to_save', 'Нет данных для сохранения');
  for (const k of keys) if (!allowed.includes(k)) throw new StaffError(400, 'bad_field', `Поле ${k} в этой секции не меняется`);
  return keys;
};

/**
 * Секция «Основное»: должность, уровень (junior/senior), дата приёма.
 * Имя — отдельным действием «Переименовать», активность — «Завершить работу» (шаг 4).
 * Возвращает patch и список изменений [{key, from, to}].
 */
export const normalizeBasic = (data: any, current: any, today: string) => {
  const keys = onlyKeys(data, ['position', 'tier', 'hiredAt', 'leftAt']);
  const patch: Record<string, any> = {};
  if (keys.includes('position')) {
    const v = String(data.position ?? '');
    if (!hasOwn(POSITIONS, v)) throw new StaffError(400, 'bad_position', 'Неизвестная должность');
    patch.position = v;
  }
  if (keys.includes('tier')) {
    const v = String(data.tier ?? '');
    if (!hasOwn(TIERS, v)) throw new StaffError(400, 'bad_tier', 'Уровень — senior или junior');
    patch.tier = v;
  }
  if (keys.includes('hiredAt')) {
    const raw = data.hiredAt;
    if (raw == null || raw === '') patch.hiredAt = null;
    else {
      const v = String(raw).trim();
      if (!isValidYmd(v)) throw new StaffError(400, 'bad_date', 'Дата в формате ГГГГ-ММ-ДД');
      if (v < MIN_HIRED || v > addDaysYmd(today, MAX_FUTURE_DAYS)) throw new StaffError(400, 'bad_date', 'Проверьте дату приёма');
      patch.hiredAt = v;
    }
  }
  // Дата ухода — только у уже ушедших (s227): до модуля карточки уход ставили в панели,
  // `leftAt` у них пуст, и без даты не сработает стирание через 3 года (§8.2).
  // Работающему уход ставится действием «Завершить работу» (ставки, учётка, план).
  if (keys.includes('leftAt')) {
    if (!isLeft(current)) throw new StaffError(409, 'staff_not_left', 'Дата ухода ставится действием «Завершить работу»');
    if (data.leftAt == null || data.leftAt === '') throw new StaffError(400, 'bad_date', 'Укажите дату ухода');
    const hired = hasOwn(patch, 'hiredAt') ? patch.hiredAt : ymdOf(current?.hiredAt);
    patch.leftAt = normalizeLeftAt(data.leftAt, hired, today);
  } else if (patch.hiredAt && ymdOf(current?.leftAt) && patch.hiredAt > ymdOf(current?.leftAt)) {
    throw new StaffError(400, 'bad_date', 'Дата приёма позже даты ухода');
  }
  const before = (k: string) =>
    k === 'hiredAt' || k === 'leftAt' ? ymdOf(current?.[k]) : k === 'tier' ? current?.tier || 'senior' : current?.[k] ?? null;
  const changes = Object.keys(patch)
    .filter((k) => before(k) !== patch[k])
    .map((k) => ({ key: k, from: before(k), to: patch[k] }));
  return { patch, changes };
};

/** Секция «Запись»: приоритет мастера на сайте (порядок колонки — «Pořadí» календаря, услуги — Каталог). */
export const normalizeBooking = (data: any, current: any) => {
  onlyKeys(data, ['bookingPriority']);
  const v = intIn(data.bookingPriority, PRIORITY_MIN, PRIORITY_MAX, 'bad_priority', 'Приоритет');
  const from = current?.bookingPriority ?? 0;
  return { patch: { bookingPriority: v }, changes: from === v ? [] : [{ key: 'bookingPriority', from, to: v }] };
};

const YM_RE = /^(20\d{2})-(0[1-9]|1[0-2])$/;

/** 'YYYY-MM' или null (пусто). Иначе 400. */
export const normalizeYm = (raw: unknown, code: string, label: string): string | null => {
  if (raw == null || raw === '') return null;
  const v = String(raw).trim();
  if (!YM_RE.test(v)) throw new StaffError(400, code, `${label} — месяц в формате ГГГГ-ММ`);
  return v;
};

/**
 * Зарплатная группа карточки (s229, §5а.2) — раньше списки DUAL_ROLE_WORKERS / MANAGERS
 * в коде админки (teamSplit.ts), по имени. Значения в базе: `dualRole` 'yes' | null,
 * `dualRoleUntil` / `managerSince` 'YYYY-MM' | null.
 */
export const payrollGroupOf = (doc: any) => ({
  dualRole: doc?.dualRole === 'yes',
  dualRoleUntil: YM_RE.test(String(doc?.dualRoleUntil ?? '')) ? doc.dualRoleUntil : null,
  managerSince: YM_RE.test(String(doc?.managerSince ?? '')) ? doc.managerSince : null,
});

/**
 * Секция «Оплата»: доля мастера и порог + зарплатная группа (s229). Ставки — только
 * «новая с даты» (planNewRate).
 * 🟥 Группа меняет расчёт зарплат всех месяцев, где она действует (совместитель — до
 * `dualRoleUntil` включительно, управляющая — с `managerSince`): админка предупреждает
 * и сбрасывает кэш месяцев.
 */
export const normalizePay = (data: any, current: any) => {
  const keys = onlyKeys(data, ['ratePercent', 'excessThreshold', 'dualRole', 'dualRoleUntil', 'managerSince']);
  const patch: Record<string, any> = {};
  if (keys.includes('ratePercent')) patch.ratePercent = intIn(data.ratePercent, 0, 100, 'bad_percent', 'Доля мастера, %');
  if (keys.includes('excessThreshold')) {
    patch.excessThreshold = intIn(data.excessThreshold, 0, THRESHOLD_MAX, 'bad_threshold', 'Порог');
  }
  const group = payrollGroupOf(current);
  if (keys.includes('dualRole')) {
    if (typeof data.dualRole !== 'boolean') throw new StaffError(400, 'bad_dual_role', 'Совместитель — да или нет');
    patch.dualRole = data.dualRole ? 'yes' : null;
  }
  if (keys.includes('dualRoleUntil')) patch.dualRoleUntil = normalizeYm(data.dualRoleUntil, 'bad_month', 'Совмещение до');
  const dualAfter = hasOwn(patch, 'dualRole') ? patch.dualRole === 'yes' : group.dualRole;
  // без совмещения «до» не бывает — снимаем вместе с признаком
  if (!dualAfter) {
    if (hasOwn(patch, 'dualRoleUntil') && patch.dualRoleUntil) {
      throw new StaffError(400, 'bad_month', '«Совмещение до» — только у совместителя');
    }
    if (group.dualRoleUntil) patch.dualRoleUntil = null;
  }
  if (keys.includes('managerSince')) {
    patch.managerSince = normalizeYm(data.managerSince, 'bad_month', 'Управляющая с');
    if (patch.managerSince && current?.position !== 'manager') {
      throw new StaffError(409, 'not_manager', 'Оклад управляющей — только у должности «управляющая»');
    }
  }
  const before = (k: string) => {
    if (k === 'dualRole') return group.dualRole ? 'yes' : null;
    if (k === 'dualRoleUntil' || k === 'managerSince') return group[k];
    return current?.[k] ?? null;
  };
  const changes = Object.keys(patch)
    .filter((k) => before(k) !== patch[k])
    .map((k) => ({ key: k, from: before(k), to: patch[k] }));
  return { patch, changes };
};

/** Запись ставки → чистый вид (biginteger приходит строкой). */
export const pickRate = (r: any) => ({
  typeWork: r?.typeWork === 'hpp' ? 'hpp' : 'dpp',
  rate: r?.rate == null ? null : Number(r.rate),
  hourlyRate: r?.hourlyRate == null ? null : Number(r.hourlyRate),
  from: ymdOf(r?.from),
  to: ymdOf(r?.to),
});

/**
 * Ставка на дату — то же правило, что у зарплат (allAdminsHours): from ≤ d ≤ to,
 * при совпадении побеждает более поздний from.
 */
export const rateOn = (rates: any[], ymd: string) => {
  let found = null;
  let foundFrom = '';
  for (const r of rates || []) {
    const from = ymdOf(r?.from) || '';
    const to = ymdOf(r?.to) || '9999-12-31';
    if (!from || from > ymd || ymd > to) continue;
    if (from >= foundFrom) {
      found = r;
      foundFrom = from;
    }
  }
  return found ? pickRate(found) : null;
};

const monthStart = (ymd: string) => `${ymd.slice(0, 7)}-01`;

/**
 * Новая ставка «с даты». Прошлые записи не правятся (часы × ставка считаются на лету —
 * правка задним числом переписала бы посчитанные месяцы), поэтому:
 *   - начало — не раньше первого числа текущего месяца и позже начала любой прежней записи;
 *   - прежние записи, действующие на эту дату или позже, закрываются днём раньше.
 * Возвращает новый массив для записи (прежние записи — со своими `id`) и что закрыто.
 */
export const planNewRate = (rates: any[], input: any, today: string) => {
  const b = input || {};
  const typeWork = String(b.typeWork ?? '');
  if (typeWork !== 'hpp' && typeWork !== 'dpp') throw new StaffError(400, 'bad_type_work', 'Тип договора — HPP или DPP');
  const rate = intIn(b.rate, 1, RATE_MAX, 'bad_rate', typeWork === 'hpp' ? 'Месячная ставка' : 'Почасовая ставка');
  let hourlyRate = null;
  if (b.hourlyRate != null && b.hourlyRate !== '') {
    if (typeWork !== 'hpp') throw new StaffError(400, 'hourly_only_hpp', 'Отдельная почасовая ставка — только у HPP');
    hourlyRate = intIn(b.hourlyRate, 1, HOURLY_MAX, 'bad_hourly', 'Почасовая ставка');
  }
  const from = String(b.from ?? '').trim();
  if (!isValidYmd(from)) throw new StaffError(400, 'bad_date', 'Дата начала — ГГГГ-ММ-ДД');
  if (from < monthStart(today)) {
    throw new StaffError(400, 'rate_in_past', 'Ставка вводится не раньше первого числа текущего месяца — прошлые месяцы уже посчитаны');
  }
  if (from > addDaysYmd(today, MAX_FUTURE_DAYS)) throw new StaffError(400, 'date_too_far', 'Дата слишком далеко в будущем');
  const latest = (rates || []).map((r) => ymdOf(r?.from) || '').sort().pop() || '';
  if (latest && from <= latest) {
    throw new StaffError(409, 'rate_overlap', `Последняя ставка начинается ${fmtDay(latest)} — новая должна начинаться позже`);
  }
  const dayBefore = addDaysYmd(from, -1);
  const closed = [];
  const next = (rates || []).map((r) => {
    const cur = pickRate(r);
    const keep = { id: r.id, typeWork: cur.typeWork, rate: r.rate, hourlyRate: r.hourlyRate ?? null, from: cur.from, to: cur.to };
    if (!cur.to || cur.to >= from) {
      closed.push({ ...cur, to: dayBefore, wasTo: cur.to });
      keep.to = dayBefore;
    }
    return keep;
  });
  const added = { typeWork, rate, hourlyRate, from, to: null };
  next.push({ ...added });
  return { rates: next, added, closed };
};

/** «DPP 180 Kč/h», «HPP 19 011 Kč/měs + 150 Kč/h». */
export const rateLabel = (r: any) => {
  const n = (v) => Number(v).toLocaleString('cs-CZ').replace(/\s/g, ' ');
  if (r?.typeWork === 'hpp') return `HPP ${n(r.rate)} Kč/měs${r.hourlyRate ? ` + ${n(r.hourlyRate)} Kč/h` : ''}`;
  return `DPP ${n(r?.rate)} Kč/h`;
};

/**
 * «Чего не хватает» — для бейджей списка. Ушедшим не считается.
 * ctx: { account, servicesCount, hasSchedule, today }.
 * Заполненность личных данных — в чек-листе (фаза 2, buildChecklist), не здесь.
 */
export const missingFlags = (p: any, ctx: any): string[] => {
  if (isLeft(p)) return [];
  const out = [];
  const master = p?.position === 'master';
  if (!ctx.account) out.push('no_account');
  else if (ctx.account.isActive !== true) out.push('account_disabled');
  if (master && !cleanText(p?.noonaEmployeeId)) out.push('not_in_calendar');
  if (master && !ctx.servicesCount) out.push('no_services');
  if (master && !ctx.hasSchedule) out.push('no_schedule');
  if (master ? p?.ratePercent == null : !rateOn(p?.rates, ctx.today)) out.push('no_rate');
  return out;
};

// ── фаза 2 (s231): договор — только учёт ─────────────────────────────────
// 🟥 Договор НЕ влияет на деньги: смысл оплаты несёт `rates.typeWork` (у админов `hpp` =
// фикс в месяц, у управляющей — оклад). Ставки договором не правятся и не подставляются.

export const CONTRACT_TYPES = { hpp: 'HPP', dpp: 'DPP', ico: 'IČO' } as const;
export const MAX_CONTRACT_NOTE = 200;
/** Испытательный срок в ЧР — до 3 месяцев (до 6 у руководящих): длиннее — предупреждение, не запрет. */
export const PROBATION_WARN_MONTHS = 3;
/** Напоминания (решение §8.1, предложенное): конец договора — за 30 дней, испытательного — за 14. */
export const CONTRACT_REMIND_DAYS = 30;
export const PROBATION_REMIND_DAYS = 14;

/** IČO: 8 цифр, последняя — контрольная (веса 8…2, mod 11). */
export const icoValid = (raw: unknown): boolean => {
  const s = String(raw ?? '');
  if (!/^\d{8}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(s[i]) * (8 - i);
  return (11 - (sum % 11)) % 10 === Number(s[7]);
};

/** Запись договора → чистый вид. */
export const pickContract = (c: any) => ({
  id: c?.id ?? null,
  type: hasOwn(CONTRACT_TYPES, String(c?.type)) ? c.type : 'dpp',
  from: ymdOf(c?.from),
  to: ymdOf(c?.to),
  probationUntil: ymdOf(c?.probationUntil),
  ico: c?.ico ? String(c.ico) : null,
  note: c?.note ? String(c.note) : null,
});

const byFrom = (a: any, b: any) => String(a.from || '').localeCompare(String(b.from || ''));

/** Договоры по дате начала. */
export const contractsOf = (list: any[]) => (list || []).map(pickContract).sort(byFrom);

/** Текущий договор: покрывающий дату, при совпадении — позже начавшийся. */
export const contractOn = (list: any[], ymd: string) => {
  let found = null;
  for (const c of contractsOf(list)) {
    if (c.from && c.from <= ymd && (!c.to || c.to >= ymd)) found = c;
  }
  return found;
};

const monthsAfter = (ymd: string, months: number) => {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + months, d));
  // 31.01 + 1 мес. → 28/29.02, а не 03.03
  if (t.getUTCDate() !== d) t.setUTCDate(0);
  return t.toISOString().slice(0, 10);
};

const CONTRACT_KEYS = ['type', 'from', 'to', 'probationUntil', 'ico', 'note'];

const optDate = (raw: unknown, label: string): string | null => {
  if (raw == null || raw === '') return null;
  const v = String(raw).trim();
  if (!isValidYmd(v) || v < MIN_HIRED || v > '2100-12-31') throw new StaffError(400, 'bad_date', `${label} — ГГГГ-ММ-ДД`);
  return v;
};

/**
 * Договор для записи. `current` — правка существующего (незаданные поля берутся из него),
 * `others` — остальные договоры карточки (пересечение периодов — 409).
 * Прошлые договоры можно править (учёт, опечатки), удалять — только не начавшиеся.
 * Возвращает договор и предупреждения (длинный испытательный срок).
 */
export const normalizeContract = (data: any, { current = null, others = [], today }: { current?: any; others?: any[]; today: string }) => {
  const keys = onlyKeys(data, CONTRACT_KEYS);
  const cur = current ? pickContract(current) : null;
  const val = (k: string) => (keys.includes(k) ? data[k] : cur?.[k]);
  const type = String(val('type') ?? '');
  if (!hasOwn(CONTRACT_TYPES, type)) throw new StaffError(400, 'bad_contract_type', 'Тип договора — HPP, DPP или IČO');
  const from = optDate(val('from'), 'Начало договора');
  if (!from) throw new StaffError(400, 'bad_date', 'Укажите начало договора');
  if (from > addDaysYmd(today, MAX_FUTURE_DAYS)) throw new StaffError(400, 'date_too_far', 'Дата слишком далеко в будущем');
  const to = optDate(val('to'), 'Конец договора');
  if (to && to < from) throw new StaffError(400, 'bad_date', 'Конец договора раньше начала');
  let probationUntil = optDate(val('probationUntil'), 'Испытательный срок');
  // тип сменили с HPP — испытательный уходит вместе с ним (явно присланный — ошибка)
  if (type !== 'hpp') {
    if (keys.includes('probationUntil') && probationUntil) {
      throw new StaffError(400, 'probation_only_hpp', 'Испытательный срок — только у HPP');
    }
    probationUntil = null;
  }
  if (probationUntil && (probationUntil < from || (to && probationUntil > to))) {
    throw new StaffError(400, 'bad_date', 'Испытательный срок — внутри договора');
  }
  let ico = cleanText(val('ico')) || null;
  if (type !== 'ico') {
    if (keys.includes('ico') && ico) throw new StaffError(400, 'ico_only_ico', 'IČO — только у договора IČO (OSVČ)');
    ico = null;
  } else {
    if (ico) ico = ico.replace(/\s/g, '');
    if (!ico) throw new StaffError(400, 'ico_required', 'Укажите IČO');
    if (!icoValid(ico)) throw new StaffError(400, 'bad_ico', 'IČO — 8 цифр с верной контрольной цифрой');
  }
  const note = cleanText(val('note')) || null;
  if (note && note.length > MAX_CONTRACT_NOTE) throw new StaffError(400, 'too_long', `Заметка — не длиннее ${MAX_CONTRACT_NOTE} символов`);
  const end = to || '9999-12-31';
  const clash = contractsOf(others).find((o) => o.from && o.from <= end && (o.to || '9999-12-31') >= from);
  if (clash) {
    const span = `${fmtDay(clash.from)}${clash.to ? `–${fmtDay(clash.to)}` : ' (бессрочно)'}`;
    throw new StaffError(409, 'contract_overlap', `Пересекается с договором ${CONTRACT_TYPES[clash.type]} ${span} — сначала закройте его датой`);
  }
  const warnings = [];
  if (probationUntil && probationUntil > monthsAfter(from, PROBATION_WARN_MONTHS)) warnings.push('long_probation');
  return { contract: { type, from, to, probationUntil, ico, note }, warnings };
};

/** «HPP 01.10.2026–30.09.2027», «DPP od 01.10.2026». */
export const contractLabel = (c: any) =>
  `${CONTRACT_TYPES[c?.type] || c?.type} ${c?.to ? `${fmtDay(c.from)}–${fmtDay(c.to)}` : `od ${fmtDay(c.from)}`}`;

/** Массив компонента для записи: прежние записи — со своими `id` (как ставки). */
const contractRows = (list: any[]) =>
  list.map((c) => {
    const row: Record<string, any> = { type: c.type, from: c.from, to: c.to ?? null, probationUntil: c.probationUntil ?? null, ico: c.ico ?? null, note: c.note ?? null };
    if (c.id != null) row.id = c.id;
    return row;
  });

// ── фаза 2 (s231): онбординг-чек-лист и процент заполненности ────────────

export const CHECKLIST_POSITIONS = ['master', 'administrator', 'manager'] as const;
export const MAX_CHECKLIST_TITLE = 80;
/** Стартовый каталог своих пунктов (§8.3, предложенное) — кладётся один раз в пустую коллекцию. */
export const DEFAULT_CHECKLIST = [
  'Выданы ключи',
  'Выдана форма',
  'Инструктаж по безопасности',
  'Подписан договор о материальной ответственности',
];

/**
 * Автопункты: закрываются сами по данным карточки. `section` — куда вести в карточке.
 * zdravotní průkaz — для мастеров, счёт и экстренный контакт — для всех (§8.2, предложенное).
 */
export const AUTO_CHECKLIST = [
  { key: 'account', title: 'Учётка для входа включена', section: 'account', for: 'all' },
  { key: 'private', title: 'Личные данные (7 основных полей)', section: 'private', for: 'all' },
  { key: 'bank', title: 'Номер счёта', section: 'private', for: 'all' },
  { key: 'emergency', title: 'Экстренный контакт', section: 'private', for: 'all' },
  { key: 'photo', title: 'Фото', section: 'header', for: 'master' },
  { key: 'id_document', title: 'Паспорт или вид на жительство (действует)', section: 'documents', for: 'all' },
  { key: 'health', title: 'Zdravotní průkaz (действует)', section: 'documents', for: 'master' },
  { key: 'contract', title: 'Текущий договор', section: 'contract', for: 'all' },
  { key: 'contract_doc', title: 'Скан договора (IČO — živnostenský list)', section: 'documents', for: 'all' },
  { key: 'rate', title: 'Ставка или доля', section: 'pay', for: 'all' },
  { key: 'calendar', title: 'Колонка в календаре', section: 'booking', for: 'master' },
  { key: 'services', title: 'Услуги (Каталог)', section: 'booking', for: 'master' },
  { key: 'schedule', title: 'Шаблон графика', section: 'booking', for: 'master' },
] as const;

/** Пункт каталога → чистый вид. positions пусто/мусор — всем. */
export const pickChecklistItem = (i: any) => {
  const pos = Array.isArray(i?.positions) ? i.positions.filter((p) => CHECKLIST_POSITIONS.includes(p)) : [];
  return {
    documentId: i?.documentId,
    title: cleanText(i?.title),
    positions: pos.length ? pos : [...CHECKLIST_POSITIONS],
    order: Number(i?.order) || 0,
    active: i?.active !== false,
  };
};

const onboardingOf = (v: unknown): Record<string, { at: string; by: string }> => (isPlain(v) ? (v as any) : {});

/** Документ действует на дату (без срока — действует). */
const docValid = (d: any, today: string) => !d?.validUntil || ymdOf(d.validUntil) >= today;

/**
 * Чек-лист карточки: автопункты по данным + свои пункты руководства (активные для
 * должности; выключенные — только если на этой карточке уже отмечены).
 * Процент — готовые / применимые, вниз (100 — только когда готово всё). Ушедшим — null.
 * ctx: { account, servicesCount, hasSchedule, oficial, documents: [{kind, validUntil}], items, today }.
 */
export const buildChecklist = (p: any, ctx: any) => {
  if (isLeft(p)) return null;
  const master = p?.position === 'master';
  const today = ctx.today;
  const o = ctx.oficial || {};
  const docs = ctx.documents || [];
  const current = contractOn(p?.contracts, today);
  const has = (kind: string) => docs.some((d) => d.kind === kind && docValid(d, today));
  const done = {
    account: Boolean(ctx.account && ctx.account.isActive === true),
    private: privateMissing(o).length === 0,
    bank: Boolean(cleanText(o.bankAccount)),
    emergency: Boolean(cleanText(o.emergencyName) && cleanText(o.emergencyPhone)),
    photo: Boolean(p?.photo?.url || p?.photo?.id),
    id_document: has('passport') || has('residence'),
    health: has('health'),
    contract: Boolean(current),
    contract_doc: has(current?.type === 'ico' ? 'license' : 'contract'),
    rate: master ? p?.ratePercent != null : Boolean(rateOn(p?.rates, today)),
    calendar: Boolean(cleanText(p?.noonaEmployeeId)),
    services: Boolean(ctx.servicesCount),
    schedule: Boolean(ctx.hasSchedule),
  };
  const items: any[] = AUTO_CHECKLIST.filter((a) => a.for === 'all' || (a.for === 'master' && master)).map((a) => ({
    key: a.key,
    title: a.title,
    section: a.section,
    auto: true,
    done: done[a.key],
  }));
  const marks = onboardingOf(p?.onboarding);
  const own = (ctx.items || [])
    .map(pickChecklistItem)
    .filter((i) => i.documentId && (hasOwn(marks, i.documentId) || (i.active && i.positions.includes(p?.position))))
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  for (const i of own) {
    const m = marks[i.documentId];
    items.push({
      itemId: i.documentId,
      title: i.title,
      auto: false,
      done: Boolean(m),
      doneAt: m?.at || null,
      doneBy: m?.by || null,
      active: i.active,
    });
  }
  const total = items.length;
  const ready = items.filter((i) => i.done).length;
  return { items, percent: total ? Math.floor((ready * 100) / total) : 100, open: total - ready };
};

/** Каталог: {title, positions} для создания, любые из {title, positions, active, order} для правки. */
export const normalizeChecklistItem = (data: any, { create = false } = {}) => {
  const keys = onlyKeys(data, create ? ['title', 'positions'] : ['title', 'positions', 'active', 'order']);
  const out: Record<string, any> = {};
  if (create || keys.includes('title')) {
    const t = cleanText(data.title);
    if (!t) throw new StaffError(400, 'title_required', 'Название пункта обязательно');
    if (t.length > MAX_CHECKLIST_TITLE) throw new StaffError(400, 'too_long', `Название — не длиннее ${MAX_CHECKLIST_TITLE} символов`);
    out.title = t;
  }
  if (create || keys.includes('positions')) {
    const v = data.positions;
    if (!Array.isArray(v) || !v.length || v.some((x) => !CHECKLIST_POSITIONS.includes(x)) || new Set(v).size !== v.length) {
      throw new StaffError(400, 'bad_positions', 'Кому пункт — мастер, администратор, управляющая');
    }
    out.positions = CHECKLIST_POSITIONS.filter((x) => v.includes(x));
  }
  if (keys.includes('active')) {
    if (typeof data.active !== 'boolean') throw new StaffError(400, 'bad_field', 'active — да или нет');
    out.active = data.active;
  }
  if (keys.includes('order')) out.order = intIn(data.order, 0, 10_000, 'bad_order', 'Порядок');
  return out;
};

/** Метаданные документа: тип, название, «действует до». create — значения по умолчанию. */
export const normalizeDocMeta = (body: any, { create = false, fileName = '' } = {}) => {
  // multipart-поля приходят объектом без прототипа Object — поэтому не isPlain
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const out: Record<string, any> = {};
  if (create || hasOwn(b, 'kind')) {
    const kind = b.kind == null || b.kind === '' ? 'other' : String(b.kind);
    if (!hasOwn(DOC_KINDS, kind)) throw new StaffError(400, 'bad_kind', 'Неизвестный тип документа');
    out.kind = kind;
  }
  if (create || hasOwn(b, 'title')) {
    let title = cleanText(b.title);
    if (!title && create) title = fileName.replace(/\.[a-z0-9]{1,5}$/i, '') || DOC_KINDS[out.kind || 'other'];
    if (!title) throw new StaffError(400, 'title_required', 'Название документа обязательно');
    if (title.length > MAX_TITLE) throw new StaffError(400, 'too_long', `Название — не длиннее ${MAX_TITLE} символов`);
    out.title = title;
  }
  if (hasOwn(b, 'validUntil')) {
    const raw = b.validUntil;
    if (raw == null || raw === '') out.validUntil = null;
    else {
      const v = String(raw).trim();
      if (!isValidYmd(v) || v < '2000-01-01' || v > '2100-12-31') throw new StaffError(400, 'bad_date', '«Действует до» — ГГГГ-ММ-ДД');
      out.validUntil = v;
    }
  }
  if (!create && !Object.keys(out).length) throw new StaffError(400, 'nothing_to_save', 'Нет данных для сохранения');
  return out;
};

export const normalizeNoteText = (v: unknown): string => {
  const s = String(v ?? '').replace(/\r\n?/g, '\n').trim();
  if (!s) throw new StaffError(400, 'note_required', 'Текст заметки пустой');
  if (s.length > MAX_NOTE) throw new StaffError(400, 'too_long', `Заметка — не длиннее ${MAX_NOTE} символов`);
  return s;
};

const sameInstant = (a: unknown, b: unknown): boolean => {
  const ta = new Date(String(a ?? '')).getTime();
  const tb = new Date(String(b ?? '')).getTime();
  return Number.isFinite(ta) && ta === tb;
};

/** Защита от одновременной правки: `base` обязателен и равен updatedAt черновика. */
export const assertBase = (base: unknown, current: any) => {
  if (base == null || base === '') throw new StaffError(400, 'base_required', 'Обновите карточку и повторите');
  if (!sameInstant(base, current?.updatedAt)) {
    throw new StaffError(409, 'staff_changed', 'Карточку только что изменили в другом окне — обновите страницу');
  }
};

const FIELD_CS = {
  position: 'pozice',
  tier: 'úroveň',
  hiredAt: 'nástup',
  leftAt: 'odchod',
  bookingPriority: 'priorita',
  ratePercent: 'podíl mistra',
  excessThreshold: 'práh',
  dualRole: 'souběh mistr + administrátor',
  dualRoleUntil: 'souběh do',
  managerSince: 'vedoucí od',
};
const showValue = (key: string, v: any) => {
  if (key === 'dualRole') return v === 'yes' ? 'ano' : 'ne';
  if (v == null || v === '') return '—';
  if (key === 'position') return POSITIONS[v] || v;
  if (key === 'hiredAt' || key === 'leftAt') return fmtDay(v);
  if (key === 'ratePercent') return `${v} %`;
  return String(v);
};
const changeText = (c: any) => `${FIELD_CS[c.key] || c.key}: ${showValue(c.key, c.from)} → ${showValue(c.key, c.to)}`;

/**
 * Строка журнала. Формат «Действие: имя · детали» — журнал календаря (parseSummary)
 * берёт текст после «: » и делит по « · », первый кусок становится заголовком.
 */
export const logSummary = (kind: string, name: string, parts: string[] = []) => {
  const head = {
    basic: 'Karta zaměstnance upravena',
    booking: 'Rezervace mistra upraveny',
    pay: 'Mzdové podmínky upraveny',
    private: 'Osobní údaje změněny',
    rate: 'Nová sazba',
    photo: 'Nová fotka',
    file_add: 'Nový dokument',
    file_update: 'Dokument upraven',
    file_delete: 'Dokument smazán',
    note_add: 'Nová poznámka',
    note_update: 'Poznámka upravena',
    note_delete: 'Poznámka smazána',
    create: 'Nový zaměstnanec',
    rename: 'Přejmenování',
    account_create: 'Nový přístup do administrace',
    account_disable: 'Přístup do administrace vypnut',
    account_enable: 'Přístup do administrace zapnut',
    account_password: 'Nové heslo do administrace',
    leave: 'Ukončení spolupráce',
    erase: 'Osobní údaje smazány',
    contract_add: 'Nová smlouva',
    contract_update: 'Smlouva upravena',
    contract_delete: 'Smlouva smazána',
    onboarding_done: 'Nástup: splněno',
    onboarding_undone: 'Nástup: odškrtnuto',
  }[kind];
  return [`${head}: ${name}`, ...parts].join(' · ');
};

export const changeParts = (changes: any[]) => changes.map(changeText);

// ── шаг 4: имя, пароль, создание, уход, стирание ──────────────────────────

// буква, дальше буквы (с диакритикой), пробел, точка, дефис, апостроф; «❌» — служебная
// отметка старых ушедших, новому имени её не дать
const NAME_RE = /^\p{L}[\p{L}\p{M} .'’-]*$/u;

/** Имя сотрудника = логин учётки: пробелы схлопнуты, только буквы и знаки имени. */
export const normalizeName = (raw: unknown): string => {
  const s = cleanText(raw);
  if (!s) throw new StaffError(400, 'name_required', 'Укажите имя');
  if (s.length < NAME_MIN || s.length > NAME_MAX) {
    throw new StaffError(400, 'bad_name', `Имя — от ${NAME_MIN} до ${NAME_MAX} символов`);
  }
  if (!NAME_RE.test(s)) throw new StaffError(400, 'bad_name', 'Имя — только буквы, пробел, дефис, точка и апостроф');
  return s;
};

/**
 * Имя занято: другой карточкой (без учёта регистра) или логином другой учётки
 * (вход сверяет логин точно, но два логина, различимых только регистром, — путаница,
 * а инвариант «логин = имя карточки» сравнивается без регистра).
 */
export const assertNameFree = (
  name: string,
  cards: any[],
  accounts: any[],
  { exceptDocId = null, exceptAccountId = null }: { exceptDocId?: string | null; exceptAccountId?: number | null } = {}
) => {
  const key = lower(name);
  if (cards.some((c) => c.documentId !== exceptDocId && lower(c.name) === key)) {
    throw new StaffError(409, 'name_taken', 'Сотрудник с таким именем уже есть');
  }
  if (accounts.some((a) => a.id !== exceptAccountId && lower(a.username) === key)) {
    throw new StaffError(409, 'name_taken', 'Такой логин уже занят другой учёткой');
  }
};

// без похожих символов (0/O, 1/l/I)
const PW_LOWER = 'abcdefghijkmnpqrstuvwxyz';
const PW_UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const PW_DIGIT = '23456789';
const PW_ALL = PW_LOWER + PW_UPPER + PW_DIGIT;

/** Пароль для учётки: 12 символов, есть строчная, заглавная и цифра. */
export const genPassword = (randomInt: (max: number) => number = (max) => crypto.randomInt(max)): string => {
  for (;;) {
    let s = '';
    for (let i = 0; i < PASSWORD_LENGTH; i++) s += PW_ALL[randomInt(PW_ALL.length)];
    if (/[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s)) return s;
  }
};

const CREATE_KEYS = ['name', 'position', 'tier', 'hiredAt', 'ratePercent', 'rate', 'private', 'account'];

/**
 * Форма «Новый сотрудник». Обязательны только имя и должность (решение владельца s222);
 * доля мастера, ставка, личные данные — по желанию. Дата приёма по умолчанию — сегодня.
 */
export const normalizeCreate = (body: any, today: string) => {
  if (!isPlain(body)) throw new StaffError(400, 'bad_data', 'Нет данных');
  for (const k of Object.keys(body)) if (!CREATE_KEYS.includes(k)) throw new StaffError(400, 'bad_field', `Неизвестное поле: ${k}`);
  const name = normalizeName(body.name);
  const position = String(body.position ?? '');
  if (!hasOwn(POSITIONS, position)) throw new StaffError(400, 'bad_position', 'Выберите должность');
  const master = position === 'master';
  let tier = 'senior';
  if (body.tier != null && body.tier !== '') {
    tier = String(body.tier);
    if (!hasOwn(TIERS, tier)) throw new StaffError(400, 'bad_tier', 'Уровень — senior или junior');
    if (!master && tier !== 'senior') throw new StaffError(400, 'bad_tier', 'Уровень junior — только у мастера');
  }
  const hiredAt =
    body.hiredAt == null || body.hiredAt === '' ? today : normalizeBasic({ hiredAt: body.hiredAt }, null, today).patch.hiredAt;
  let ratePercent = null;
  if (body.ratePercent != null && body.ratePercent !== '') {
    if (!master) throw new StaffError(400, 'bad_field', 'Доля от услуг — только у мастера');
    ratePercent = intIn(body.ratePercent, 0, 100, 'bad_percent', 'Доля мастера, %');
  }
  const rate = body.rate == null ? null : planNewRate([], body.rate, today).added;
  let privateData = null;
  if (body.private != null) {
    if (!isPlain(body.private)) throw new StaffError(400, 'bad_data', 'Личные данные — объект полей');
    // пустые поля формы не считаются «заполненными»
    const filled = Object.fromEntries(Object.entries(body.private).filter(([, v]) => v != null && v !== ''));
    if (Object.keys(filled).length) privateData = normalizePrivate(filled, null, Number(today.slice(0, 4))).next;
  }
  if (body.account != null && typeof body.account !== 'boolean') throw new StaffError(400, 'bad_field', 'account — да или нет');
  return { name, position, tier, hiredAt, ratePercent, rate, private: privateData, account: body.account !== false };
};

/** Дата ухода: по умолчанию сегодня; не в будущем (действие делается в последний день или позже) и не раньше приёма. */
export const normalizeLeftAt = (raw: unknown, hiredAt: string | null, today: string): string => {
  const v = raw == null || raw === '' ? today : String(raw).trim();
  if (!isValidYmd(v)) throw new StaffError(400, 'bad_date', 'Дата ухода — ГГГГ-ММ-ДД');
  if (v > today) throw new StaffError(400, 'leave_in_future', 'Дата ухода — не позже сегодняшней: завершите работу в последний день');
  if (v < (hiredAt && hiredAt > MIN_HIRED ? hiredAt : MIN_HIRED)) {
    throw new StaffError(400, 'bad_date', 'Дата ухода раньше даты приёма');
  }
  return v;
};

/**
 * Ставки при уходе: всё, что действует на дату ухода или позже, закрывается датой ухода.
 * Ставка, начинающаяся после ухода, — ошибка ввода: 409, а не молчаливое удаление.
 */
export const planLeave = (rates: any[], leftAt: string) => {
  const later = (rates || []).map(pickRate).filter((r) => r.from && r.from > leftAt);
  if (later.length) {
    throw new StaffError(409, 'rate_after_leave', `Есть ставка с ${fmtDay(later[0].from)} — позже даты ухода`);
  }
  const closed = [];
  const next = (rates || []).map((r) => {
    const cur = pickRate(r);
    const keep = { id: r.id, typeWork: cur.typeWork, rate: r.rate, hourlyRate: r.hourlyRate ?? null, from: cur.from, to: cur.to };
    if (!cur.to || cur.to > leftAt) {
      closed.push({ ...cur, to: leftAt, wasTo: cur.to });
      keep.to = leftAt;
    }
    return keep;
  });
  return { rates: next, closed };
};

/** Дата, с которой личные данные ушедшего можно стереть (решение владельца: 3 года). 29.02 → 28.02. */
export const eraseDueDate = (leftAt: string | null): string | null => {
  if (!leftAt || !isValidYmd(leftAt)) return null;
  const [y, m, d] = leftAt.split('-').map(Number);
  const yy = y + ERASE_AFTER_YEARS;
  const day = isRealDate(yy, m, d) ? d : d - 1;
  return `${yy}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

// ── напоминания для «Сегодня» (s227, §3.12 и §8.2 плана) ──────────────────

/** Документ напоминает о себе за 30 дней до конца срока и после него. */
export const DOC_REMIND_DAYS = 30;

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Что показать руководству на «Сегодня»:
 *   - documents — документы работающих, у которых срок кончается в 30 дней или уже прошёл.
 *     Документ, заменённый новым того же типа (действует дольше, или бессрочный и загружен
 *     позже), не напоминает: старый паспорт часто остаётся в карточке рядом с новым;
 *   - erase — ушедшие, у кого прошло 3 года с ухода, а личные данные ещё не стёрты;
 *   - leftWithoutDate — ушедшие с личными данными, но без даты ухода: по ним напоминание
 *     о стирании не сработает никогда (ушли до модуля карточки, §8.2).
 * cards: [{documentId, name, left, leftAt, erasedAt, hasPrivate}] — уже отфильтрованные по
 * сессии; docs: [{documentId, personal, kind, title, validUntil, createdAt}].
 */
export const buildReminders = (cards: any[], docs: any[], today: string) => {
  const byId = new Map(cards.map((c) => [c.documentId, c]));
  const horizon = addDaysYmd(today, DOC_REMIND_DAYS);
  const replaced = (d: any) =>
    d.kind !== 'other' &&
    docs.some(
      (o) =>
        o !== d &&
        o.personal === d.personal &&
        o.kind === d.kind &&
        (o.validUntil ? o.validUntil > d.validUntil : String(o.createdAt || '') > String(d.createdAt || ''))
    );
  const documents = docs
    .filter((d) => {
      const card = byId.get(d.personal);
      return card && !card.left && d.validUntil && d.validUntil <= horizon && !replaced(d);
    })
    .map((d) => ({
      personal: d.personal,
      name: byId.get(d.personal).name,
      documentId: d.documentId,
      kind: d.kind || 'other',
      title: d.title || '',
      validUntil: d.validUntil,
      daysLeft: daysBetween(today, d.validUntil),
    }))
    .sort((a, b) => a.validUntil.localeCompare(b.validUntil) || a.name.localeCompare(b.name));
  const pending = cards.filter((c) => c.left && !c.erasedAt && c.hasPrivate);
  const erase = pending
    .filter((c) => c.leftAt && eraseDueDate(c.leftAt) && eraseDueDate(c.leftAt) <= today)
    .map((c) => ({ personal: c.documentId, name: c.name, leftAt: c.leftAt, dueAt: eraseDueDate(c.leftAt) }))
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.name.localeCompare(b.name));
  const leftWithoutDate = pending
    .filter((c) => !c.leftAt)
    .map((c) => ({ personal: c.documentId, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { today, horizonDays: DOC_REMIND_DAYS, documents, erase, leftWithoutDate, contracts: contractReminders(cards, today) };
};

/**
 * Договоры работающих (фаза 2): последний договор кончается в 30 дней или уже кончился, а
 * нового нет (`contract_end`); испытательный срок текущего кончается в 14 дней
 * (`probation_end`). Сотрудник без договоров не напоминает — это пункт чек-листа.
 * Только имя, тип и дата: номер IČO сюда не идёт (раздел читают и в дайджесте).
 */
export const contractReminders = (cards: any[], today: string) => {
  const out = [];
  for (const c of cards) {
    if (c.left) continue;
    const list = contractsOf(c.contracts);
    const last = list[list.length - 1];
    if (last?.to && last.to <= addDaysYmd(today, CONTRACT_REMIND_DAYS)) {
      out.push({ personal: c.documentId, name: c.name, kind: 'contract_end', type: last.type, date: last.to, daysLeft: daysBetween(today, last.to) });
    }
    const cur = contractOn(c.contracts, today);
    if (cur?.probationUntil && cur.probationUntil >= today && cur.probationUntil <= addDaysYmd(today, PROBATION_REMIND_DAYS)) {
      out.push({ personal: c.documentId, name: c.name, kind: 'probation_end', type: cur.type, date: cur.probationUntil, daysLeft: daysBetween(today, cur.probationUntil) });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
};

const PRAGUE_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Prague',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const CARD_FIELDS = [
  'name',
  'position',
  'isActive',
  'tier',
  'ratePercent',
  'excessThreshold',
  'noonaEmployeeId',
  'bookingPriority',
  'calendarOrder',
  'hiredAt',
  'leftAt',
  'privateErasedAt',
  'dualRole',
  'dualRoleUntil',
  'managerSince',
  'onboarding',
  'updatedAt',
];
const DOC_FIELDS = ['kind', 'title', 'validUntil', 'fileName', 'mime', 'size', 'uploadedBy', 'createdAt'];
const ACCOUNT_SELECT = ['id', 'username', 'role', 'isActive', 'personalDocId'];

const photoOf = (p: any) =>
  p?.photo?.url ? { id: p.photo.id ?? null, url: p.photo.url, thumb: p.photo.formats?.thumbnail?.url || p.photo.url } : null;

// linked — учётка связана с карточкой полем personalDocId (s229); false — пока по имени
const accountView = (a: any) =>
  a ? { id: a.id, username: a.username, role: a.role, isActive: a.isActive === true, linked: Boolean(cleanText(a.personalDocId)) } : null;

const docView = (d: any) => ({
  documentId: d.documentId,
  kind: d.kind || 'other',
  title: d.title || '',
  validUntil: ymdOf(d.validUntil),
  fileName: d.fileName || '',
  mime: d.mime || '',
  size: Number(d.size) || 0,
  uploadedBy: d.uploadedBy || '',
  createdAt: d.createdAt || null,
});

const noteView = (n: any, session: any) => ({
  documentId: n.documentId,
  text: n.text || '',
  authorName: n.authorName || '',
  createdAt: n.createdAt || null,
  updatedAt: n.updatedAt || null,
  canEdit: session?.role === 'owner' || (n.authorAccountId != null && Number(n.authorAccountId) === Number(session?.id)),
});

const docIdOf = (v: unknown) => {
  const s = String(v ?? '');
  if (!DOC_ID.test(s)) throw new StaffError(404, 'staff_not_found', 'Сотрудник не найден');
  return s;
};

// закладка стартового каталога — одна на процесс (параллельные первые запросы её делят)
let checklistSeeding: Promise<void> | null = null;

/** Состояние срока документа для «Моих данных». */
export const docState = (validUntil: string | null, today: string) => {
  if (!validUntil) return { state: 'none', daysLeft: null };
  const n = daysBetween(today, validUntil);
  return { state: n < 0 ? 'expired' : n <= DOC_REMIND_DAYS ? 'soon' : 'ok', daysLeft: n };
};

export default {
  _today(now: Date) {
    return PRAGUE_DAY.format(now);
  },

  _log(action: string, session: any, entityDocId: string, summary: string, details: Record<string, string> = {}) {
    strapi
      .service(LOG_UID)
      .write({ action, entityType: 'staff', actorName: session?.username || '', entityDocId, summary, details })
      .catch((e) => strapi.log.error(`calendar-log ${action} failed: ${e.message}`));
  },

  async _accounts() {
    return strapi.db.query(ADMIN_UID).findMany({ select: ACCOUNT_SELECT, limit: 1000 });
  },

  _ownerNames(accounts: any[]) {
    return new Set(accounts.filter((a) => a.role === 'owner').map((a) => lower(a.username)));
  },

  /** Карточка (черновик) с проверкой доступа: нет или скрыта от сессии — 404. */
  async _card(session: any, id: unknown, populate: any = {}) {
    const documentId = docIdOf(id);
    const [accounts, doc] = await Promise.all([
      this._accounts(),
      strapi.documents(PERSONAL_UID).findOne({ documentId, status: 'draft', fields: CARD_FIELDS, populate }),
    ]);
    if (!doc || hiddenFromSession(doc.name, this._ownerNames(accounts), session?.role)) {
      throw new StaffError(404, 'staff_not_found', 'Сотрудник не найден');
    }
    return { doc, accounts };
  },

  /** Черновик → публикация (одна точка записи карточки). */
  async _write(documentId: string, data: any) {
    await strapi.documents(PERSONAL_UID).update({ documentId, status: 'draft', data });
    await strapi.documents(PERSONAL_UID).publish({ documentId });
  },

  /** Место новой колонки календаря — в конце. */
  async _nextCalendarOrder() {
    const last = await strapi.documents(PERSONAL_UID).findMany({
      status: 'draft',
      filters: { position: { $eq: 'master' } },
      fields: ['calendarOrder'],
      sort: ['calendarOrder:desc'],
      limit: 1,
    });
    return (Number(last[0]?.calendarOrder) || 0) + 1;
  },

  /** Имена всех карточек (черновики есть у каждой) — проверка уникальности. */
  async _allCards() {
    return strapi.documents(PERSONAL_UID).findMany({ status: 'draft', fields: ['name'], limit: 5000 });
  },

  /**
   * Учётка: пароль хешируется здесь (lifecycle готовый хэш не трогает) — чтобы пароль
   * не лёг в базу открытым, даже если запись пройдёт мимо lifecycle. Document service —
   * чтобы у строки были documentId и publishedAt, как у заведённых в панели.
   */
  async _createAccount(username: string, role: string, personalDocId: string) {
    const password = genPassword();
    const hash = await bcrypt.hash(password, 10);
    // связь с карточкой — сразу (s229, §5а.1): «кто я» ищется по ней, а не по имени
    const row = await strapi.documents(ADMIN_UID).create({ data: { username, password: hash, role, isActive: true, personalDocId } });
    invalidateAdminAccount();
    return { id: row.id, password };
  },

  async _updateAccount(id: number, data: Record<string, any>) {
    await strapi.db.query(ADMIN_UID).update({ where: { id }, data });
    invalidateAdminAccount(id);
  },

  async _hasSchedule(documentIds: string[]) {
    const rows = await strapi.documents(SCHEDULE_UID).findMany({
      fields: ['templates'],
      populate: { personal: { fields: ['name'] } },
      limit: 1000,
    });
    const out = new Set<string>();
    for (const r of rows) {
      const pid = r.personal?.documentId;
      if (pid && documentIds.includes(pid) && Array.isArray(r.templates) && r.templates.length) out.add(pid);
    }
    return out;
  },

  /** Будущие активные брони мастера (запрет смены должности; тот же поиск, что у отпусков). */
  async _futureBookings(doc: any, now: Date) {
    const today = this._today(now);
    const or = [{ employee: { documentId: { $eq: doc.documentId } } }, { engineEmployeeId: { $eq: doc.documentId } }];
    if (cleanText(doc.noonaEmployeeId)) or.push({ noonaEmployeeId: { $eq: doc.noonaEmployeeId } });
    const found = await strapi.documents(BOOKING_UID).findMany({
      filters: { status: 'active', date: { $gte: today }, $or: or },
      fields: ['date', 'startsAt', 'clientNameRaw', 'internal'],
      sort: ['startsAt:asc'],
      limit: 200,
    });
    const nowMs = now.getTime();
    return found
      .filter((b) => !b.startsAt || new Date(b.startsAt).getTime() > nowMs)
      .map((b) => ({
        documentId: b.documentId,
        date: String(b.date),
        time: b.startsAt && pragueDateOf(b.startsAt) === String(b.date) ? minToHHMM(pragueMinOf(b.startsAt)) : null,
        client: cleanText(b.clientNameRaw) || null,
        internal: b.internal === true,
      }));
  },

  // ── чтение ──────────────────────────────────────────────────────────────

  /** Список сотрудников без личных данных + признаки «чего не хватает». */
  async list({ session, now = new Date() }: { session: any; now?: Date }) {
    const today = this._today(now);
    const [accounts, docs, pubs] = await Promise.all([
      this._accounts(),
      strapi.documents(PERSONAL_UID).findMany({
        status: 'draft',
        fields: CARD_FIELDS,
        populate: {
          photo: { fields: ['url', 'formats'] },
          services: { fields: ['documentId'] },
          rates: true,
          contracts: true,
          oficial: { fields: PRIVATE_KEYS },
        },
        sort: 'name:asc',
        limit: 1000,
      }),
      strapi.documents(PERSONAL_UID).findMany({ status: 'published', fields: ['name'], limit: 1000 }),
    ]);
    const owners = this._ownerNames(accounts);
    const visible = docs.filter((d) => !hiddenFromSession(d.name, owners, session?.role));
    const [scheduled, docKinds, items] = await Promise.all([
      this._hasSchedule(visible.filter((d) => d.position === 'master').map((d) => d.documentId)),
      this._docKinds(),
      this._checklistItems(),
    ]);
    const published = new Set(pubs.map((p) => p.documentId));
    const rows = visible.map((d) => {
      const account = accountForCard(d, accounts);
      const servicesCount = (d.services || []).length;
      const hasSchedule = scheduled.has(d.documentId);
      const checklist = buildChecklist(d, {
        account,
        servicesCount,
        hasSchedule,
        oficial: d.oficial,
        documents: docKinds.get(d.documentId) || [],
        items,
        today,
      });
      return {
        documentId: d.documentId,
        name: d.name,
        position: d.position,
        tier: d.tier || 'senior',
        isActive: d.isActive !== false,
        left: isLeft(d),
        published: published.has(d.documentId),
        photo: photoOf(d),
        hiredAt: ymdOf(d.hiredAt),
        leftAt: ymdOf(d.leftAt),
        servicesCount,
        account: account ? { id: account.id, role: account.role, isActive: account.isActive === true } : null,
        flags: missingFlags(d, { account, servicesCount, hasSchedule, today }),
        // в списке — только процент и число невыполненных (пункты — в карточке)
        checklist: checklist ? { percent: checklist.percent, open: checklist.open } : null,
        contract: contractOn(d.contracts, today)?.type || null,
      };
    });
    return { today, rows };
  },

  /** Тип и срок документов по карточкам (для чек-листа): Map personal → [{kind, validUntil}]. */
  async _docKinds(personalDocId: string | null = null) {
    const rows = await strapi.documents(DOC_UID).findMany({
      ...(personalDocId ? { filters: { personal: { documentId: { $eq: personalDocId } } } } : {}),
      fields: ['kind', 'validUntil'],
      populate: { personal: { fields: ['name'] } },
      limit: 5000,
    });
    const out = new Map<string, any[]>();
    for (const r of rows) {
      const pid = r.personal?.documentId;
      if (!pid) continue;
      if (!out.has(pid)) out.set(pid, []);
      out.get(pid).push({ kind: r.kind || 'other', validUntil: ymdOf(r.validUntil) });
    }
    return out;
  },

  /**
   * Каталог своих пунктов. Пустая коллекция — один раз кладётся стартовый набор
   * (§8.3); параллельные первые запросы делят одну закладку.
   */
  async _checklistItems() {
    const read = () =>
      strapi.documents(CHECKLIST_UID).findMany({ fields: ['title', 'positions', 'order', 'active'], sort: ['order:asc'], limit: 500 });
    const rows = await read();
    if (rows.length) return rows;
    if (!checklistSeeding) {
      checklistSeeding = (async () => {
        if ((await read()).length) return;
        for (const [i, title] of DEFAULT_CHECKLIST.entries()) {
          await strapi.documents(CHECKLIST_UID).create({ data: { title, positions: [...CHECKLIST_POSITIONS], order: (i + 1) * 10, active: true } });
        }
      })().finally(() => {
        checklistSeeding = null;
      });
    }
    await checklistSeeding;
    return read();
  },

  /**
   * Напоминания для «Сегодня» (руководство): сроки документов и стирание через 3 года.
   * Значения личных данных наружу не идут — только признак «есть что стирать».
   */
  async reminders({ session, now = new Date() }: { session: any; now?: Date }) {
    const today = this._today(now);
    const [accounts, cards, docs, notes] = await Promise.all([
      this._accounts(),
      strapi.documents(PERSONAL_UID).findMany({
        status: 'draft',
        fields: ['name', 'isActive', 'leftAt', 'privateErasedAt'],
        populate: { oficial: { fields: PRIVATE_KEYS }, contracts: true },
        limit: 1000,
      }),
      strapi.documents(DOC_UID).findMany({
        fields: ['kind', 'title', 'validUntil', 'createdAt'],
        populate: { personal: { fields: ['name'] } },
        limit: 5000,
      }),
      strapi.documents(NOTE_UID).findMany({ fields: ['createdAt'], populate: { personal: { fields: ['name'] } }, limit: 5000 }),
    ]);
    const owners = this._ownerNames(accounts);
    const docRows = docs
      .filter((d) => d.personal?.documentId)
      .map((d) => ({
        documentId: d.documentId,
        personal: d.personal.documentId,
        kind: d.kind,
        title: d.title,
        validUntil: ymdOf(d.validUntil),
        createdAt: d.createdAt,
      }));
    const withFiles = new Set([...docRows.map((d) => d.personal), ...notes.map((n) => n.personal?.documentId).filter(Boolean)]);
    const rows = cards
      .filter((c) => !hiddenFromSession(c.name, owners, session?.role))
      .map((c) => ({
        documentId: c.documentId,
        name: c.name,
        left: isLeft(c),
        leftAt: ymdOf(c.leftAt),
        erasedAt: c.privateErasedAt || null,
        contracts: c.contracts || [],
        hasPrivate:
          PRIVATE_KEYS.some((k) => cleanText(c.oficial?.[k])) || withFiles.has(c.documentId),
      }));
    return buildReminders(rows, docRows, today);
  },

  /** Карточка без личных данных: учётка без пароля, ставки, заметки, история. */
  async card({ session, id, now = new Date() }: { session: any; id: unknown; now?: Date }) {
    const today = this._today(now);
    const { doc, accounts } = await this._card(session, id, {
      photo: { fields: ['url', 'formats'] },
      services: { fields: ['documentId'] },
      rates: true,
      contracts: true,
      oficial: { fields: PRIVATE_KEYS },
    });
    const documentId = doc.documentId;
    const [pub, scheduled, timeOffs, notes, docsCount, history, docKinds, items] = await Promise.all([
      strapi.documents(PERSONAL_UID).findOne({ documentId, status: 'published', fields: ['name'] }),
      doc.position === 'master' ? this._hasSchedule([documentId]) : Promise.resolve(new Set()),
      strapi.documents(TIME_OFF_UID).findMany({
        filters: { personal: { documentId: { $eq: documentId } }, endDate: { $gte: today } },
        fields: ['type', 'startDate', 'endDate'],
        sort: ['startDate:asc'],
        limit: 1,
      }),
      strapi.documents(NOTE_UID).findMany({
        filters: { personal: { documentId: { $eq: documentId } } },
        fields: ['text', 'authorName', 'authorAccountId', 'createdAt', 'updatedAt'],
        sort: ['createdAt:desc'],
        limit: 200,
      }),
      strapi.documents(DOC_UID).count({ filters: { personal: { documentId: { $eq: documentId } } } }),
      strapi.documents(LOG_UID).findMany({
        filters: { entityType: { $eq: 'staff' }, entityDocId: { $eq: documentId } },
        fields: ['action', 'actorName', 'summary', 'details', 'createdAt'],
        sort: ['createdAt:desc'],
        limit: HISTORY_LIMIT,
      }),
      this._docKinds(documentId),
      this._checklistItems(),
    ]);
    const account = accountForCard(doc, accounts);
    const servicesCount = (doc.services || []).length;
    const missing = privateMissing(doc.oficial);
    const contracts = contractsOf(doc.contracts);
    const rates = (doc.rates || []).map(pickRate).sort((a, b) => String(a.from).localeCompare(String(b.from)));
    const t = timeOffs[0];
    return {
      documentId,
      name: doc.name,
      position: doc.position,
      tier: doc.tier || 'senior',
      isActive: doc.isActive !== false,
      left: isLeft(doc),
      published: Boolean(pub),
      updatedAt: doc.updatedAt,
      self: isSelfCard(session, doc, account),
      photo: photoOf(doc),
      hiredAt: ymdOf(doc.hiredAt),
      leftAt: ymdOf(doc.leftAt),
      // стирание личных данных (§8.2): только у ушедших; due — кнопку можно нажать
      erase: isLeft(doc)
        ? {
            dueAt: eraseDueDate(ymdOf(doc.leftAt)),
            due: Boolean(eraseDueDate(ymdOf(doc.leftAt)) && eraseDueDate(ymdOf(doc.leftAt)) <= today),
            erasedAt: doc.privateErasedAt || null,
          }
        : null,
      booking: {
        noonaEmployeeId: doc.noonaEmployeeId || null,
        calendarOrder: doc.calendarOrder ?? 0,
        bookingPriority: doc.bookingPriority ?? 0,
        servicesCount,
        hasSchedule: scheduled.has(documentId),
      },
      pay: {
        ratePercent: doc.ratePercent ?? null,
        excessThreshold: doc.excessThreshold ?? 0,
        rates,
        currentRate: rateOn(doc.rates, today),
        group: payrollGroupOf(doc),
      },
      // договор — только учёт (фаза 2): на ставки и зарплаты не влияет
      contracts: { list: contracts, current: contractOn(contracts, today) },
      checklist: buildChecklist(doc, {
        account,
        servicesCount,
        hasSchedule: scheduled.has(documentId),
        oficial: doc.oficial,
        documents: docKinds.get(documentId) || [],
        items,
        today,
      }),
      account: accountView(account),
      privateMissing: missing,
      documentsCount: docsCount,
      nextTimeOff: t ? { type: t.type, startDate: ymdOf(t.startDate), endDate: ymdOf(t.endDate) } : null,
      notes: notes.map((n) => noteView(n, session)),
      history: history.map((h) => ({
        action: h.action,
        actorName: h.actorName || '',
        summary: h.summary || '',
        details: h.details || null,
        createdAt: h.createdAt || null,
      })),
      flags: missingFlags(doc, { account, servicesCount, hasSchedule: scheduled.has(documentId), today }),
    };
  },

  /**
   * Личные данные + документы — отдельной ручкой, только при раскрытии секции.
   * Ключ `private`, не `oficial` (admin-session вырезает `oficial` из ответов).
   */
  async privateData({ session, id }: { session: any; id: unknown }) {
    const { doc } = await this._card(session, id, { oficial: true });
    const documents = await strapi.documents(DOC_UID).findMany({
      filters: { personal: { documentId: { $eq: doc.documentId } } },
      fields: DOC_FIELDS,
      sort: ['createdAt:desc'],
      limit: 200,
    });
    const values = pickPrivate(doc.oficial);
    return {
      documentId: doc.documentId,
      updatedAt: doc.updatedAt,
      private: { ...values, dateBirthYmd: birthToYmd(values.dateBirth) },
      missing: privateMissing(doc.oficial),
      documents: documents.map(docView),
    };
  },

  // ── запись секций ──────────────────────────────────────────────────────

  /** PATCH секции карточки: {section, data, base}. */
  async patch({ session, id, body, now = new Date() }: { session: any; id: unknown; body: any; now?: Date }) {
    const section = String(body?.section ?? '');
    if (!['basic', 'booking', 'pay', 'private'].includes(section)) {
      throw new StaffError(400, 'bad_section', 'Неизвестная секция карточки');
    }
    const today = this._today(now);
    const populate = section === 'private' ? { oficial: true } : {};
    const { doc, accounts } = await this._card(session, id, populate);
    assertBase(body?.base, doc);
    const documentId = doc.documentId;

    if (section === 'private') {
      const { next, changed } = normalizePrivate(body?.data, doc.oficial, Number(today.slice(0, 4)));
      if (!changed.length) return { ...(await this.privateData({ session, id: documentId })), unchanged: true };
      const oficial: Record<string, any> = { ...next };
      if (doc.oficial?.id != null) oficial.id = doc.oficial.id;
      await this._write(documentId, { oficial });
      const fields = changed.map((k) => PRIVATE_FIELDS[k].cs);
      this._log('staff_update', session, documentId, logSummary('private', doc.name, fields), { změněno: fields.join(', ') });
      return { ...(await this.privateData({ session, id: documentId })), unchanged: false };
    }

    let result;
    if (section === 'basic') result = normalizeBasic(body?.data, doc, today);
    else if (section === 'booking') {
      if (doc.position !== 'master') throw new StaffError(409, 'not_master', 'Приоритет записи — только у мастеров');
      result = normalizeBooking(body?.data, doc);
    } else result = normalizePay(body?.data, doc);
    if (!result.changes.length) return { ...(await this.card({ session, id: documentId, now })), unchanged: true };

    const data = { ...result.patch };
    const posChange = result.changes.find((c) => c.key === 'position');
    let account = null;
    if (posChange) {
      account = accountForCard(doc, accounts);
      if (isSelfCard(session, doc, account)) {
        throw new StaffError(409, 'self_position', 'Свою должность менять нельзя — вместе с ней сменится ваша роль входа');
      }
      if (account?.role === 'owner') throw new StaffError(409, 'owner_account', 'Учётка владельца из карточки не меняется');
      if (posChange.from === 'master') {
        const rows = await this._futureBookings(doc, now);
        if (rows.length) {
          throw new StaffError(
            409,
            'future_bookings',
            `У мастера ${rows.length} будущих броней — сначала перенесите их на других мастеров`,
            { bookings: rows }
          );
        }
      }
      if (posChange.to === 'master') {
        // колонка календаря: ключ — documentId карточки (§5а.3), место — в конце
        if (!cleanText(doc.noonaEmployeeId)) data.noonaEmployeeId = documentId;
        if (!(Number(doc.calendarOrder) > 0)) data.calendarOrder = await this._nextCalendarOrder();
      }
    }

    await this._write(documentId, data);

    const parts = changeParts(result.changes);
    if (posChange && account && account.role !== ROLE_BY_POSITION[posChange.to]) {
      const role = ROLE_BY_POSITION[posChange.to];
      await strapi.db.query(ADMIN_UID).update({ where: { id: account.id }, data: { role } });
      invalidateAdminAccount(account.id);
      parts.push(`role přihlášení: ${account.role} → ${role}`);
    }
    const details = Object.fromEntries(parts.map((p) => p.split(': ')).map(([k, ...v]) => [k, v.join(': ')]));
    this._log('staff_update', session, documentId, logSummary(section, doc.name, parts), details);
    return { ...(await this.card({ session, id: documentId, now })), unchanged: false };
  },

  /** Новая ставка с даты: {typeWork, rate, hourlyRate?, from, base}. */
  async addRate({ session, id, body, now = new Date() }: { session: any; id: unknown; body: any; now?: Date }) {
    const today = this._today(now);
    const { doc } = await this._card(session, id, { rates: true });
    assertBase(body?.base, doc);
    const plan = planNewRate(doc.rates || [], body, today);
    await this._write(doc.documentId, { rates: plan.rates });
    const parts = [`${rateLabel(plan.added)} od ${fmtDay(plan.added.from)}`];
    for (const c of plan.closed) parts.push(`${rateLabel(c)} do ${fmtDay(c.to)}`);
    this._log('staff_rate', session, doc.documentId, logSummary('rate', doc.name, parts), {
      nová: `${rateLabel(plan.added)} od ${fmtDay(plan.added.from)}`,
      ukončeno: plan.closed.map((c) => `${rateLabel(c)} do ${fmtDay(c.to)}`).join(', ') || '—',
    });
    return this.card({ session, id: doc.documentId, now });
  },

  // ── фаза 2: договоры (только учёт) ─────────────────────────────────────

  /** Договор карточки по id компонента (черновик) или 404. */
  _contractOf(doc: any, contractId: unknown) {
    const cid = Number(contractId);
    const found = Number.isSafeInteger(cid) && cid > 0 ? (doc.contracts || []).find((c) => Number(c.id) === cid) : null;
    if (!found) throw new StaffError(404, 'contract_not_found', 'Договор не найден');
    return found;
  },

  async _writeContracts(doc: any, list: any[]) {
    await this._write(doc.documentId, { contracts: contractRows(list) });
  },

  /** POST {type, from, to?, probationUntil?, ico?, note?, base}. */
  async addContract({ session, id, body, now = new Date() }: { session: any; id: unknown; body: any; now?: Date }) {
    const today = this._today(now);
    const { doc } = await this._card(session, id, { contracts: true });
    assertBase(body?.base, doc);
    if (isLeft(doc)) throw new StaffError(409, 'staff_left', 'Сотрудник завершил работу — новый договор не заводится');
    const { base, ...data } = body || {};
    const { contract, warnings } = normalizeContract(data, { others: doc.contracts || [], today });
    await this._writeContracts(doc, [...contractsOf(doc.contracts), contract]);
    this._log('staff_contract', session, doc.documentId, logSummary('contract_add', doc.name, [contractLabel(contract)]), {
      smlouva: contractLabel(contract),
      ...(contract.probationUntil ? { 'zkušební doba do': fmtDay(contract.probationUntil) } : {}),
    });
    return { ...(await this.card({ session, id: doc.documentId, now })), warnings };
  },

  /** PATCH …/contracts/:contractId {любые поля договора, base} — в т.ч. «закрыть датой» (`to`). */
  async updateContract({ session, id, contractId, body, now = new Date() }: { session: any; id: unknown; contractId: unknown; body: any; now?: Date }) {
    const today = this._today(now);
    const { doc } = await this._card(session, id, { contracts: true });
    assertBase(body?.base, doc);
    const cur = this._contractOf(doc, contractId);
    const { base, ...data } = body || {};
    const others = (doc.contracts || []).filter((c) => c !== cur);
    const { contract, warnings } = normalizeContract(data, { current: cur, others, today });
    const before = pickContract(cur);
    const changed = CONTRACT_KEYS.filter((k) => (before[k] ?? null) !== (contract[k] ?? null));
    if (!changed.length) return { ...(await this.card({ session, id: doc.documentId, now })), warnings, unchanged: true };
    const list = contractsOf(doc.contracts).map((c) => (c.id === before.id ? { ...contract, id: c.id } : c));
    await this._writeContracts(doc, list);
    const show = (k: string, v: any) => (v == null || v === '' ? '—' : ['from', 'to', 'probationUntil'].includes(k) ? fmtDay(v) : k === 'type' ? CONTRACT_TYPES[v] : String(v));
    const label = { type: 'typ', from: 'od', to: 'do', probationUntil: 'zkušební doba do', ico: 'IČO', note: 'poznámka' };
    const parts = changed.map((k) => `${label[k]}: ${show(k, before[k])} → ${show(k, contract[k])}`);
    this._log('staff_contract', session, doc.documentId, logSummary('contract_update', doc.name, [contractLabel(contract), ...parts]));
    return { ...(await this.card({ session, id: doc.documentId, now })), warnings, unchanged: false };
  },

  /** DELETE …/contracts/:contractId — только ещё не начавшийся (история не теряется). */
  async deleteContract({ session, id, contractId, body, now = new Date() }: { session: any; id: unknown; contractId: unknown; body: any; now?: Date }) {
    const today = this._today(now);
    const { doc } = await this._card(session, id, { contracts: true });
    assertBase(body?.base, doc);
    const cur = pickContract(this._contractOf(doc, contractId));
    if (cur.from && cur.from <= today) {
      throw new StaffError(409, 'contract_started', 'Начавшийся договор не удаляется — закройте его датой');
    }
    await this._writeContracts(doc, contractsOf(doc.contracts).filter((c) => c.id !== cur.id));
    this._log('staff_contract', session, doc.documentId, logSummary('contract_delete', doc.name, [contractLabel(cur)]));
    return this.card({ session, id: doc.documentId, now });
  },

  // ── фаза 2: онбординг-чек-лист ─────────────────────────────────────────

  /**
   * POST …/onboarding/:itemId {done} — отметка своего пункта (кто и когда). Без `base`:
   * отметка не спорит с правкой секций, а ответ — карточка с новым updatedAt.
   */
  async setOnboarding({ session, id, itemId, body, now = new Date() }: { session: any; id: unknown; itemId: unknown; body: any; now?: Date }) {
    if (typeof body?.done !== 'boolean') throw new StaffError(400, 'bad_field', 'done — да или нет');
    const { doc } = await this._card(session, id);
    if (isLeft(doc)) throw new StaffError(409, 'staff_left', 'Сотрудник завершил работу — чек-лист не ведётся');
    const iid = String(itemId ?? '');
    const items = DOC_ID.test(iid) ? await strapi.documents(CHECKLIST_UID).findMany({ filters: { documentId: { $eq: iid } }, fields: ['title', 'active'], limit: 1 }) : [];
    const item = items[0];
    if (!item) throw new StaffError(404, 'item_not_found', 'Пункт не найден');
    const marks = { ...onboardingOf(doc.onboarding) };
    const was = hasOwn(marks, iid);
    // выключенный пункт можно только снять (отметить заново — нет: он ушёл из чек-листа)
    if (body.done && item.active === false && !was) throw new StaffError(409, 'item_inactive', 'Пункт выключен');
    if (body.done === was) return { ...(await this.card({ session, id: doc.documentId, now })), unchanged: true };
    if (body.done) marks[iid] = { at: now.toISOString(), by: session?.username || '' };
    else delete marks[iid];
    await this._write(doc.documentId, { onboarding: marks });
    this._log('staff_onboarding', session, doc.documentId, logSummary(body.done ? 'onboarding_done' : 'onboarding_undone', doc.name, [cleanText(item.title)]));
    return { ...(await this.card({ session, id: doc.documentId, now })), unchanged: false };
  },

  /** Каталог своих пунктов (включая выключенные — для «Настроить пункты»). */
  async checklistItems() {
    return { items: (await this._checklistItems()).map(pickChecklistItem) };
  },

  async createChecklistItem({ body }: { session: any; body: any }) {
    const data = normalizeChecklistItem(body, { create: true });
    const rows = await this._checklistItems();
    if (rows.some((r) => lower(r.title) === lower(data.title))) throw new StaffError(409, 'item_exists', 'Такой пункт уже есть');
    const order = Math.max(0, ...rows.map((r) => Number(r.order) || 0)) + 10;
    await strapi.documents(CHECKLIST_UID).create({ data: { ...data, order, active: true } });
    return this.checklistItems();
  },

  async updateChecklistItem({ itemId, body }: { session: any; itemId: unknown; body: any }) {
    const iid = String(itemId ?? '');
    const rows = await this._checklistItems();
    const item = DOC_ID.test(iid) ? rows.find((r) => r.documentId === iid) : null;
    if (!item) throw new StaffError(404, 'item_not_found', 'Пункт не найден');
    const data = normalizeChecklistItem(body);
    if (data.title && rows.some((r) => r.documentId !== iid && lower(r.title) === lower(data.title))) {
      throw new StaffError(409, 'item_exists', 'Такой пункт уже есть');
    }
    await strapi.documents(CHECKLIST_UID).update({ documentId: iid, data });
    return this.checklistItems();
  },

  // ── фаза 2: «Мои данные» ───────────────────────────────────────────────

  /**
   * Своя карточка сотрудника — только чтение. Карточка — по связи учётки (без связи — по
   * имени, utils/staff-identity); чужую не запросить: id из запроса не берётся вовсе.
   * У владельца карточки нет — 404. Сканы не отдаются (ни storedName, ни ссылки):
   * скачивание — только руководству (решение s222). Без заметок, журнала и учётки.
   */
  async myCard({ session, now = new Date() }: { session: any; now?: Date }) {
    if (!session || session.role === 'owner') throw new StaffError(404, 'no_card', 'Карточки сотрудника у этой учётки нет');
    const today = this._today(now);
    const doc = await findSessionPersonal(strapi, session, {
      status: 'draft',
      fields: ['name', 'position', 'tier', 'hiredAt', 'ratePercent', 'isActive'],
      populate: { photo: { fields: ['url', 'formats'] }, rates: true, contracts: true, oficial: true },
    });
    if (!doc) throw new StaffError(404, 'no_card', 'Карточка сотрудника не найдена — скажите руководству');
    const docs = await strapi.documents(DOC_UID).findMany({
      filters: { personal: { documentId: { $eq: doc.documentId } } },
      fields: ['kind', 'title', 'validUntil'],
      sort: ['createdAt:desc'],
      limit: 200,
    });
    const values = pickPrivate(doc.oficial);
    // id компонентов — внутренняя деталь записи, наружу не идут
    const noId = ({ id: _id, ...c }: any) => c;
    const contracts = contractsOf(doc.contracts).map(noId);
    const current = contractOn(doc.contracts, today);
    const rate = rateOn(doc.rates, today);
    return {
      today,
      name: doc.name,
      position: doc.position,
      tier: doc.tier || 'senior',
      hiredAt: ymdOf(doc.hiredAt),
      photo: photoOf(doc),
      private: values,
      documents: docs.map((d) => {
        const validUntil = ymdOf(d.validUntil);
        return { kind: d.kind || 'other', title: d.title || '', validUntil, ...docState(validUntil, today) };
      }),
      contracts: { list: contracts, current: current ? noId(current) : null },
      pay:
        doc.position === 'master'
          ? { ratePercent: doc.ratePercent ?? null, currentRate: null }
          : { ratePercent: null, currentRate: rate ? { typeWork: rate.typeWork, rate: rate.rate, hourlyRate: rate.hourlyRate, from: rate.from } : null },
    };
  },

  // ── файлы ──────────────────────────────────────────────────────────────

  /** Закрытый каталог сканов (вне репозитория и public/). Без env — загрузка выключена. */
  async _storageDir() {
    const dir = await privateDir(process.env.STAFF_FILES_DIR, 'staff');
    if (!dir) throw new StaffError(503, 'storage_not_configured', 'Хранилище документов на сервере не настроено');
    return dir;
  },

  /**
   * Загрузка файла (multipart, поле `files`, `target` = photo | document).
   * Фото — в медиатеку (ImageKit, публично: сайт показывает его в выборе мастера).
   * Документ — в закрытый каталог + запись staff-document (`kind`, `title`, `validUntil` —
   * поля той же формы).
   */
  async uploadFile({ session, id, body, files, now = new Date() }: { session: any; id: unknown; body: any; files: any; now?: Date }) {
    const target = String(body?.target ?? '');
    if (target !== 'photo' && target !== 'document') throw new StaffError(400, 'bad_target', 'Загрузка — фото или документ');
    const file = files?.files;
    if (!file || Array.isArray(file) || !file.filepath) throw new StaffError(400, 'file_required', 'Выберите один файл');
    const size = Number(file.size) || 0;
    if (size <= 0) throw new StaffError(400, 'file_empty', 'Файл пустой');
    if (size > MAX_FILE_BYTES) throw new StaffError(413, 'file_too_big', 'Файл больше 10 МБ');
    const { doc } = await this._card(session, id);
    const type = detectFile(await readHead(file.filepath));
    if (!type) throw new StaffError(400, 'bad_file_type', 'Поддерживаются JPG, PNG, WEBP и PDF');
    const documentId = doc.documentId;

    if (target === 'photo') {
      if (!type.image) throw new StaffError(400, 'photo_not_image', 'Фото — JPG, PNG или WEBP');
      file.mimetype = type.mime;
      file.originalFilename = `${cleanText(doc.name) || 'foto'}.${type.ext}`;
      const [uploaded] = await strapi
        .plugin('upload')
        .service('upload')
        .upload({ data: { fileInfo: { name: file.originalFilename, alternativeText: doc.name } }, files: file });
      await this._write(documentId, { photo: uploaded.id });
      this._log('staff_file_add', session, documentId, logSummary('photo', doc.name), {});
      return this.card({ session, id: documentId, now });
    }

    const fileName = safeFileName(file.originalFilename, type.ext);
    const meta = normalizeDocMeta(body, { create: true, fileName });
    const dir = await this._storageDir();
    const { storedName } = await storePrivateFile(dir, file.filepath);
    let created;
    try {
      created = await strapi.documents(DOC_UID).create({
        data: { personal: documentId, ...meta, fileName, mime: type.mime, size, storedName, uploadedBy: session?.username || '' },
      });
    } catch (e) {
      await removePrivateFile(dir, storedName, `staff: скан ${storedName}`);
      throw e;
    }
    this._log('staff_file_add', session, documentId, logSummary('file_add', doc.name, [DOC_KINDS[meta.kind], meta.title]), {
      typ: DOC_KINDS[meta.kind],
      název: meta.title,
      ...(meta.validUntil ? { platnost: fmtDay(meta.validUntil) } : {}),
    });
    return { document: docView({ ...meta, fileName, mime: type.mime, size, uploadedBy: session?.username || '', ...created }) };
  },

  /** Документ этой карточки (с storedName) или 404. */
  async _docOf(session: any, id: unknown, fileId: unknown) {
    const { doc } = await this._card(session, id);
    const fid = String(fileId ?? '');
    if (!DOC_ID.test(fid)) throw new StaffError(404, 'file_not_found', 'Документ не найден');
    const rows = await strapi.documents(DOC_UID).findMany({
      filters: { documentId: { $eq: fid }, personal: { documentId: { $eq: doc.documentId } } },
      fields: [...DOC_FIELDS, 'storedName'],
      limit: 1,
    });
    if (!rows[0]) throw new StaffError(404, 'file_not_found', 'Документ не найден');
    return { doc, file: rows[0] };
  },

  /** Выдача документа потоком (контроллер ставит заголовки). */
  async download({ session, id, fileId }: { session: any; id: unknown; fileId: unknown }) {
    const { file } = await this._docOf(session, id, fileId);
    if (!STORED_NAME.test(String(file.storedName ?? ''))) throw new StaffError(404, 'file_not_found', 'Документ не найден');
    const opened = await openPrivateFile(await this._storageDir(), file.storedName);
    if (!opened) throw new StaffError(404, 'file_missing', 'Файл документа на сервере не найден');
    return {
      stream: opened.stream,
      size: opened.size,
      mime: file.mime || 'application/octet-stream',
      fileName: safeFileName(file.fileName),
      disposition: contentDisposition(safeFileName(file.fileName)),
    };
  },

  /** Тип / название / «действует до». */
  async updateFile({ session, id, fileId, body }: { session: any; id: unknown; fileId: unknown; body: any }) {
    const { doc, file } = await this._docOf(session, id, fileId);
    const meta = normalizeDocMeta(body);
    await strapi.documents(DOC_UID).update({ documentId: file.documentId, data: meta });
    const parts = [];
    if (meta.kind && meta.kind !== file.kind) parts.push(`typ: ${DOC_KINDS[file.kind] || '—'} → ${DOC_KINDS[meta.kind]}`);
    if (meta.title && meta.title !== file.title) parts.push(`název: ${file.title || '—'} → ${meta.title}`);
    if (hasOwn(meta, 'validUntil') && meta.validUntil !== ymdOf(file.validUntil)) {
      parts.push(`platnost: ${file.validUntil ? fmtDay(ymdOf(file.validUntil)) : '—'} → ${meta.validUntil ? fmtDay(meta.validUntil) : '—'}`);
    }
    if (parts.length) {
      this._log('staff_file_update', session, doc.documentId, logSummary('file_update', doc.name, [meta.title || file.title, ...parts]));
    }
    return { document: docView({ ...file, ...meta }) };
  },

  /** Удалить документ: запись, затем файл с диска. */
  async deleteFile({ session, id, fileId }: { session: any; id: unknown; fileId: unknown }) {
    const { doc, file } = await this._docOf(session, id, fileId);
    await strapi.documents(DOC_UID).delete({ documentId: file.documentId });
    if (STORED_NAME.test(String(file.storedName ?? ''))) {
      const dir = await this._storageDir().catch(() => null);
      await removePrivateFile(dir, file.storedName, `staff: файл ${file.documentId}`);
    }
    this._log('staff_file_delete', session, doc.documentId, logSummary('file_delete', doc.name, [DOC_KINDS[file.kind] || '—', file.title || '']));
    return { deleted: file.documentId };
  },

  // ── заметки руководства ────────────────────────────────────────────────

  async _notes(session: any, documentId: string) {
    const rows = await strapi.documents(NOTE_UID).findMany({
      filters: { personal: { documentId: { $eq: documentId } } },
      fields: ['text', 'authorName', 'authorAccountId', 'createdAt', 'updatedAt'],
      sort: ['createdAt:desc'],
      limit: 200,
    });
    return rows.map((n) => noteView(n, session));
  },

  async addNote({ session, id, body }: { session: any; id: unknown; body: any }) {
    const { doc } = await this._card(session, id);
    const text = normalizeNoteText(body?.text);
    await strapi.documents(NOTE_UID).create({
      data: { personal: doc.documentId, text, authorName: session?.username || '', authorAccountId: Number(session?.id) || null },
    });
    this._log('staff_note', session, doc.documentId, logSummary('note_add', doc.name));
    return { notes: await this._notes(session, doc.documentId) };
  },

  /** Заметка этой карточки, которую сессия вправе менять (автор или владелец). */
  async _ownNote(session: any, id: unknown, noteId: unknown) {
    const { doc } = await this._card(session, id);
    const nid = String(noteId ?? '');
    if (!DOC_ID.test(nid)) throw new StaffError(404, 'note_not_found', 'Заметка не найдена');
    const rows = await strapi.documents(NOTE_UID).findMany({
      filters: { documentId: { $eq: nid }, personal: { documentId: { $eq: doc.documentId } } },
      fields: ['text', 'authorName', 'authorAccountId'],
      limit: 1,
    });
    const note = rows[0];
    if (!note) throw new StaffError(404, 'note_not_found', 'Заметка не найдена');
    if (!noteView(note, session).canEdit) throw new StaffError(403, 'note_not_yours', 'Менять заметку может только её автор или владелец');
    return { doc, note };
  },

  async updateNote({ session, id, noteId, body }: { session: any; id: unknown; noteId: unknown; body: any }) {
    const { doc, note } = await this._ownNote(session, id, noteId);
    const text = normalizeNoteText(body?.text);
    if (text !== note.text) {
      await strapi.documents(NOTE_UID).update({ documentId: note.documentId, data: { text } });
      this._log('staff_note', session, doc.documentId, logSummary('note_update', doc.name, [`autor: ${note.authorName || '—'}`]));
    }
    return { notes: await this._notes(session, doc.documentId) };
  },

  async deleteNote({ session, id, noteId }: { session: any; id: unknown; noteId: unknown }) {
    const { doc, note } = await this._ownNote(session, id, noteId);
    await strapi.documents(NOTE_UID).delete({ documentId: note.documentId });
    this._log('staff_note', session, doc.documentId, logSummary('note_delete', doc.name, [`autor: ${note.authorName || '—'}`]));
    return { notes: await this._notes(session, doc.documentId) };
  },

  // ── шаг 4: новый сотрудник ─────────────────────────────────────────────

  /**
   * Новый сотрудник: {name, position, tier?, hiredAt?, ratePercent?, rate?, private?, account?}.
   * Карточка создаётся сразу опубликованной; мастеру вторым шагом ключ колонки календаря =
   * documentId карточки (§5а.3) и место в конце. Учётка — логин = имя, роль по должности,
   * пароль в ответе один раз. Сбой после создания карточки — карточка удаляется целиком
   * (истории у неё ещё нет), чтобы повтор не упёрся в «имя занято».
   */
  async create({ session, body, now = new Date() }: { session: any; body: any; now?: Date }) {
    const today = this._today(now);
    const input = normalizeCreate(body, today);
    const [accounts, cards] = await Promise.all([this._accounts(), this._allCards()]);
    assertNameFree(input.name, cards, accounts);
    const master = input.position === 'master';
    const data: Record<string, any> = {
      name: input.name,
      position: input.position,
      // булевы и числа — явно: default схемы до базы не доезжает (гоча $ne + NULL)
      isActive: true,
      tier: input.tier,
      hiredAt: input.hiredAt,
      bookingPriority: 0,
      excessThreshold: 0,
      rates: input.rate ? [input.rate] : [],
    };
    if (master) {
      data.calendarOrder = await this._nextCalendarOrder();
      if (input.ratePercent != null) data.ratePercent = input.ratePercent;
    }
    if (input.private) data.oficial = { ...input.private };
    const created = await strapi.documents(PERSONAL_UID).create({ data, status: 'published' });
    const documentId = created.documentId;
    let account = null;
    try {
      if (master) await this._write(documentId, { noonaEmployeeId: documentId });
      if (input.account) account = await this._createAccount(input.name, ROLE_BY_POSITION[input.position], documentId);
    } catch (e) {
      await strapi
        .documents(PERSONAL_UID)
        .delete({ documentId })
        .catch((err) => strapi.log.error(`staff: карточка ${documentId} после сбоя не удалена: ${err.message}`));
      throw e;
    }
    const parts = [POSITIONS[input.position]];
    if (master && input.tier === 'junior') parts.push('junior');
    parts.push(`nástup ${fmtDay(input.hiredAt)}`);
    if (input.ratePercent != null) parts.push(`podíl ${input.ratePercent} %`);
    if (input.rate) parts.push(`${rateLabel(input.rate)} od ${fmtDay(input.rate.from)}`);
    if (input.private) parts.push('osobní údaje vyplněny');
    if (account) parts.push(`přístup: ${ROLE_BY_POSITION[input.position]}`);
    this._log('staff_create', session, documentId, logSummary('create', input.name, parts));
    const card = await this.card({ session, id: documentId, now });
    return { ...card, password: account ? account.password : null };
  },

  // ── шаг 4: учётка из карточки ─────────────────────────────────────────

  /**
   * {action: create | disable | enable | reset_password}. Учётка owner из карточки не
   * меняется; свою — нельзя отключить. Отключение гасит сессию сразу: сброс кэша учётки,
   * middleware на следующем запросе видит isActive=false (s223).
   */
  async account({ session, id, body, now = new Date() }: { session: any; id: unknown; body: any; now?: Date }) {
    const action = String(body?.action ?? '');
    if (!['create', 'disable', 'enable', 'reset_password'].includes(action)) {
      throw new StaffError(400, 'bad_action', 'Неизвестное действие с учёткой');
    }
    const { doc, accounts } = await this._card(session, id);
    const documentId = doc.documentId;
    const account = accountForCard(doc, accounts);
    if (account?.role === 'owner') throw new StaffError(409, 'owner_account', 'Учётка владельца из карточки не меняется');
    const self = isSelfCard(session, doc, account);
    let password = null;
    let unchanged = false;

    if (action === 'create') {
      if (account) throw new StaffError(409, 'account_exists', 'У сотрудника уже есть учётка');
      if (isLeft(doc)) throw new StaffError(409, 'staff_left', 'Сотрудник завершил работу — учётка не нужна');
      const role = ROLE_BY_POSITION[doc.position];
      if (!role) throw new StaffError(409, 'bad_position', 'У карточки не указана должность');
      // логин занят учёткой, связанной с другой карточкой (s229) — иначе уникальность упала бы 500
      if (accounts.some((a) => lower(a.username) === lower(doc.name))) {
        throw new StaffError(409, 'name_taken', 'Такой логин уже занят другой учёткой');
      }
      // логин = имя карточки; учётки с этим логином нет — assertNameFree при создании и
      // переименовании карточки (без учёта регистра); связь — на эту карточку
      const created = await this._createAccount(doc.name, role, documentId);
      password = created.password;
      this._log('staff_account', session, documentId, logSummary('account_create', doc.name, [`role: ${role}`]));
    } else {
      if (!account) throw new StaffError(404, 'account_not_found', 'У сотрудника нет учётки');
      if (action === 'disable') {
        if (self) throw new StaffError(409, 'self_account', 'Свою учётку отключить нельзя');
        if (account.isActive !== true) unchanged = true;
        else {
          await this._updateAccount(account.id, { isActive: false });
          this._log('staff_account', session, documentId, logSummary('account_disable', doc.name));
        }
      } else if (action === 'enable') {
        if (isLeft(doc)) throw new StaffError(409, 'staff_left', 'Сотрудник завершил работу — вход не включается');
        if (account.isActive === true) unchanged = true;
        else {
          await this._updateAccount(account.id, { isActive: true });
          this._log('staff_account', session, documentId, logSummary('account_enable', doc.name));
        }
      } else {
        if (isLeft(doc)) throw new StaffError(409, 'staff_left', 'Сотрудник завершил работу — пароль не нужен');
        password = genPassword();
        await this._updateAccount(account.id, { password: await bcrypt.hash(password, 10) });
        this._log('staff_account', session, documentId, logSummary('account_password', doc.name));
      }
    }
    const card = await this.card({ session, id: documentId, now });
    return { ...card, password, unchanged };
  },

  // ── шаг 4: переименование ─────────────────────────────────────────────

  /**
   * {name, base}: имя карточки (обе версии) + логин учётки одним действием. Сессия
   * переименованного гаснет (`username_changed`) — вход уже с новым логином.
   * `employee_name_raw` броней и блоков — историческая подпись, не трогается.
   */
  async rename({ session, id, body, now = new Date() }: { session: any; id: unknown; body: any; now?: Date }) {
    const { doc, accounts } = await this._card(session, id);
    assertBase(body?.base, doc);
    const documentId = doc.documentId;
    if (isLeft(doc)) throw new StaffError(409, 'staff_left', 'Ушедшего сотрудника не переименовывают');
    const name = normalizeName(body?.name);
    if (name === doc.name) return { ...(await this.card({ session, id: documentId, now })), unchanged: true };
    const account = accountForCard(doc, accounts);
    if (isSelfCard(session, doc, account)) {
      throw new StaffError(409, 'self_rename', 'Себя переименовать нельзя — сменится ваш логин');
    }
    if (account?.role === 'owner') throw new StaffError(409, 'owner_account', 'Учётка владельца из карточки не меняется');
    assertNameFree(name, await this._allCards(), accounts, { exceptDocId: documentId, exceptAccountId: account?.id ?? null });

    await this._write(documentId, { name });
    if (account) {
      try {
        await this._updateAccount(account.id, { username: name });
      } catch (e) {
        // карточка и логин должны совпадать (инвариант имени) — вернуть имя карточки
        await this._write(documentId, { name: doc.name }).catch((err) =>
          strapi.log.error(`staff: имя карточки ${documentId} не возвращено после сбоя: ${err.message}`)
        );
        throw e;
      }
    }
    const parts = [`${doc.name} → ${name}`];
    if (account) parts.push('login změněn');
    this._log('staff_rename', session, documentId, logSummary('rename', name, parts), { dříve: doc.name, nyní: name });
    return { ...(await this.card({ session, id: documentId, now })), unchanged: false, accountRenamed: Boolean(account) };
  },

  // ── шаг 4: «Завершить работу» ─────────────────────────────────────────

  async _futurePlanBlocks(documentId: string, today: string) {
    return strapi.documents(TIME_BLOCK_UID).findMany({
      filters: { noonaKey: { $eq: `${PLAN_KEY_PREFIX}${documentId}` }, date: { $gte: today } },
      fields: ['date'],
      limit: 5000,
    });
  },

  /** Что мешает завершить работу — одни и те же правила для предпросмотра и действия. */
  _leaveBlockers(doc: any, account: any, session: any, bookings: any[]) {
    const out = [];
    if (isLeft(doc)) out.push('staff_left');
    if (isSelfCard(session, doc, account)) out.push('self_leave');
    if (account?.role === 'owner') out.push('owner_account');
    if (bookings.length) out.push('future_bookings');
    return out;
  },

  /** Предпросмотр: будущие брони (запрет), блоки плана, открытые ставки, учётка. */
  async leavePreview({ session, id, now = new Date() }: { session: any; id: unknown; now?: Date }) {
    const today = this._today(now);
    const { doc, accounts } = await this._card(session, id, { rates: true });
    const [bookings, planBlocks] = await Promise.all([
      this._futureBookings(doc, now),
      this._futurePlanBlocks(doc.documentId, today),
    ]);
    const account = accountForCard(doc, accounts);
    return {
      documentId: doc.documentId,
      name: doc.name,
      updatedAt: doc.updatedAt,
      today,
      hiredAt: ymdOf(doc.hiredAt),
      bookings,
      planBlocks: planBlocks.length,
      openRates: (doc.rates || []).map(pickRate).filter((r) => !r.to || r.to >= today),
      account: accountView(account),
      blockers: this._leaveBlockers(doc, account, session, bookings),
    };
  },

  /**
   * {leftAt?, base}: карточка неактивна + дата ухода, ставки закрыты датой ухода, учётка
   * отключена (сессия гаснет сразу), будущие блоки плана сняты (cron их не вернёт —
   * неактивному плана не положено). Брони не трогаются: пока они есть — 409 со списком.
   * Связи `services` остаются (история каталога; сайт фильтрует по isActive).
   */
  async leave({ session, id, body, now = new Date() }: { session: any; id: unknown; body: any; now?: Date }) {
    const today = this._today(now);
    const { doc, accounts } = await this._card(session, id, { rates: true });
    assertBase(body?.base, doc);
    const documentId = doc.documentId;
    const account = accountForCard(doc, accounts);
    const early = this._leaveBlockers(doc, account, session, []);
    if (early.includes('staff_left')) throw new StaffError(409, 'staff_left', 'Сотрудник уже завершил работу');
    if (early.includes('self_leave')) throw new StaffError(409, 'self_leave', 'Себе завершить работу нельзя');
    if (early.includes('owner_account')) throw new StaffError(409, 'owner_account', 'Учётка владельца из карточки не меняется');
    const leftAt = normalizeLeftAt(body?.leftAt, ymdOf(doc.hiredAt), today);
    const bookings = await this._futureBookings(doc, now);
    if (bookings.length) {
      throw new StaffError(
        409,
        'future_bookings',
        `У сотрудника ${bookings.length} будущих броней — сначала перенесите их на других мастеров`,
        { bookings }
      );
    }
    const plan = planLeave(doc.rates || [], leftAt);
    const data: Record<string, any> = { isActive: false, leftAt };
    if (plan.closed.length) data.rates = plan.rates;
    await this._write(documentId, data);

    const parts = [`od ${fmtDay(leftAt)}`];
    for (const c of plan.closed) parts.push(`${rateLabel(c)} do ${fmtDay(c.to)}`);
    if (account && account.isActive === true) {
      await this._updateAccount(account.id, { isActive: false });
      parts.push('přístup vypnut');
    }
    const blocks = await this._futurePlanBlocks(documentId, today);
    for (const b of blocks) await strapi.documents(TIME_BLOCK_UID).delete({ documentId: b.documentId });
    if (blocks.length) parts.push(`bloky plánu: −${blocks.length}`);
    this._log('staff_leave', session, documentId, logSummary('leave', doc.name, parts));
    return { ...(await this.card({ session, id: documentId, now })), planBlocksDeleted: blocks.length };
  },

  // ── шаг 4: стирание личных данных через 3 года ────────────────────────

  /**
   * {confirmName, base}: у ушедшего, если с даты ухода прошло 3 года. Стираются личные
   * данные (`oficial`, банк, экстренный контакт), сканы (закрытый каталог), заметки
   * руководства. Остаются имя, должность, даты,
   * фото и вся зарплатная история. В журнал — только факт и автор.
   */
  async erase({ session, id, body, now = new Date() }: { session: any; id: unknown; body: any; now?: Date }) {
    const today = this._today(now);
    const { doc } = await this._card(session, id, { oficial: true });
    assertBase(body?.base, doc);
    const documentId = doc.documentId;
    if (!isLeft(doc)) throw new StaffError(409, 'staff_not_left', 'Стирание — только у ушедших сотрудников');
    const leftAt = ymdOf(doc.leftAt);
    if (!leftAt) throw new StaffError(409, 'left_at_missing', 'Не указана дата ухода — заполните её в карточке');
    const due = eraseDueDate(leftAt);
    if (!due || due > today) throw new StaffError(409, 'erase_too_early', `Стереть можно с ${fmtDay(due || leftAt)} — через 3 года после ухода`);
    if (lower(body?.confirmName) !== lower(doc.name)) {
      throw new StaffError(400, 'confirm_mismatch', 'Для подтверждения введите имя сотрудника точно');
    }

    const [files, notes] = await Promise.all([
      strapi.documents(DOC_UID).findMany({
        filters: { personal: { documentId: { $eq: documentId } } },
        fields: ['storedName'],
        limit: 1000,
      }),
      strapi.documents(NOTE_UID).findMany({ filters: { personal: { documentId: { $eq: documentId } } }, fields: ['text'], limit: 1000 }),
    ]);

    const oficial: Record<string, any> = Object.fromEntries(PRIVATE_KEYS.map((k) => [k, '']));
    if (doc.oficial?.id != null) oficial.id = doc.oficial.id;
    await this._write(documentId, { oficial, privateErasedAt: now.toISOString() });

    const dir = files.length ? await this._storageDir().catch(() => null) : null;
    for (const f of files) {
      await strapi.documents(DOC_UID).delete({ documentId: f.documentId });
      await removePrivateFile(dir, f.storedName, `staff: скан ${f.documentId}`);
    }
    for (const n of notes) await strapi.documents(NOTE_UID).delete({ documentId: n.documentId });
    this._log('staff_erase', session, documentId, logSummary('erase', doc.name));
    return {
      ...(await this.card({ session, id: documentId, now })),
      erased: { documents: files.length, notes: notes.length },
    };
  },
};
