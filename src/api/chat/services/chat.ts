import {
  awayTelegramText,
  chatStatusOf,
  contactTelegramText,
  NEXT_OPEN_LOOKAHEAD_DAYS,
  parseContact,
  planChatTick,
  reminderTexts,
  TICK_WINDOW_DAYS,
  topicName,
} from './chat-core';
import { addDaysYmd } from '../../booking-engine/services/master-schedule';
import { pragueDateOf } from '../../booking-engine/services/slots-core';

const TELEGRAM_API = 'https://api.telegram.org/bot';
const SESSION_UID = 'api::chat-session.chat-session';
const MSG_UID = 'api::chat-message.chat-message';
/** Отметку «клиентка на сайте» пишем не чаще (опрос открытого чата — каждые 3 с). */
const SEEN_WRITE_SEC = 15;

export class ChatError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export default {
  /**
   * Find existing session or create a new one
   */
  async getOrCreateSession(sessionId: string, visitorName?: string) {
    const existing = await strapi.entityService.findMany('api::chat-session.chat-session' as any, {
      filters: { sessionId },
      limit: 1,
    });

    const results = existing as any[];
    if (results && results.length > 0) return results[0];

    return await strapi.entityService.create('api::chat-session.chat-session' as any, {
      data: {
        sessionId,
        visitorName: visitorName || 'Návštěvník',
        stage: 'active',
      },
    });
  },

  /**
   * Create a chat message linked to a session
   */
  async createMessage(
    session: any,
    text: string,
    sender: 'visitor' | 'admin',
    telegramFileId?: string
  ) {
    return await strapi.entityService.create('api::chat-message.chat-message' as any, {
      data: {
        text: text || '',
        sender,
        telegramFileId: telegramFileId || null,
        session: session.id,
      },
    });
  },

  /**
   * Get messages for a session, optionally after a specific message ID.
   * s272: каждый опрос = «клиентка на сайте» (`lastSeenAt`); опрос открытого чата (`open`) —
   * ещё и «прочитала до …» (`readUpTo`) — по ним крон решает, слать ли ответ на e-mail.
   */
  async getMessages(sessionId: string, afterId?: number, { open = false } = {}) {
    const sessions = await strapi.entityService.findMany('api::chat-session.chat-session' as any, {
      filters: { sessionId },
      limit: 1,
    });

    const results = sessions as any[];
    if (!results || results.length === 0) return [];
    const session = results[0];

    const filters: any = { session: { id: session.id } };
    if (afterId) filters.id = { $gt: afterId };

    const messages = (await strapi.entityService.findMany('api::chat-message.chat-message' as any, {
      filters,
      sort: { createdAt: 'asc' },
      limit: 100,
    })) as any[];
    await (this as any)._touch(session, open ? Math.max(Number(afterId || 0), ...messages.map((m) => Number(m.id))) : 0).catch(
      (e: Error) => strapi.log.warn(`chat: seen mark failed: ${e.message}`)
    );
    return messages;
  },

  async _touch(session: any, readUpTo: number) {
    const data: any = {};
    const seen = session.lastSeenAt ? new Date(session.lastSeenAt).getTime() : 0;
    if (Date.now() - seen >= SEEN_WRITE_SEC * 1000) data.lastSeenAt = new Date();
    if (readUpTo > Number(session.readUpTo || 0)) {
      data.readUpTo = readUpTo;
      data.lastSeenAt = new Date();
    }
    if (!Object.keys(data).length) return;
    await strapi.db.query(SESSION_UID).update({ where: { id: session.id }, data });
  },

  /**
   * Send message to Telegram. If imageFile is provided, uploads it directly to Telegram.
   * Returns telegramFileId if an image was sent, undefined otherwise.
   */
  async sendToTelegram(
    session: any,
    text?: string,
    imageFile?: any
  ): Promise<string | undefined> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return undefined;

    // Create forum topic for new sessions
    let topicId = session.telegramTopicId;
    if (!topicId) {
      topicId = await (this as any).createTelegramTopic(
        token,
        chatId,
        topicName(session.visitorName, { email: session.contactEmail, phone: session.contactPhone })
      );
      if (topicId) {
        await strapi.entityService.update('api::chat-session.chat-session' as any, session.id, {
          data: { telegramTopicId: topicId },
        });
        session.telegramTopicId = topicId;
      }
    }

    try {
      if (imageFile) {
        // Send photo directly to Telegram via multipart
        const fs = require('fs');
        const fileBuffer = fs.readFileSync(imageFile.filepath || imageFile.path);
        const fileName = imageFile.originalFilename || imageFile.name || 'photo.jpg';
        const mimeType = imageFile.mimetype || imageFile.type || 'image/jpeg';

        const formData = new FormData();
        formData.append('chat_id', chatId);
        if (topicId) formData.append('message_thread_id', String(topicId));
        formData.append('photo', new Blob([fileBuffer], { type: mimeType }), fileName);
        if (text) formData.append('caption', text);

        const res = await fetch(`${TELEGRAM_API}${token}/sendPhoto`, {
          method: 'POST',
          body: formData,
        });
        const data = (await res.json()) as any;

        if (data.ok && data.result.photo) {
          // Return the largest photo's file_id
          const photos = data.result.photo;
          return photos[photos.length - 1].file_id;
        }

        return undefined;
      }

      // Text-only message
      if (text) {
        const body: any = { chat_id: chatId, text };
        if (topicId) body.message_thread_id = topicId;

        await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }

      return undefined;
    } catch (error) {
      strapi.log.error('Telegram API error:', error);
      return undefined;
    }
  },

  /**
   * Create a forum topic in Telegram group for a new chat session
   */
  async createTelegramTopic(
    token: string,
    chatId: string,
    name: string
  ): Promise<number | null> {
    try {
      const res = await fetch(`${TELEGRAM_API}${token}/createForumTopic`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, name }),
      });
      const data = (await res.json()) as any;
      if (data.ok) return data.result.message_thread_id;
      strapi.log.warn('Failed to create Telegram topic:', data.description);
      return null;
    } catch (error) {
      strapi.log.warn('Failed to create Telegram topic:', error);
      return null;
    }
  },

  /**
   * Handle incoming Telegram webhook updates (admin replies)
   */
  async handleWebhook(update: any) {
    const message = update.message;
    if (!message) return;

    // Ignore bot's own messages
    if (message.from?.is_bot) return;

    const topicId = message.message_thread_id;
    if (!topicId) return;

    // Find session by Telegram topic ID
    const sessions = await strapi.entityService.findMany('api::chat-session.chat-session' as any, {
      filters: { telegramTopicId: topicId },
      limit: 1,
    });

    const results = sessions as any[];
    if (!results || results.length === 0) return;
    const session = results[0];

    // Get file_id from photo if present
    let telegramFileId: string | undefined;
    if (message.photo && message.photo.length > 0) {
      telegramFileId = message.photo[message.photo.length - 1].file_id;
    }

    await (this as any).createMessage(
      session,
      message.text || message.caption || '',
      'admin',
      telegramFileId
    );
  },

  /**
   * Proxy a Telegram file: fetches fresh URL via getFile and returns the image buffer.
   * The caller sets Cache-Control so the browser caches it.
   */
  async proxyTelegramFile(
    fileId: string
  ): Promise<{ buffer: Buffer; contentType: string } | null> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return null;

    try {
      const fileInfoRes = await fetch(`${TELEGRAM_API}${token}/getFile?file_id=${fileId}`);
      const fileInfo = (await fileInfoRes.json()) as any;
      if (!fileInfo.ok) return null;

      const filePath = fileInfo.result.file_path;
      const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;

      const fileRes = await fetch(fileUrl);
      if (!fileRes.ok) return null;

      const buffer = Buffer.from(await fileRes.arrayBuffer());
      const contentType = fileRes.headers.get('content-type') || 'image/jpeg';

      return { buffer, contentType };
    } catch (error) {
      strapi.log.error('Telegram file proxy failed:', error);
      return null;
    }
  },

  // ── s272: часы, контакт, крон ─────────────────────────────────────────────

  /** Онлайн ли чат и когда откроемся — по `salon_hours` (как запись). */
  async status(now: Date = new Date()) {
    const today = pragueDateOf(now);
    const rows = await strapi.documents('api::salon-hour.salon-hour').findMany({
      filters: { date: { $gte: today, $lte: addDaysYmd(today, NEXT_OPEN_LOOKAHEAD_DAYS) } },
      fields: ['date', 'openMin', 'closeMin'],
      limit: NEXT_OPEN_LOOKAHEAD_DAYS + 1,
    });
    return chatStatusOf(rows, now);
  },

  async _findSession(sessionId: string) {
    const rows = (await strapi.entityService.findMany(SESSION_UID as any, { filters: { sessionId }, limit: 1 })) as any[];
    return rows?.[0] || null;
  },

  /** Для виджета: имя и оставленный контакт (ссылка из письма открывает чат на другом устройстве). */
  async sessionInfo(sessionId: string) {
    const s = await (this as any)._findSession(sessionId);
    if (!s) return null;
    return { visitorName: s.visitorName || '', email: s.contactEmail || null, phone: s.contactPhone || null };
  },

  /** «E-mail nebo telefon» из виджета: сохранить, сказать в тему Telegram, дописать контакт в имя темы. */
  async saveContact(sessionId: string, raw: unknown, visitorName?: string) {
    const c = parseContact(raw);
    if (!c) throw new ChatError(400, 'bad_contact', 'Zadejte platný e-mail nebo telefon');
    const session = await (this as any).getOrCreateSession(sessionId, visitorName);
    const field = c.type === 'email' ? 'contactEmail' : 'contactPhone';
    if (session[field] === c.value) return { type: c.type, value: c.value };
    await strapi.db.query(SESSION_UID).update({ where: { id: session.id }, data: { [field]: c.value } });
    session[field] = c.value;

    const hadTopic = Boolean(session.telegramTopicId);
    try {
      await (this as any).sendToTelegram(session, contactTelegramText(c)); // без темы — создаст её уже с контактом в имени
      if (hadTopic) await (this as any).renameTopic(session);
    } catch (e) {
      strapi.log.warn(`chat: contact → telegram failed: ${(e as Error).message}`);
    }
    return { type: c.type, value: c.value };
  },

  async renameTopic(session: any) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId || !session.telegramTopicId) return;
    const res = await fetch(`${TELEGRAM_API}${token}/editForumTopic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_thread_id: session.telegramTopicId,
        name: topicName(session.visitorName, { email: session.contactEmail, phone: session.contactPhone }),
      }),
    });
    const data = (await res.json()) as any;
    if (!data.ok) strapi.log.warn(`chat: editForumTopic failed: ${data.description}`);
  },

  /**
   * Минутный крон: напомнить администраторкам о вопросе без ответа (часы салона) и
   * отправить непрочитанный ответ клиентке, которой уже нет на сайте (e-mail — письмом,
   * телефон — подсказка «напишите SMS» в тему). Отметки пишутся ДО отправки — сбой
   * отправки не повторяется каждую минуту. Push — под env CHAT_PUSH_ENABLED.
   */
  async tick(now: Date = new Date()) {
    const since = new Date(now.getTime() - TICK_WINDOW_DAYS * 86_400_000);
    const rows = await strapi.db.query(MSG_UID).findMany({
      where: { createdAt: { $gte: since } },
      select: ['id', 'text', 'sender', 'telegramFileId', 'createdAt'],
      populate: {
        session: {
          select: ['id', 'sessionId', 'visitorName', 'telegramTopicId', 'contactEmail', 'contactPhone', 'lastSeenAt', 'readUpTo', 'awayUpTo', 'remindedFor'],
        },
      },
      orderBy: { id: 'asc' },
      limit: 5000,
    });
    const groups = new Map<number, { session: any; msgs: any[] }>();
    for (const m of rows as any[]) {
      if (!m.session?.id) continue;
      if (!groups.has(m.session.id)) groups.set(m.session.id, { session: m.session, msgs: [] });
      groups.get(m.session.id).msgs.push(m);
    }
    if (!groups.size) return { remind: 0, away: 0 };

    const { online } = await (this as any).status(now);
    const plan = planChatTick([...groups.values()], now, online);

    for (const r of plan.remind) {
      await strapi.db.query(SESSION_UID).update({ where: { id: r.session.id }, data: { remindedFor: r.first.id } });
      const t = reminderTexts(r);
      await (this as any).sendToTelegram(r.session, t.telegram);
      if (process.env.CHAT_PUSH_ENABLED === 'true') {
        await strapi.service('api::booking-engine.manager-notify').toAdmins(t.push, 'chat-wait').catch((e: Error) =>
          strapi.log.warn(`chat: reminder push failed: ${e.message}`)
        );
      }
    }

    for (const a of plan.away) {
      const upTo = Math.max(...a.msgs.map((m) => Number(m.id)));
      await strapi.db.query(SESSION_UID).update({ where: { id: a.session.id }, data: { awayUpTo: upTo } });
      let text = awayTelegramText(a);
      if (a.via === 'email') {
        const notify = strapi.service('api::booking-engine.booking-notify');
        try {
          const { subject, html } = notify.buildChatReply({
            visitorName: a.session.visitorName,
            sessionId: a.session.sessionId,
            replies: a.msgs.map((m) => ({ text: m.text, hasImage: Boolean(m.telegramFileId) })),
          });
          await notify.sendEmail({ to: a.session.contactEmail, subject, html });
        } catch (e) {
          strapi.log.error(`chat: reply e-mail failed: ${(e as Error).message}`);
          text = `⚠️ Klientka už není na webu a e-mail s odpovědí se nepodařilo odeslat (${a.session.contactEmail}).`;
        }
      }
      await (this as any).sendToTelegram(a.session, text);
    }
    return { remind: plan.remind.length, away: plan.away.length };
  },
};
