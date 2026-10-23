export default {
  async send(ctx) {
    // Supports both JSON (text only) and FormData (text + image)
    const body = ctx.request.body as any;
    const sessionId = body?.sessionId;
    const text = body?.text || '';
    const visitorName = body?.visitorName;
    const imageFile = (ctx.request as any).files?.image;

    if (!sessionId) {
      ctx.throw(400, 'sessionId is required');
      return;
    }

    const chatService = strapi.service('api::chat.chat') as any;
    const session = await chatService.getOrCreateSession(sessionId, visitorName);

    // Send to Telegram and get file_id if image was attached
    let telegramFileId: string | undefined;
    try {
      telegramFileId = await chatService.sendToTelegram(session, text, imageFile);
    } catch (err) {
      strapi.log.error('Telegram send failed:', err);
    }

    const message = await chatService.createMessage(session, text, 'visitor', telegramFileId);
    ctx.body = { data: message };
  },

  async messages(ctx) {
    const { sessionId, after, open } = ctx.request.query as { sessionId?: string; after?: string; open?: string };

    if (!sessionId) {
      ctx.throw(400, 'sessionId is required');
      return;
    }

    const chatService = strapi.service('api::chat.chat') as any;
    const messages = await chatService.getMessages(sessionId, after ? Number(after) : undefined, { open: open === '1' });
    ctx.body = messages;
  },

  // s272: онлайн ли чат (часы салона) и когда откроемся
  async status(ctx) {
    ctx.body = await (strapi.service('api::chat.chat') as any).status();
  },

  // s272: имя и оставленный контакт сессии (ссылка из письма на другом устройстве)
  async session(ctx) {
    const sessionId = (ctx.request.query as any).sessionId;
    if (!sessionId) {
      ctx.throw(400, 'sessionId is required');
      return;
    }
    const info = await (strapi.service('api::chat.chat') as any).sessionInfo(String(sessionId));
    if (!info) {
      ctx.status = 404;
      ctx.body = { error: { status: 404, code: 'not_found', message: 'Chat nenalezen' } };
      return;
    }
    ctx.body = info;
  },

  // s272: «e-mail nebo telefon» из виджета
  async contact(ctx) {
    const body = (ctx.request.body || {}) as any;
    if (!body.sessionId) {
      ctx.throw(400, 'sessionId is required');
      return;
    }
    try {
      ctx.body = await (strapi.service('api::chat.chat') as any).saveContact(String(body.sessionId), body.contact, body.visitorName);
    } catch (e: any) {
      if (!e?.code || !e?.status) throw e;
      ctx.status = e.status;
      ctx.body = { error: { status: e.status, code: e.code, message: e.message } };
    }
  },

  /**
   * Proxy Telegram images — stable URL that never expires
   * Client uses: /api/chat/file?id=<telegramFileId>
   */
  async file(ctx) {
    const fileId = (ctx.request.query as any).id;
    if (!fileId) {
      ctx.throw(400, 'id is required');
      return;
    }

    const chatService = strapi.service('api::chat.chat') as any;
    const result = await chatService.proxyTelegramFile(fileId as string);

    if (!result) {
      ctx.throw(404, 'File not found');
      return;
    }

    ctx.set('Content-Type', result.contentType);
    ctx.set('Cache-Control', 'public, max-age=86400'); // 24h cache
    ctx.body = result.buffer;
  },

  async webhook(ctx) {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (secret && ctx.request.headers['x-telegram-bot-api-secret-token'] !== secret) {
      ctx.throw(403, 'Invalid secret');
      return;
    }

    const chatService = strapi.service('api::chat.chat') as any;
    await chatService.handleWebhook(ctx.request.body);
    ctx.body = { ok: true };
  },
};
