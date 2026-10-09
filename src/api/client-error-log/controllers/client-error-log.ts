import { factories } from '@strapi/strapi';
import * as crypto from 'crypto';

const UID = 'api::client-error-log.client-error-log';

const NOISE_PATTERNS = [
  /ResizeObserver loop/i,
  /^Script error\.?$/i,
  /chrome-extension:\/\//i,
  /moz-extension:\/\//i,
  /safari-extension:\/\//i,
  /^Non-Error promise rejection captured/i,
  /Network request failed/i,
  /Load failed/i,
  // Встроенные браузеры соцсетей подмешивают в страницу свои скрипты, и те падают
  // сами по себе: Instagram/Seznam на iOS — window.webkit.messageHandlers,
  // Facebook на Android — «Error invoking postMessage: Java object is gone».
  /window\.webkit\.messageHandlers/i,
  /Error invoking postMessage/i,
  /iabjs:\/\//i,
];

// Стек есть, но ни одного кадра из наших бандлов (/_next/) — упал чужой код:
// скрипт, который встроенный браузер (Instagram, Facebook, Chrome на iOS)
// подмешивает в страницу, или сторонний тег. Пример: «Maximum call stack size
// exceeded» в «barbitch.cz/service/rasy:225» — у нас HTML в одну строку.
// Кадр — строка, оканчивающаяся на «:строка:столбец» (V8, Safari, Firefox).
const isForeignStack = (stack: string): boolean => {
  const frames = stack.split('\n').filter((l) => /:\d+:\d+\)?\s*$/.test(l));
  return frames.length > 0 && !frames.some((l) => l.includes('/_next/'));
};

const truncate = (s: unknown, max: number): string => {
  if (typeof s !== 'string') return '';
  return s.length > max ? s.slice(0, max) : s;
};

const buildHash = (message: string, stack: string): string => {
  const stackHead = stack.split('\n').slice(0, 3).join('\n');
  return crypto.createHash('md5').update(`${message}::${stackHead}`).digest('hex');
};

export default factories.createCoreController(UID, ({ strapi }) => ({
  async report(ctx) {
    const body = ctx.request.body as any;
    const rawMessage = truncate(body?.message, 1000);
    const stack = truncate(body?.stack, 8000);
    const url = truncate(body?.url, 500);
    const userAgent = truncate(body?.userAgent, 500);
    const sessionId = truncate(body?.sessionId, 100);
    const source = ['window-error', 'unhandled-rejection', 'react-error', 'manual'].includes(body?.source)
      ? body.source
      : 'window-error';
    const environment = body?.environment === 'development' ? 'development' : 'production';

    if (!rawMessage) {
      ctx.status = 400;
      ctx.body = { error: 'message is required' };
      return;
    }

    if (NOISE_PATTERNS.some((p) => p.test(rawMessage) || p.test(url)) || isForeignStack(stack)) {
      ctx.body = { skipped: 'noise' };
      return;
    }

    const errorHash = buildHash(rawMessage, stack);
    const now = new Date().toISOString();

    const existing = await strapi.documents(UID).findMany({
      filters: { errorHash },
      limit: 1,
    });

    if (existing && existing.length > 0) {
      const doc = existing[0] as any;
      await strapi.documents(UID).update({
        documentId: doc.documentId,
        data: {
          count: (doc.count || 1) + 1,
          lastSeen: now,
          resolved: false,
          url: url || doc.url,
          userAgent: userAgent || doc.userAgent,
          sessionId: sessionId || doc.sessionId,
        },
      });
      ctx.body = { ok: true, action: 'incremented', documentId: doc.documentId };
      return;
    }

    const created = await strapi.documents(UID).create({
      data: {
        errorHash,
        message: rawMessage,
        stack,
        source,
        url,
        userAgent,
        sessionId,
        environment,
        count: 1,
        firstSeen: now,
        lastSeen: now,
        resolved: false,
      },
    });
    ctx.body = { ok: true, action: 'created', documentId: (created as any).documentId };
  },
}));
