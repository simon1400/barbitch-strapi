// @ts-nocheck
// Сжатая выгрузка данных для аналитики админки.
//
// Зачем: вкладки «Спящие / Возвращаемость / Прогноз / Отмены / Клиенты /
// Дозаписи» считаются по ВСЕЙ истории броней. Раньше админка тянула её сама —
// `/api/bookings` постранично (500 на страницу, ~10 запросов) со всеми полями
// снапшота услуг и вложенным клиентом: ~2.9 МБ JSON, из которых аналитике нужны
// восемь скалярных полей. Здесь проекция делается на сервере одним SQL-запросом,
// а наружу уходит колоночный массив — тот же набор событий в ~4 раза меньшем
// объёме и за ОДИН запрос.
//
// Формат намеренно колоночный (массив массивов, порядок = HISTORY_COLS):
// повторять имена восьми ключей на каждой из ~4700 строк — это ещё ~500 КБ.
//
// ⚠️ Порядок и семантика колонок должны совпадать с `HistEvent` в
// admin/src/pages/global/analytics/fetch/eventsHistory.ts — там же обратная
// сборка объектов. Меняешь одно — меняй и второе.

const HISTORY_COLS = [
  'customer', // стабильный id клиента: noonaCustomerId (совместимость с email-campaign-log) или documentId
  'customerName', // ТЕКУЩЕЕ имя из relation, фолбэк — снимок в брони
  'employee', // noonaEmployeeId
  'status',
  'date', // 'YYYY-MM-DD'
  'createdAt', // ISO: когда бронь создана (атрибуция дозаписей/рассылок)
  'price',
  'durationMin',
];

// Строка `date` берётся из БД через to_char: колонка типа `date`, а node-pg
// разобрал бы её в JS-Date по локальной зоне процесса — при сервере не в UTC
// день уехал бы на сутки. Метки времени, наоборот, отдаём как Date → toISOString,
// то есть ровно тем же путём, каким их сериализует REST Strapi.
const iso = (v) => {
  if (!v) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString();
  return String(v);
};

const durationMin = (startsAt, endsAt) => {
  if (!startsAt || !endsAt) return 0;
  const a = new Date(startsAt).getTime();
  const b = new Date(endsAt).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, (b - a) / 60000);
};

export default {
  /**
   * ВСЯ история броней в колоночном виде + снимки имён мастеров.
   *
   * empNames — снимки `employee_name_raw` (покрывают и уволенных, по которым в
   * `personal` записи уже нет). Актуальные имена активных мастеров админка
   * накладывает сверху сама, отдельным маленьким запросом к `/api/personals`.
   */
  async history() {
    const knex = strapi.db.connection;

    const rows = await knex('bookings as b')
      .leftJoin('bookings_client_lnk as l', 'l.booking_id', 'b.id')
      .leftJoin('clients as c', 'c.id', 'l.client_id')
      // интерные брони (s203) в клиентскую аналитику не идут; coalesce обязателен —
      // у старых броней колонка NULL, и `<> true` выкинул бы их все
      .whereRaw('coalesce(b.internal, false) = false')
      .select(
        knex.raw("to_char(b.date, 'YYYY-MM-DD') as date"),
        'b.client_name_raw',
        'b.employee_name_raw',
        'b.noona_employee_id',
        'b.status',
        'b.starts_at',
        'b.ends_at',
        'b.total_price',
        'b.noona_created_at',
        'b.created_at',
        'c.document_id as client_doc_id',
        'c.noona_customer_id',
        'c.name as client_name'
      )
      .orderBy([{ column: 'b.date', order: 'asc' }, { column: 'b.id', order: 'asc' }]);

    // Бронь без даты в события не идёт (прежний клиентский `toHist` возвращал по
    // ней null), но её снимок имени мастера в карту ниже попасть ОБЯЗАН — иначе
    // фильтровать было бы правильнее в SQL. Именно так вело себя прежнее место:
    // выборка тянула все брони, а отбрасывал их уже маппер.
    const events = rows
      .filter((r) => r.date)
      .map((r) => [
        r.client_doc_id ? r.noona_customer_id || r.client_doc_id : '',
        r.client_name || r.client_name_raw || '',
        r.noona_employee_id ?? '',
        r.status ?? '',
        String(r.date),
        iso(r.noona_created_at) || iso(r.created_at),
        Number(r.total_price) || 0,
        durationMin(r.starts_at, r.ends_at),
      ]);

    // Имя-снимок мастера: побеждает самая поздняя непустая запись — так же, как
    // в прежнем клиентском коде, где карта заполнялась по списку, отсортированному
    // по дате, и последнее присваивание перекрывало предыдущие.
    const empNames = new Map();
    for (const r of rows) {
      const id = r.noona_employee_id;
      const name = (r.employee_name_raw ?? '').trim();
      if (id && name) empNames.set(id, name);
    }

    return { cols: HISTORY_COLS, events, empNames: [...empNames.entries()] };
  },

  /**
   * Клиенты одним запросом, колоночно.
   *
   * `withContacts=false` — только ключ и имя (сверке смены больше ничего не
   * нужно, а телефоны с адресами почти ВСЕХ клиентов салона незачем возить в
   * браузер ради пере-матча имён).
   */
  async clients({ withContacts = true } = {}) {
    const knex = strapi.db.connection;
    const cols = withContacts
      ? ['customer', 'name', 'phone', 'email']
      : ['customer', 'name'];

    const rows = await knex('clients')
      .select('document_id', 'noona_customer_id', 'name', 'phone', 'email')
      .orderBy('id', 'asc');

    const clients = rows.map((r) => {
      const key = r.noona_customer_id || r.document_id;
      return withContacts
        ? [key, r.name ?? '', r.phone ?? '', r.email ?? '']
        : [key, r.name ?? ''];
    });

    return { cols, clients };
  },
};
