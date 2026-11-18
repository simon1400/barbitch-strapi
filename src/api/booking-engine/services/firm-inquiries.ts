// @ts-nocheck
/**
 * Firemní poptávky voucherů (s274) — web /firemni-vouchery.
 *
 * Veřejná ručka POST /api/engine/firm-inquiries (multipart, rate-limit): kontrola polí,
 * logo do zavřeného adresáře `FIRM_FILES_DIR` (utils/private-files: typ podle signatury,
 * PNG/JPG/WEBP/PDF — AI soubory s PDF uvnitř projdou jako PDF), záznam `firm-inquiry`,
 * e-mail salonu (logo v příloze, odpověď jde rovnou firmě) a potvrzení firmě.
 * Bez `FIRM_FILES_DIR` se poptávka uloží i odešle, logo jen v e-mailu.
 *
 * Vedení (owner/manager): seznam, stav + interní poznámka, stažení loga.
 * Čistá logika — firm-inquiries-core.ts (tests/firm-inquiries-core.test.mjs).
 */

import fs from 'fs';

import {
  contentDisposition,
  detectFile,
  openPrivateFile,
  privateDir,
  readHead,
  safeFileName,
  storePrivateFile,
} from '../../../utils/private-files';
import { makeIpLimiter } from '../../../utils/ip-limiter';
import {
  LOGO_MAX_BYTES,
  checkInquiry,
  checkUpdate,
  confirmationEmail,
  inquiryRow,
  salonEmail,
} from './firm-inquiries-core';

export class FirmInquiryError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const UID = 'api::firm-inquiry.firm-inquiry';
const CONTACT_UID = 'api::contact.contact';
const DOC_ID = /^[a-z0-9]{20,40}$/;
const ADMIN_URL = process.env.ADMIN_APP_URL || 'https://admin.barbitch.cz';

const notifySvc = () => strapi.service('api::booking-engine.booking-notify');

// Poptávka posílá e-maily → vlastní přísný limit nad společným rate-limit-engine
// (300/5 min): 5 poptávek za hodinu z jedné IP.
const allowSubmit = makeIpLimiter(60 * 60 * 1000, 5);

const FIELD_MESSAGE = {
  company: 'Vyplňte název firmy',
  count: 'Nejméně 10 kusů',
  person: 'Vyplňte kontaktní osobu',
  email: 'Zadejte platný e-mail',
  consent: 'Potvrďte souhlas se zpracováním údajů',
};

export default {
  /** Kam poslat oznámení: env má přednost, jinak e-mail salonu z „Contact“. */
  async _salonEmail() {
    const fromEnv = String(process.env.FIRM_VOUCHER_NOTIFY_EMAIL || '').trim();
    if (fromEnv) return fromEnv;
    const contact = await strapi.documents(CONTACT_UID).findFirst({ fields: ['email'] }).catch(() => null);
    return contact?.email || null;
  },

  /** Logo z multipartu → {file, type} nebo null (bez loga). Špatný soubor = 400/413. */
  async _readLogo(files) {
    const file = files?.logo;
    if (!file) return null;
    if (Array.isArray(file) || !file.filepath) throw new FirmInquiryError(400, 'bad_file', 'Nahrajte jeden soubor');
    const size = Number(file.size) || 0;
    if (size <= 0) return null;
    if (size > LOGO_MAX_BYTES) throw new FirmInquiryError(413, 'file_too_big', 'Logo je větší než 5 MB');
    const type = detectFile(await readHead(file.filepath));
    if (!type) throw new FirmInquiryError(400, 'bad_file_type', 'Logo nahrajte jako PNG, JPG, WEBP nebo PDF');
    return { file, type, size, name: safeFileName(file.originalFilename, type.ext, 'logo') };
  },

  async submit({ body, files, ip }) {
    if (!allowSubmit(String(ip || 'unknown'))) {
      throw new FirmInquiryError(429, 'too_many', 'Příliš mnoho poptávek, zkuste to prosím později');
    }
    const check = checkInquiry(body);
    if (!check.ok) {
      throw new FirmInquiryError(400, `invalid_${check.field}`, FIELD_MESSAGE[check.field] || 'Neplatný formulář');
    }
    const data = check.data;
    const logo = await this._readLogo(files);

    // Logo do zavřeného adresáře; bez env se neukládá (jen příloha e-mailu).
    let storedName = null;
    if (logo) {
      const dir = await privateDir(process.env.FIRM_FILES_DIR, 'firm-inquiries');
      if (dir) storedName = (await storePrivateFile(dir, logo.file.filepath)).storedName;
      else strapi.log.warn('firm-inquiries: FIRM_FILES_DIR není nastaven — logo jen v e-mailu');
    }

    const created = await strapi.documents(UID).create({
      data: {
        ...data,
        inquiryStatus: 'new',
        ...(logo ? { logoName: logo.name, logoMime: logo.type.mime, logoSize: logo.size, logoStoredName: storedName } : {}),
      },
    });

    // E-maily: chyba odeslání poptávku neruší (už je v adminu), jen se zaloguje.
    const to = await this._salonEmail();
    const attachments = logo
      ? [{ filename: logo.name, content: (await fs.promises.readFile(logo.file.filepath)).toString('base64') }]
      : undefined;
    if (to) {
      const mail = salonEmail(data, logo?.name || null, `${ADMIN_URL}/firemni-poptavky?id=${created.documentId}`);
      await notifySvc()
        .sendEmail({ to, subject: mail.subject, html: mail.html, attachments, replyTo: data.email })
        .catch((e) => strapi.log.error(`firm-inquiries: e-mail salonu selhal: ${e.message}`));
    } else {
      strapi.log.error('firm-inquiries: není kam poslat oznámení (FIRM_VOUCHER_NOTIFY_EMAIL ani Contact.email)');
    }
    const confirm = confirmationEmail(data);
    await notifySvc()
      .sendEmail({ to: data.email, subject: confirm.subject, html: confirm.html, ...(to ? { replyTo: to } : {}) })
      .catch((e) => strapi.log.error(`firm-inquiries: potvrzení firmě selhalo: ${e.message}`));

    return { ok: true };
  },

  async list() {
    const rows = await strapi.documents(UID).findMany({ sort: [{ createdAt: 'desc' }], limit: 500 });
    return { items: rows.map(inquiryRow) };
  },

  async _find(id) {
    const documentId = String(id ?? '').trim();
    if (!DOC_ID.test(documentId)) throw new FirmInquiryError(404, 'not_found', 'Poptávka nenalezena');
    const row = await strapi.documents(UID).findOne({ documentId, fields: ['*'] });
    if (!row) throw new FirmInquiryError(404, 'not_found', 'Poptávka nenalezena');
    return row;
  },

  async update({ session, id, body }) {
    const row = await this._find(id);
    const patch = checkUpdate(body);
    if (!patch) throw new FirmInquiryError(400, 'nothing_to_update', 'Není co uložit');
    const updated = await strapi.documents(UID).update({
      documentId: row.documentId,
      data: { ...patch, updatedByName: session?.username || null },
    });
    return { item: inquiryRow(updated) };
  },

  async logo({ id }) {
    const row = await this._find(id);
    if (!row.logoName) throw new FirmInquiryError(404, 'no_logo', 'Poptávka nemá logo');
    const dir = await privateDir(process.env.FIRM_FILES_DIR, 'firm-inquiries');
    const opened = dir ? await openPrivateFile(dir, row.logoStoredName) : null;
    if (!opened) throw new FirmInquiryError(404, 'logo_only_in_email', 'Logo je jen v e-mailu salonu');
    return {
      stream: opened.stream,
      size: opened.size,
      mime: row.logoMime || 'application/octet-stream',
      disposition: contentDisposition(row.logoName),
    };
  },
};
