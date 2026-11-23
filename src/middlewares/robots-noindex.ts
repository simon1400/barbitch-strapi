/**
 * strapi.barbitch.cz — CMS a API, ne web: nic odsud nemá být ve vyhledávači
 * (Bing 23.11.2026 měl v indexu přihlášení do administrace).
 *
 * Hlavička `X-Robots-Tag` na KAŽDÉ odpovědi (administrace, API, soubory).
 * Funguje jen tehdy, když robot stránku smí stáhnout — proto `public/robots.txt`
 * nezakazuje `/` a `/admin`, jen `/api/` (tam nemá robot co dělat a sdílený
 * limit dotazů na IP by mu docházel místo zákaznic).
 *
 * Obrázky webu jdou z ImageKitu, ne odsud — hlavička je nezasáhne.
 * Zapojeno jako PRVNÍ v `config/middlewares.ts`, aby ji dostaly i chyby a 429.
 */
export default () => {
  return async (ctx: any, next: () => Promise<void>) => {
    ctx.set('X-Robots-Tag', 'noindex, nofollow')
    await next()
  }
}
