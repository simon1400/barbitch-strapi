/**
 * Списывание с зарплаты за интерную услугу (Interní rezervace, s203).
 *
 * Решение владельца (§1а.2 промпта): салон с интерной услуги не берёт ничего,
 * мастер получает свой процент — и **ровно эта сумма сразу записывается
 * сотруднику-получателю как «Списывание с зарплаты»** (`payroll`, «Odpis za služby»
 * в кабинете). Черновик заводится вместе с бронью, владелец публикует его на
 * закрытии смены — там черновики `payrolls` дня публикуются уже сегодня.
 *
 * Образец — комиссия администратора за дозапись (`add-money` с `source='upsell'`,
 * s197): черновик из календаря → гейт «только checkedOut» на закрытии смены →
 * карточка рядом. Опубликованную запись не трогает ничто.
 *
 * До этой сессии владелец заводил такие списания РУКАМИ в Strapi CM
 * (напр. 09.08 Viktoriia −396 «Lash lifting + Barveni ras от Наташи» ровно
 * к интерной услуге #7555, где staffSalaries = 396).
 *
 * ВАЖНО: модуль самодостаточен (ни одного импорта) — чистые функции тестируются
 * в изоляции без БД/Strapi (strapi/tests/internal-payroll.test.mjs). `strapi`
 * используется как глобал и только внутри методов.
 */

const PAYROLL_UID = 'api::payroll.payroll';

/** Метка источника: отличает наши черновики от ручных записей владельца. */
export const INTERNAL_PAYROLL_SOURCE = 'internal';

const CS_MONTH_DAY = (d: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || ''))) return String(d || '');
  const dt = new Date(`${d}T00:00:00Z`);
  return `${dt.getUTCDate()}. ${dt.getUTCMonth() + 1}.`;
};

/**
 * Сумма списания = доля мастера = цена × процент мастера, округлённая до кроны
 * (`payroll.sum` — biginteger). Прод-образец: 990 Kč × 40 % = 396.
 */
export const internalPayrollSum = ({
  price,
  ratePercent,
}: {
  price: number | string | null | undefined;
  ratePercent: number | string | null | undefined;
}): number => {
  const p = Number(price);
  const r = Number(ratePercent);
  if (!Number.isFinite(p) || !Number.isFinite(r)) return 0;
  return Math.round((p * r) / 100);
};

/** Описание записи — как владелец писал руками: услуга + у кого + когда. */
export const internalPayrollComment = ({
  serviceTitle,
  masterName,
  date,
}: {
  serviceTitle?: string | null;
  masterName?: string | null;
  date?: string | null;
}): string => {
  const svc = String(serviceTitle || '').trim() || 'Interní služba';
  const master = String(masterName || '').trim();
  const day = CS_MONTH_DAY(String(date || ''));
  const at = master ? ` u ${master}` : '';
  const when = day ? ` (interní rezervace ${day})` : ' (interní rezervace)';
  return `${svc}${at}${when}`;
};

/**
 * Названия услуг брони одной строкой «A + B» — для описания списания.
 * Снапшот приходит и массивом (json-поле документа), и строкой (наш upd.services).
 */
export const internalServiceTitles = (raw: unknown): string => {
  let arr: any = raw;
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw);
    } catch {
      return '';
    }
  }
  if (!Array.isArray(arr)) return '';
  return arr
    .map((s) => String(s?.title || '').trim())
    .filter(Boolean)
    .join(' + ');
};

const rel = (documentId: string | null | undefined) => (documentId ? { documentId } : null);

const BOOKING_UID = 'api::booking.booking';

export default {
  /** Черновик списания этой брони (у опубликованной документ тот же). */
  async _findDrafts(bookingDocId: string) {
    if (!bookingDocId) return [];
    return strapi.documents(PAYROLL_UID).findMany({
      status: 'draft',
      filters: {
        source: INTERNAL_PAYROLL_SOURCE,
        booking: { documentId: { $eq: bookingDocId } },
      },
      fields: ['sum', 'date', 'comment'],
      limit: 10,
    });
  },

  async _isPublished(documentId: string) {
    const pub = await strapi.documents(PAYROLL_UID).findOne({
      documentId,
      status: 'published',
      fields: ['sum'],
    });
    return Boolean(pub);
  },

  /**
   * Завести черновик списания. Без карточки получателя (`personal`) записи нет —
   * бронь при этом остаётся, причина уходит в ответ (как `no_personal` у комиссии).
   */
  async createDraft({
    bookingDocId,
    recipientDocId,
    date,
    sum,
    comment,
  }: {
    bookingDocId: string;
    recipientDocId: string | null;
    date: string;
    sum: number;
    comment: string;
  }) {
    if (!recipientDocId) return { created: false, reason: 'no_personal' as const };
    const row = await strapi.documents(PAYROLL_UID).create({
      status: 'draft',
      data: {
        date,
        sum: String(sum),
        comment,
        personal: rel(recipientDocId),
        source: INTERNAL_PAYROLL_SOURCE,
        booking: rel(bookingDocId),
      },
    });
    strapi.log.info(
      `internal-payroll: draft ${row.documentId} created for booking ${bookingDocId} (${sum} Kč)`
    );
    return { created: true as const, documentId: row.documentId, sum };
  },

  /**
   * Выровнять черновик под новые данные брони (смена услуги/цены/мастера/даты,
   * а при закрытии визита — под фактически введённый `staffSalaries`).
   * Опубликованную запись не трогаем: смена уже посчитана.
   */
  async syncDraft(bookingDocId: string, patch: { sum?: number; comment?: string; date?: string }) {
    const rows = await this._findDrafts(bookingDocId);
    let updated = 0;
    for (const r of rows) {
      if (await this._isPublished(r.documentId)) {
        strapi.log.info(
          `internal-payroll: draft ${r.documentId} of booking ${bookingDocId} already published — kept`
        );
        continue;
      }
      const data: Record<string, unknown> = {};
      if (patch.sum != null) data.sum = String(patch.sum);
      if (patch.comment != null) data.comment = patch.comment;
      if (patch.date != null) data.date = patch.date;
      if (!Object.keys(data).length) continue;
      await strapi.documents(PAYROLL_UID).update({ documentId: r.documentId, status: 'draft', data });
      updated += 1;
    }
    return updated;
  },

  /**
   * Пересчитать черновик по ТЕКУЩЕМУ состоянию брони: смена услуги/цены меняет сумму,
   * смена мастера — и процент, перенос на другой день — дату (владелец публикует
   * черновики дня на закрытии смены, поэтому дата обязана ехать вместе с бронью).
   * Вызывается из adminPatchBooking; на обычной брони не делает ничего.
   */
  async resyncForBooking(bookingDocId: string) {
    if (!bookingDocId) return 0;
    const booking = await strapi.documents(BOOKING_UID).findOne({
      documentId: bookingDocId,
      fields: ['date', 'totalPrice', 'services', 'internal'],
      populate: { employee: { fields: ['name', 'ratePercent'] } },
    });
    if (!booking || booking.internal !== true) return 0;
    const date = String(booking.date);
    const sum = internalPayrollSum({
      price: booking.totalPrice,
      ratePercent: booking.employee?.ratePercent,
    });
    const comment = internalPayrollComment({
      serviceTitle: internalServiceTitles(booking.services),
      masterName: booking.employee?.name,
      date,
    });
    return this.syncDraft(bookingDocId, { sum, comment, date });
  },

  /**
   * Снять черновик вместе с бронью (отмена/неявка/удаление).
   * Опубликованный (смена закрыта) остаётся — как у комиссии за дозапись.
   */
  async dropDraft(bookingDocId: string) {
    const rows = await this._findDrafts(bookingDocId);
    let deleted = 0;
    for (const r of rows) {
      if (await this._isPublished(r.documentId)) {
        strapi.log.info(
          `internal-payroll: draft ${r.documentId} of booking ${bookingDocId} already published — kept`
        );
        continue;
      }
      await strapi.documents(PAYROLL_UID).delete({ documentId: r.documentId });
      deleted += 1;
      strapi.log.info(`internal-payroll: draft ${r.documentId} removed with booking ${bookingDocId}`);
    }
    return deleted;
  },
};
