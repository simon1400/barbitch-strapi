// @ts-nocheck
/**
 * Platba dárkových voucherů kartou přes Comgate (s275) — web /darkovy-voucher.
 *
 * 1. POST /api/engine/vouchers/checkout (veřejná, rate-limit): cena z katalogu (karty
 *    „Voucher na službu“ ze Strapi + částky), číslo voucheru generuje server, voucher
 *    jako koncept (`paymentStatus: pending`), záznam `voucher-payment`, platba v Comgate
 *    → adresa platební brány. Návrat na /darkovy-voucher/dekujeme?t=<token>.
 * 2. POST /api/engine/payments/comgate/notify — push od Comgate: náš merchant+secret,
 *    pak se stav VŽDY ověří dotazem do Comgate (tělu pushe se nevěří). PAID → voucher
 *    `datePay` + publikace + e-mail „voucher je aktivní“ s PDF (jednou); CANCELLED → zrušeno.
 * 3. GET /api/engine/vouchers/checkout/:token — stránka výsledku; dokud čeká, sama
 *    se doptá Comgate (push se může zpozdit).
 * 4. Cron každých 15 min — objednávky starší 24 h: poslední dotaz, jinak zrušit.
 * 5. Vedení: seznam plateb; majitel vrací peníze (Comgate refund) — voucher `refunded`
 *    a uzavření návštěvy ho nepřijme.
 *
 * Bez env COMGATE_MERCHANT/COMGATE_SECRET je vše vypnuté (503). COMGATE_TEST — výchozí
 * true (testovací platby), na ostro až výslovně `false`. Čistá logika — voucher-payments-core.ts.
 */

import crypto from 'crypto';

import { makeIpLimiter } from '../../../utils/ip-limiter';
import { maskEmail } from '../../../utils/unsubscribe-token';
import {
  basicAuth,
  buildCatalog,
  checkCheckout,
  checkPush,
  comgateConfig,
  createPaymentBody,
  fromStatusesFor,
  isExpired,
  nextStatus,
  parseCreateResponse,
  publicStatus,
  refundBlock,
  refundBody,
  statusVerdict,
  validUntilOf,
} from './voucher-payments-core';

export class VoucherPaymentError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const UID = 'api::voucher-payment.voucher-payment';
const VOUCHER_UID = 'api::voucher.voucher';
const SITE_URL = (process.env.PUBLIC_SITE_URL || 'https://barbitch.cz').replace(/\/+$/, '');
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const DOC_ID = /^[a-z0-9]{20,40}$/;
/** Stránka výsledku se doptává Comgate nejvýš jednou za 10 s. */
const RECHECK_MS = 10_000;

const FIELD_MESSAGE = {
  voucherId: 'Vybraný voucher už není v nabídce, obnovte prosím stránku',
  forName: 'Vyplňte jméno obdarované',
  fromName: 'Vyplňte své jméno',
  email: 'Zadejte platný e-mail',
  consent: 'Potvrďte souhlas s obchodními podmínkami',
};

const REFUND_MESSAGE = {
  already_refunded: 'Peníze už byly vráceny',
  not_paid: 'Platba není zaplacená — není co vracet',
  voucher_used: 'Voucher už byl využit při návštěvě — peníze vrátit nejde',
};

// Založení platby = zápis do DB + volání Comgate → 10 objednávek za hodinu z jedné IP.
const allowCheckout = makeIpLimiter(60 * 60 * 1000, 10);

const pragueYmd = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(d);

// Jeden PM2 proces: push, stránka výsledku i cron nad stejnou platbou jdou po sobě.
const locks = new Map<string, Promise<void>>();
const withLock = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
  const prev = locks.get(key) || Promise.resolve();
  let release: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chain = prev.then(() => mine);
  locks.set(key, chain);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === chain) locks.delete(key);
  }
};

const cfgOrThrow = () => {
  const cfg = comgateConfig(process.env);
  if (!cfg) throw new VoucherPaymentError(503, 'payments_not_configured', 'Platba kartou je dočasně nedostupná');
  return cfg;
};

const campaignSvc = () => strapi.service('api::campaign.campaign');

export default {
  /** Volání Comgate REST v2.0. Vrací JSON odpovědi (i s chybovým `code`), síťová chyba = výjimka. */
  async _comgate(cfg, method: 'GET' | 'POST' | 'DELETE', path: string, body?: any) {
    const res = await fetch(`${cfg.apiUrl}/v2.0/${path}`, {
      method,
      headers: {
        Authorization: basicAuth(cfg),
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => null);
    if (!data) throw new Error(`Comgate ${method} ${path}: HTTP ${res.status}, bez JSON`);
    return data;
  },

  async _newIdVoucher() {
    for (let i = 0; i < 8; i++) {
      const id = String(crypto.randomInt(10_000_000, 100_000_000));
      const taken = await strapi.db.query(VOUCHER_UID).findOne({ where: { idVoucher: id }, select: ['id'] });
      if (!taken) return id;
    }
    throw new Error('voucher-payments: nepodařilo se vygenerovat volné číslo voucheru');
  },

  async _catalog() {
    const services = await strapi.service('api::vaucher-page.vaucher-page').serviceVouchers();
    return buildCatalog(services);
  },

  async _claim(id: number, to: string, data: any) {
    const res = await strapi.db
      .query(UID)
      .updateMany({ where: { id, paymentStatus: { $in: fromStatusesFor(to) } }, data: { ...data, paymentStatus: to } });
    return Boolean(res?.count);
  },

  /** Voucher (koncept) → nová data; `publish` = jako Save + Publish v panelu. */
  async _updateVoucher(documentId: string, data: any, publish: boolean) {
    await strapi.documents(VOUCHER_UID).update({ documentId, status: 'draft', data });
    if (publish) await strapi.documents(VOUCHER_UID).publish({ documentId });
  },

  async checkout({ body, ip }) {
    const cfg = cfgOrThrow();
    if (!allowCheckout(String(ip || 'unknown'))) {
      throw new VoucherPaymentError(429, 'too_many', 'Příliš mnoho objednávek, zkuste to prosím později');
    }
    const check = checkCheckout(body, await this._catalog());
    if (!check.ok) {
      throw new VoucherPaymentError(400, `invalid_${check.field}`, FIELD_MESSAGE[check.field] || 'Neplatný formulář');
    }
    const { item, forName, fromName, email, phone } = check.data;
    const idVoucher = await this._newIdVoucher();
    const token = crypto.randomBytes(24).toString('base64url');

    const voucher = await strapi.documents(VOUCHER_UID).create({
      data: {
        name: fromName,
        for: forName,
        sum: item.price,
        dateOrder: pragueYmd(),
        email,
        phone,
        serviceName: item.serviceName,
        deliveryMethod: 'email',
        idVoucher,
        paymentStatus: 'pending',
      },
    });
    // documents(): vygeneruje documentId (db.query ho nevyplní)
    const payment = await strapi.documents(UID).create({
      data: {
        token,
        paymentStatus: 'pending',
        voucherDocId: voucher.documentId,
        idVoucher,
        catalogId: item.id,
        serviceName: item.serviceName,
        price: item.price,
        email,
        buyerName: fromName,
        forName,
        test: cfg.test,
      },
    });

    let created = null;
    let failure = '';
    try {
      const res = await this._comgate(
        cfg,
        'POST',
        'payment.json',
        createPaymentBody({
          cfg,
          price: item.price,
          idVoucher,
          catalogId: item.id,
          email,
          fullName: fromName,
          returnUrl: `${SITE_URL}/darkovy-voucher/dekujeme?t=${token}`,
        })
      );
      created = parseCreateResponse(res, cfg.apiUrl);
      if (!created) failure = `code ${res?.code}: ${res?.message || '?'}`;
    } catch (e) {
      failure = e.message;
    }
    if (!created) {
      strapi.log.error(`voucher-payments: Comgate nezaložil platbu ${idVoucher} — ${failure}`);
      await strapi.db.query(UID).update({
        where: { id: payment.id },
        data: { paymentStatus: 'cancelled', cancelledAt: new Date(), failReason: `create: ${failure}`.slice(0, 250) },
      });
      await this._updateVoucher(voucher.documentId, { paymentStatus: 'cancelled' }, false).catch(() => {});
      throw new VoucherPaymentError(502, 'gateway_unavailable', 'Platební bránu se nepodařilo otevřít, zkuste to prosím za chvíli');
    }

    await strapi.db.query(UID).update({ where: { id: payment.id }, data: { transId: created.transId } });
    strapi.log.info(`voucher-payments: platba ${created.transId} · voucher ${idVoucher} · ${item.price} Kč${cfg.test ? ' (TEST)' : ''}`);
    return { redirect: created.redirect, token };
  },

  /**
   * Ověří stav u Comgate a provede přechod. Idempotentní: PAID podruhé nic nepošle.
   * Chyba sítě/DB propadne ven — push pak dostane 500 a Comgate ho zopakuje.
   */
  async settle(paymentId: number) {
    return withLock(`p${paymentId}`, async () => {
      const cfg = cfgOrThrow();
      const p = await strapi.db.query(UID).findOne({ where: { id: paymentId } });
      if (!p?.transId) return p;
      const res = await this._comgate(cfg, 'GET', `payment/transId/${encodeURIComponent(p.transId)}.json`);
      const verdict = statusVerdict(res, p);
      if (verdict.action === 'mismatch') {
        // Nesedí částka/refId/měna/test — nic neplatit ani nerušit; v adminu „zkontrolovat v portálu“.
        strapi.log.error(`voucher-payments: stav ${p.transId} nesedí (${verdict.reason}) — nic neměním`);
        await strapi.db
          .query(UID)
          .update({ where: { id: p.id }, data: { checkedAt: new Date(), failReason: `mismatch: ${verdict.reason}` } });
        return { ...p, failReason: `mismatch: ${verdict.reason}` };
      }
      await strapi.db.query(UID).update({ where: { id: p.id }, data: { checkedAt: new Date() } });
      const to = nextStatus(p.paymentStatus, verdict);
      if (!to) return p;

      if (to === 'paid') {
        const today = pragueYmd();
        // Nejdřív voucher (idempotentní), pak podmíněný přechod — e-mail jde jen jednou.
        await this._updateVoucher(p.voucherDocId, { datePay: today, paymentStatus: 'paid' }, true);
        const won = await this._claim(p.id, 'paid', { paidAt: new Date(), method: verdict.method, failReason: null });
        if (!won) return p;
        strapi.log.info(`voucher-payments: ZAPLACENO ${p.transId} · voucher ${p.idVoucher} · ${p.price} Kč`);
        await this._sendVoucherMail(p, today);
      } else if (to === 'cancelled') {
        const won = await this._claim(p.id, 'cancelled', {
          cancelledAt: new Date(),
          failReason: verdict.action === 'cancelled' ? verdict.reason : null,
        });
        if (won) await this._updateVoucher(p.voucherDocId, { paymentStatus: 'cancelled' }, false).catch(() => {});
      }
      return strapi.db.query(UID).findOne({ where: { id: p.id } });
    });
  },

  /** E-mail „voucher je aktivní“ s PDF (Next-roude send-confirmation-voucher). Chyba se zapíše, platbu neshodí. */
  async _sendVoucherMail(p, payYmd: string) {
    try {
      await campaignSvc().sendVoucherConfirmation(
        {
          email: p.email,
          buyerName: p.buyerName || 'Zákazník',
          recipientName: p.forName || '-',
          voucherId: p.idVoucher,
          validUntil: validUntilOf(payYmd),
          serviceName: p.serviceName,
          attachPdfSum: p.price,
        },
        { username: 'comgate' }
      );
      await strapi.db.query(UID).update({ where: { id: p.id }, data: { mailSentAt: new Date(), mailError: null } });
    } catch (e) {
      strapi.log.error(`voucher-payments: e-mail k voucheru ${p.idVoucher} neodešel — ${e.message}`);
      await strapi.db.query(UID).update({ where: { id: p.id }, data: { mailError: String(e.message).slice(0, 500) } });
    }
  },

  /** Push od Comgate. Vrací text odpovědi; chyba ověření = 403 (Comgate zkusí znovu, nevadí). */
  async notify({ body }) {
    const cfg = cfgOrThrow();
    const check = checkPush(body, cfg);
    if (!check.ok) {
      strapi.log.warn(`voucher-payments: odmítnutý push (${check.reason})`);
      throw new VoucherPaymentError(403, 'bad_push', 'Forbidden');
    }
    const p = await strapi.db.query(UID).findOne({ where: { transId: check.transId }, select: ['id'] });
    if (!p) {
      // Cizí platba stejného e-shopu (např. test z portálu) — potvrdit, ať ji Comgate neopakuje.
      strapi.log.warn(`voucher-payments: push k neznámé platbě ${check.transId}`);
      return 'OK';
    }
    await this.settle(p.id);
    return 'OK';
  },

  /** Stránka výsledku: stav podle tokenu; čekající platbu se sama doptá Comgate. */
  async checkoutStatus({ token }) {
    if (!TOKEN_RE.test(String(token || ''))) throw new VoucherPaymentError(404, 'not_found', 'Objednávka nenalezena');
    let p = await strapi.db.query(UID).findOne({ where: { token } });
    if (!p) throw new VoucherPaymentError(404, 'not_found', 'Objednávka nenalezena');
    const stale = !p.checkedAt || Date.now() - new Date(p.checkedAt).getTime() > RECHECK_MS;
    if (p.paymentStatus === 'pending' && p.transId && stale && comgateConfig(process.env)) {
      try {
        p = (await this.settle(p.id)) || p;
      } catch (e) {
        strapi.log.warn(`voucher-payments: dotaz na stav ${p.transId} selhal — ${e.message}`);
      }
    }
    return publicStatus(p, maskEmail(p.email));
  },

  /** Cron: neuhrazené objednávky po 24 h — poslední dotaz, pak zrušit (i v Comgate). */
  async expireStale(now = new Date()) {
    const cfg = comgateConfig(process.env);
    if (!cfg) return 0;
    const cutoff = new Date(now.getTime() - 24 * 3600_000);
    const rows = await strapi.db
      .query(UID)
      .findMany({ where: { paymentStatus: 'pending', createdAt: { $lt: cutoff } }, orderBy: { id: 'asc' }, limit: 50 });
    let cancelled = 0;
    for (const row of rows) {
      if (!isExpired(row, now)) continue;
      try {
        const after = row.transId ? await this.settle(row.id) : row;
        if (after?.paymentStatus !== 'pending') continue;
        // Nesedí s Comgate — nerušit sami, ať to vedení zkontroluje v portálu.
        if (String(after.failReason || '').startsWith('mismatch')) continue;
        if (row.transId) {
          await this._comgate(cfg, 'DELETE', `payment/transId/${encodeURIComponent(row.transId)}.json`).catch(() => null);
        }
        const won = await this._claim(row.id, 'cancelled', { cancelledAt: now, failReason: 'expired' });
        if (won) {
          cancelled++;
          await this._updateVoucher(row.voucherDocId, { paymentStatus: 'cancelled' }, false).catch(() => {});
        }
      } catch (e) {
        strapi.log.error(`voucher-payments: vypršení ${row.idVoucher} selhalo — ${e.message}`);
      }
    }
    if (cancelled) strapi.log.info(`voucher-payments: zrušeno ${cancelled} neuhrazených objednávek`);
    return cancelled;
  },

  /** Využité vouchery (dateRealized) podle documentId — kterékoli verze. */
  async _usedVouchers(docIds: string[]) {
    if (!docIds.length) return new Set<string>();
    const rows = await strapi.db.query(VOUCHER_UID).findMany({
      where: { documentId: { $in: docIds }, dateRealized: { $notNull: true } },
      select: ['documentId'],
    });
    return new Set(rows.map((r) => r.documentId));
  },

  /** Vedení: platby kartou za posledních `days` dní, nejnovější nahoře. */
  async adminList({ days }) {
    const d = Math.min(Math.max(Number(days) || 90, 1), 400);
    const rows = await strapi.db.query(UID).findMany({
      where: { createdAt: { $gte: new Date(Date.now() - d * 86400_000) } },
      orderBy: { id: 'desc' },
      limit: 300,
    });
    const used = await this._usedVouchers([...new Set(rows.map((r) => r.voucherDocId))]);
    const items = rows.map((r) => {
      const voucherUsed = used.has(r.voucherDocId);
      return {
        id: r.documentId,
        idVoucher: r.idVoucher,
        catalogId: r.catalogId,
        serviceName: r.serviceName || null,
        price: r.price,
        email: r.email,
        buyerName: r.buyerName,
        forName: r.forName,
        status: r.paymentStatus,
        method: r.method || null,
        test: Boolean(r.test),
        createdAt: r.createdAt,
        paidAt: r.paidAt,
        cancelledAt: r.cancelledAt,
        refundedAt: r.refundedAt,
        refundedBy: r.refundedBy || null,
        mailSentAt: r.mailSentAt,
        mailError: r.mailError || null,
        failReason: r.failReason || null,
        voucherUsed,
        canRefund: !refundBlock(r, { dateRealized: voucherUsed ? 'x' : null }),
      };
    });
    return { items, configured: Boolean(comgateConfig(process.env)) };
  },

  /** Majitel: vrátit celou částku přes Comgate; voucher pak neplatí. */
  async refund({ session, id }) {
    const cfg = cfgOrThrow();
    if (!DOC_ID.test(String(id || ''))) throw new VoucherPaymentError(404, 'not_found', 'Platba nenalezena');
    const p0 = await strapi.db.query(UID).findOne({ where: { documentId: id }, select: ['id'] });
    if (!p0) throw new VoucherPaymentError(404, 'not_found', 'Platba nenalezena');
    return withLock(`p${p0.id}`, async () => {
      const p = await strapi.db.query(UID).findOne({ where: { id: p0.id } });
      const used = await this._usedVouchers([p.voucherDocId]);
      const block = refundBlock(p, { dateRealized: used.has(p.voucherDocId) ? 'x' : null });
      if (block) throw new VoucherPaymentError(409, block, REFUND_MESSAGE[block]);

      const res = await this._comgate(cfg, 'POST', 'refund.json', refundBody(p));
      if (Number(res?.code) !== 0) {
        strapi.log.error(`voucher-payments: Comgate odmítl vrácení ${p.transId} — ${res?.code} ${res?.message}`);
        throw new VoucherPaymentError(502, 'refund_failed', `Comgate vrácení odmítl: ${res?.message || res?.code}`);
      }
      const who = String(session?.username || '?').slice(0, 100);
      await this._claim(p.id, 'refunded', { refundedAt: new Date(), refundedBy: who });
      await this._updateVoucher(p.voucherDocId, { paymentStatus: 'refunded' }, true);
      strapi.log.info(`voucher-payments: VRÁCENO ${p.transId} · voucher ${p.idVoucher} · ${p.price} Kč · ${who}`);
      return { ok: true };
    });
  },
};
