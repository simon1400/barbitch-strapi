// @ts-nocheck
// Отписка по ссылке из письма (s271).
//
// Флаг тот же, что и раньше — `client.reminderOptOut`: его проверяют напоминание
// «Čas na další návštěvu», просьба об отзыве и маркетинговые рассылки (campaign).
// Отписка одним кликом снимает клиента со ВСЕХ этих писем; транзакционные
// (подтверждение, напоминание о брони, отмена) идут как раньше.
//
// Дубли карточек: у одной почты бывает несколько клиентов. Флаг ставим/снимаем
// у всех карточек с этой почтой (сравнение без регистра, `$eqi`) — иначе письмо
// ушло бы по второй карточке. Campaign и так берёт строгий вариант по почте.
//
// Журнал — api::unsubscribe.unsubscribe-log: каждая смена статуса = строка;
// причина из опроса дописывается в последнюю строку «unsubscribe» этого клиента.
// Повторная отписка уже отписанного (кнопка почтовика жмётся дважды, сканер
// ссылок) — без новой строки.

import {
  verifyUnsubscribeToken,
  maskEmail,
  reasonOf,
  UNSUBSCRIBE_COMMENT_MAX,
} from '../../../utils/unsubscribe-token';

const CLIENT_UID = 'api::client.client';
const LOG_UID = 'api::unsubscribe.unsubscribe-log';

class UnsubscribeError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export default {
  async _client(token) {
    const docId = verifyUnsubscribeToken(token);
    if (!docId) throw new UnsubscribeError(404, 'invalid_token');
    const c = await strapi.documents(CLIENT_UID).findOne({
      documentId: docId,
      fields: ['name', 'email', 'reminderOptOut'],
    });
    if (!c) throw new UnsubscribeError(404, 'invalid_token');
    return c;
  },

  // Карточка из токена + все карточки с той же почтой (без регистра).
  async _sameEmail(c) {
    const email = String(c.email || '').trim();
    if (!email) return [c];
    const rows = await strapi.documents(CLIENT_UID).findMany({
      filters: { email: { $eqi: email } },
      fields: ['reminderOptOut'],
      limit: 50,
    });
    const all = new Map(rows.map((r) => [r.documentId, r]));
    all.set(c.documentId, c);
    return [...all.values()];
  },

  async _setFlag(c, value) {
    const cards = await this._sameEmail(c);
    for (const card of cards) {
      if (Boolean(card.reminderOptOut) === value) continue;
      await strapi.documents(CLIENT_UID).update({
        documentId: card.documentId,
        data: { reminderOptOut: value },
      });
    }
  },

  _view(c, optedOut) {
    return { email: maskEmail(c.email), optedOut };
  },

  async info(token) {
    const c = await this._client(token);
    return this._view(c, Boolean(c.reminderOptOut));
  },

  async unsubscribe(token, { via = 'link', origin = null } = {}) {
    const c = await this._client(token);
    if (c.reminderOptOut) {
      // уже отписана: дотягиваем дубли (если кто-то вернул одну из карточек), без строки журнала
      await this._setFlag(c, true);
      return this._view(c, true);
    }
    await this._setFlag(c, true);
    await strapi.documents(LOG_UID).create({
      data: {
        clientDocId: c.documentId,
        clientName: c.name || '',
        email: c.email || '',
        action: 'unsubscribe',
        via,
        origin,
      },
    });
    strapi.log.info(`unsubscribe: ${c.documentId} via ${via}${origin ? ` (${origin})` : ''}`);
    return this._view(c, true);
  },

  async resubscribe(token, { origin = null } = {}) {
    const c = await this._client(token);
    if (!c.reminderOptOut) {
      await this._setFlag(c, false);
      return this._view(c, false);
    }
    await this._setFlag(c, false);
    await strapi.documents(LOG_UID).create({
      data: {
        clientDocId: c.documentId,
        clientName: c.name || '',
        email: c.email || '',
        action: 'resubscribe',
        via: 'link',
        origin,
      },
    });
    strapi.log.info(`unsubscribe: ${c.documentId} resubscribed`);
    return this._view(c, false);
  },

  // Опрос после отписки: причина обязательна, комментарий — нет. Только пока клиент
  // отписан — иначе «причина» повисла бы на старой отписке.
  async reason(token, { reason, comment } = {}) {
    const c = await this._client(token);
    const r = reasonOf(reason);
    if (!r) throw new UnsubscribeError(400, 'bad_reason');
    const text = typeof comment === 'string' ? comment.trim() : '';
    if (text.length > UNSUBSCRIBE_COMMENT_MAX) throw new UnsubscribeError(400, 'comment_too_long');
    if (!c.reminderOptOut) throw new UnsubscribeError(409, 'not_unsubscribed');
    const [last] = await strapi.documents(LOG_UID).findMany({
      filters: { clientDocId: c.documentId, action: 'unsubscribe' },
      sort: 'createdAt:desc',
      fields: ['reason'],
      limit: 1,
    });
    // отписали вручную (NEZASÍLAT) — строки журнала нет, заводим её с причиной
    if (!last) {
      await strapi.documents(LOG_UID).create({
        data: {
          clientDocId: c.documentId,
          clientName: c.name || '',
          email: c.email || '',
          action: 'unsubscribe',
          via: 'link',
          reason: r,
          comment: text || null,
        },
      });
    } else {
      await strapi.documents(LOG_UID).update({
        documentId: last.documentId,
        data: { reason: r, comment: text || null },
      });
    }
    return { ok: true };
  },
};
