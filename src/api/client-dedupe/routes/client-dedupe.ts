// Роуты модуля «Дубли клиентов». auth:false — авторизация admin-jwt внутри
// контроллера (owner-only), как у /engine/admin/*.

const route = (method: string, path: string, handler: string) => ({
  method,
  path,
  handler,
  config: { auth: false, policies: [], middlewares: [] },
})

export default {
  routes: [
    route('GET', '/client-dedupe/groups', 'client-dedupe.groups'),
    route('GET', '/client-dedupe/history', 'client-dedupe.history'),
    route('POST', '/client-dedupe/merge', 'client-dedupe.merge'),
    route('POST', '/client-dedupe/client', 'client-dedupe.updateClient'),
    route('POST', '/client-dedupe/blacklist', 'client-dedupe.blacklist'),
    route('POST', '/client-dedupe/ignore', 'client-dedupe.ignore'),
    route('POST', '/client-dedupe/unignore', 'client-dedupe.unignore'),
  ],
}
