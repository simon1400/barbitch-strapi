const TELEGRAM_API = 'https://api.telegram.org/bot';

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
   * Get messages for a session, optionally after a specific message ID
   */
  async getMessages(sessionId: string, afterId?: number) {
    const sessions = await strapi.entityService.findMany('api::chat-session.chat-session' as any, {
      filters: { sessionId },
      limit: 1,
    });

    const results = sessions as any[];
    if (!results || results.length === 0) return [];
    const session = results[0];

    const filters: any = { session: { id: session.id } };
    if (afterId) filters.id = { $gt: afterId };

    return await strapi.entityService.findMany('api::chat-message.chat-message' as any, {
      filters,
      sort: { createdAt: 'asc' },
      limit: 100,
    });
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
        session.visitorName || 'Návštěvník'
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
        body: JSON.stringify({ chat_id: chatId, name: `💬 ${name}` }),
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
};
