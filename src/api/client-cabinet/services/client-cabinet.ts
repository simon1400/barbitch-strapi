// @ts-nocheck
/**
 * Сервис личного кабинета клиента (К1): passwordless magic-link auth + профиль + брони.
 *
 * Поверх существующих данных движка: client (email = identity) + booking
 * (relation client + services-снапшот с serviceDocId). Отмена/перенос кабинет
 * НЕ делает (К2 обернёт manage-функции движка под JWT).
 *
 * Всё за env-гейтом CLIENT_JWT_SECRET (cabinetEnabled) → деплой безопасен:
 * без env каждая ручка отвечает 503 cabinet_disabled.
 */
import crypto from 'crypto';

import { cabinetEnabled, signClientSession } from '../../../utils/client-jwt';
import { pragueDateOf, utcToPragueMinClamped, minToHHMM } from '../../booking-engine/services/slots-core';

const CLIENT_UID = 'api::client.client';
const BOOKING_UID = 'api::booking.booking';
const LOGIN_TOKEN_UID = 'api::client-login-token.client-login-token';

const SITE_URL = process.env.PUBLIC_SITE_URL || 'https://barbitch.cz';
const LOGIN_TOKEN_TTL_MIN = 15;
const HISTORY_LIMIT = 50;

export class CabinetError extends Error {
  status: number;
  code: string;
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

const normalizeEmail = (raw): string => String(raw || '').trim().toLowerCase();

// Базовая проверка формы email (не RFC-полная — режем явный мусор до письма/токена).
const looksLikeEmail = (email: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254;

export default {
  assertEnabled() {
    if (!cabinetEnabled()) {
      throw new CabinetError(503, 'cabinet_disabled', 'Kabinet není momentálně dostupný');
    }
  },

  // ── login: найти/создать клиента по email → одноразовый токен → письмо ──

  // Несколько client-записей с одним email (историческая реальность зеркала) →
  // берём самую свежую С БРОНЯМИ, иначе просто самую свежую.
  async resolveClientByEmail(email: string) {
    const candidates = await strapi.documents(CLIENT_UID).findMany({
      filters: { email: { $eqi: email } },
      sort: 'createdAt:desc',
      fields: ['name', 'email'],
      limit: 10,
    });
    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0];
    for (const c of candidates) {
      const count = await strapi.documents(BOOKING_UID).count({
        filters: { client: { documentId: { $eq: c.documentId } } },
      });
      if (count > 0) return c;
    }
    return candidates[0];
  },

  async login(rawEmail) {
    this.assertEnabled();
    const email = normalizeEmail(rawEmail);
    if (!looksLikeEmail(email)) {
      throw new CabinetError(400, 'invalid_email', 'Zadejte platný e-mail');
    }

    let client = await this.resolveClientByEmail(email);
    if (!client) {
      client = await strapi.documents(CLIENT_UID).create({
        data: {
          name: email.split('@')[0] || email,
          email,
          source: 'site',
        },
      });
    }

    // Сырой токен живёт только в письме; в БД — sha256-хэш.
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + LOGIN_TOKEN_TTL_MIN * 60 * 1000).toISOString();
    await strapi.documents(LOGIN_TOKEN_UID).create({
      data: {
        tokenHash: sha256(token),
        expiresAt,
        email,
        client: client.documentId,
      },
    });

    const url = `${SITE_URL}/cabinet/verify?token=${token}`;
    try {
      const res = await strapi
        .service('api::booking-engine.booking-notify')
        .sendCabinetLogin(email, url);
      // Письмо реально не ушло (нет RESEND_API_KEY / ENGINE_NOTIFY_DRY) —
      // ссылка в лог, чтобы вход был проверяем на dev. В прод-режиме не логируется.
      if (res?.skipped || res?.dry) {
        strapi.log.info(`client-cabinet DRY login link (${email}): ${url}`);
      }
    } catch (e) {
      // Не палим существование email наружу — сбой письма только в лог.
      strapi.log.error(`client-cabinet login e-mail failed (${email}): ${e?.message || e}`);
    }

    // Ответ ВСЕГДА {ok:true} — не раскрываем, существует ли клиент.
    return { ok: true };
  },

  // ── verify: одноразовое погашение токена → JWT ──

  async verify(rawToken) {
    this.assertEnabled();
    const token = String(rawToken || '').trim();
    if (!token) throw new CabinetError(410, 'token_invalid', 'Odkaz je neplatný nebo vypršel');

    const rows = await strapi.documents(LOGIN_TOKEN_UID).findMany({
      filters: { tokenHash: { $eq: sha256(token) } },
      populate: { client: { fields: ['name', 'email'] } },
      limit: 1,
    });
    const rec = rows[0];
    const now = Date.now();
    if (
      !rec ||
      rec.usedAt ||
      !rec.expiresAt ||
      new Date(rec.expiresAt).getTime() < now ||
      !rec.client
    ) {
      throw new CabinetError(410, 'token_invalid', 'Odkaz je neplatný nebo vypršel');
    }

    const nowIso = new Date(now).toISOString();
    await strapi.documents(LOGIN_TOKEN_UID).update({
      documentId: rec.documentId,
      data: { usedAt: nowIso },
    });
    await strapi.documents(CLIENT_UID).update({
      documentId: rec.client.documentId,
      data: { emailVerifiedAt: nowIso, cabinetLastLoginAt: nowIso },
    });

    const jwt = signClientSession({
      clientDocId: rec.client.documentId,
      email: rec.client.email || rec.email || '',
    });
    return {
      jwt,
      client: {
        documentId: rec.client.documentId,
        name: rec.client.name,
        email: rec.client.email || rec.email || null,
      },
    };
  },

  // ── профиль ──

  async me(session) {
    this.assertEnabled();
    const client = await strapi.documents(CLIENT_UID).findOne({
      documentId: session.clientDocId,
      fields: ['name', 'phone', 'email', 'birthday', 'marketingConsent', 'emailVerifiedAt'],
    });
    if (!client) throw new CabinetError(404, 'client_not_found', 'Klient nenalezen');
    return {
      documentId: client.documentId,
      name: client.name,
      phone: client.phone || null,
      email: client.email || null,
      birthday: client.birthday || null,
      marketingConsent: Boolean(client.marketingConsent),
      emailVerifiedAt: client.emailVerifiedAt || null,
    };
  },

  async patchMe(session, patch) {
    this.assertEnabled();
    const data: Record<string, unknown> = {};

    if (patch.name !== undefined) {
      const name = String(patch.name || '').trim();
      if (!name || name.length > 120) throw new CabinetError(400, 'invalid_name', 'Neplatné jméno');
      data.name = name;
    }
    if (patch.phone !== undefined) {
      const phone = String(patch.phone || '').trim();
      if (phone.length > 30) throw new CabinetError(400, 'invalid_phone', 'Neplatný telefon');
      data.phone = phone || null;
    }
    if (patch.birthday !== undefined) {
      const birthday = String(patch.birthday || '').trim();
      if (birthday && !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) {
        throw new CabinetError(400, 'invalid_birthday', 'Neplatné datum narození');
      }
      data.birthday = birthday || null;
    }
    if (patch.marketingConsent !== undefined) {
      data.marketingConsent = Boolean(patch.marketingConsent);
      data.marketingConsentAt = new Date().toISOString();
    }
    // E-mail этой ручкой НЕ меняется: e-mail = identity кабинета,
    // смена — отдельный verify-флоу (не в К1).

    if (Object.keys(data).length > 0) {
      await strapi.documents(CLIENT_UID).update({
        documentId: session.clientDocId,
        data,
      });
    }
    return this.me(session);
  },

  // ── брони клиента ──

  shapeBooking(b) {
    const dateStr = String(b.date || '');
    const services = Array.isArray(b.services) ? b.services : [];
    return {
      documentId: b.documentId,
      date: dateStr || null,
      time:
        b.startsAt && dateStr ? minToHHMM(utcToPragueMinClamped(b.startsAt, dateStr)) : null,
      status: b.status,
      arrived: Boolean(b.arrived),
      services,
      totalPrice: b.totalPrice != null ? Number(b.totalPrice) : null,
      employeeName: b.employee?.name || b.employeeNameRaw || null,
      // Управление (отмена/перенос) — только активные НЕзеркальные брони:
      // у зеркальных Noona-броней cancelToken отсутствует.
      canManage: b.status === 'active' && Boolean(b.cancelToken),
      // «Записаться znovu» — снапшот несёт serviceDocId (движковые брони).
      canRebook: services.some((s) => Boolean(s?.serviceDocId)),
    };
  },

  async bookings(session) {
    this.assertEnabled();
    const today = pragueDateOf(new Date());
    const baseQuery = {
      fields: [
        'date',
        'startsAt',
        'status',
        'arrived',
        'services',
        'totalPrice',
        'employeeNameRaw',
        'cancelToken',
      ],
      populate: { employee: { fields: ['name'] } },
    };

    const [upcoming, history] = await Promise.all([
      strapi.documents(BOOKING_UID).findMany({
        ...baseQuery,
        filters: {
          client: { documentId: { $eq: session.clientDocId } },
          status: { $eq: 'active' },
          date: { $gte: today },
        },
        sort: ['date:asc', 'startsAt:asc'],
        limit: 100,
      }),
      strapi.documents(BOOKING_UID).findMany({
        ...baseQuery,
        filters: {
          client: { documentId: { $eq: session.clientDocId } },
          $or: [{ date: { $lt: today } }, { status: { $ne: 'active' } }],
        },
        sort: ['date:desc', 'startsAt:desc'],
        limit: HISTORY_LIMIT,
      }),
    ]);

    return {
      upcoming: upcoming.map((b) => this.shapeBooking(b)),
      history: history.map((b) => this.shapeBooking(b)),
    };
  },
};
