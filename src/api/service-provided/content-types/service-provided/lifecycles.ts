const UID = 'api::service-provided.service-provided';
const OfferUID = 'api::offer.offer';
const PersonalUID = 'api::personal.personal';

// Flag codes (kept in sync with admin client):
//   ok          🟩 everything matches the rule
//   sleva       🟦 short payment explained by intentional sale
//   ztrata      🟥 salon got less than rule, no sale → money leak
//   salon_up    🟪 salon got more than rule (suspicious)
//   mistr_up    🟨↑ master received more than rule
//   mistr_down  🟨↓ master received less than rule
//   internal    🤝 internal worker-to-worker service: salon profit 0 is normal,
//               only the master percentage is checked
//   sleva_bez_karty 🎟 informational (K4): record has a sale, but the client has
//               no used bitchcard redemption on any booking of that day — the
//               discount was given outside the loyalty program (check why).
//               Only added when LOYALTY_ENABLED=true.
type VerifyFlag =
  | 'ok'
  | 'sleva'
  | 'ztrata'
  | 'salon_up'
  | 'mistr_up'
  | 'mistr_down'
  | 'internal'
  | 'sleva_bez_karty'

const FLAG_EMOJI: Record<VerifyFlag, string> = {
  ok: '🟩',
  sleva: '🟦',
  ztrata: '🟥',
  salon_up: '🟪',
  mistr_up: '🟨',
  mistr_down: '🟨',
  internal: '🤝',
  sleva_bez_karty: '🎟',
}

// Priority for the legacy single-emoji `verify` field (highest first)
const FLAG_PRIORITY: VerifyFlag[] = ['ztrata', 'salon_up', 'mistr_down', 'mistr_up', 'internal', 'sleva_bez_karty', 'sleva', 'ok']

const dominantEmoji = (flags: VerifyFlag[]): string => {
  for (const f of FLAG_PRIORITY) if (flags.includes(f)) return FLAG_EMOJI[f]
  return FLAG_EMOJI.ok
}

// Parse discount → fraction 0..1 of the full offer price.
// Accepts percent ("20%", "20", "0.2") or an absolute amount in Kč ("400"):
// a percent can't exceed 100, so values above 100 are treated as crowns off
// the full price. Values in 1..100 stay percent ("50" = 50 %, not 50 Kč).
const parseSaleRate = (raw: unknown, offerPrice: number): number => {
  let n = 0
  if (typeof raw === 'number') n = Number.isFinite(raw) ? raw : 0
  else if (typeof raw === 'string') {
    const m = raw.match(/(-?\d+(?:[.,]\d+)?)/)
    n = m ? parseFloat(m[1].replace(',', '.')) : 0
  }
  if (!Number.isFinite(n) || n <= 0) return 0
  if (n <= 1) return n
  if (n <= 100) return n / 100
  return offerPrice > 0 ? Math.min(n / offerPrice, 1) : 0
}

const computeFlags = (
  offerPrice: number,
  ratePercent: number,
  staffSalaries: number,
  salonSalaries: number,
  sale: unknown,
  internal: boolean,
): VerifyFlag[] => {
  const mustStaff = offerPrice * (ratePercent / 100)

  // Round to whole crowns (cents) before comparing. Otherwise float noise like
  // 1112 * 0.3 = 333.59999999999997 makes an exact 333.6 look "bigger" → false
  // mistr_up + ztrata. Rounding kills the artifact without masking real diffs.
  const r = (n: number) => Math.round(n * 100) / 100
  const rStaff = r(staffSalaries)
  const rMustStaff = r(mustStaff)

  // Internal worker-to-worker service: the salon earns nothing, so a salon profit of 0
  // is normal. Only the master percentage is verified; salon is NOT checked.
  if (internal) {
    const flags: VerifyFlag[] = ['internal']
    if (rStaff > rMustStaff) flags.push('mistr_up')
    if (rStaff < rMustStaff) flags.push('mistr_down')
    return flags
  }

  const discountRate = parseSaleRate(sale, offerPrice)
  const hasSale = discountRate > 0
  const mustSalonNow = hasSale
    ? offerPrice * (1 - discountRate) - mustStaff
    : offerPrice - mustStaff
  const rSalon = r(salonSalaries)
  const rMustSalon = r(mustSalonNow)

  const flags: VerifyFlag[] = []

  // Master always compared to full-price rule — sale is absorbed by salon
  if (rStaff > rMustStaff) flags.push('mistr_up')
  if (rStaff < rMustStaff) flags.push('mistr_down')

  // Salon compared to sale-adjusted expectation
  if (rSalon > rMustSalon) flags.push('salon_up')
  if (rSalon < rMustSalon) flags.push('ztrata')

  // Informational tag — record has a discount
  if (hasSale) flags.push('sleva')

  if (flags.length === 0) flags.push('ok')
  return flags
}

async function validateOfferMoney(event: any) {

  const dataCurrent = event.params.data

  const documentId = dataCurrent.documentId

  const current = documentId
    ? await strapi.documents(UID).findOne({
        documentId,
        populate: {
          personal: { fields: ['ratePercent'] },
          offer: { fields: ['price'] },
        }
      })
    : null;

    const offer = dataCurrent?.offer?.connect?.length ? await (strapi.db as any).query(OfferUID).findOne({
      where: { id: { $in: dataCurrent.offer.connect[0].id } },
      select: ['price'],
    }) : current?.offer
    const personal = dataCurrent?.personal?.connect?.length ? await (strapi.db as any).query(PersonalUID).findOne({
      where: { id: { $in: dataCurrent.personal.connect[0].id } },
      select: ['ratePercent'],
    }) : current?.personal

    // Skip validation if offer or personal data is not available (e.g. during publish)
    if (!offer || !personal) return;

    // Money is stored as a string; junior prices may use a comma decimal ("237,6").
    // Number("237,6") = NaN, so normalize the comma before parsing.
    const num = (v: unknown): number => {
      const n = Number(String(v ?? '').replace(',', '.').replace(/\s/g, ''))
      return Number.isFinite(n) ? n : 0
    }

    // 🟥 On a partial update (e.g. publish) Strapi omits the scalar money/sale fields.
    // Number(undefined) = NaN, and every comparison with NaN is false, so computeFlags
    // used to fall through to 'ok' — silently overwriting the correct verifyFlags with
    // a green tick even when the salon/master price was never filled. Fall back to the
    // stored values (nullish-coalescing keeps an explicitly-emptied "" → 0 → real flag).
    const staffRaw = dataCurrent.staffSalaries ?? current?.staffSalaries
    const salonRaw = dataCurrent.salonSalaries ?? current?.salonSalaries
    const saleRaw = dataCurrent.sale ?? current?.sale
    const staffSalaries = num(staffRaw)
    const salonSalaries = num(salonRaw)

    // `internal` may be absent on a partial update (e.g. publish) — fall back to current.
    const internalRaw = dataCurrent.internal
    const internal =
      internalRaw === undefined || internalRaw === null
        ? Boolean(current?.internal)
        : Boolean(internalRaw)

    const flags = computeFlags(
      Number(offer.price),
      Number(personal.ratePercent),
      staffSalaries,
      salonSalaries,
      saleRaw,
      internal,
    )

    // K4 informational flag: sale present, but no used bitchcard redemption on the
    // client's bookings of that day → the discount was given outside the program.
    // Matching chain: service-provided (clientName+date) → bookings of the day by
    // clientNameRaw → redemptions used with usedInBookingDocId among them.
    if (flags.includes('sleva') && process.env.LOYALTY_ENABLED === 'true') {
      try {
        const clientName = String(dataCurrent.clientName ?? current?.clientName ?? '').trim()
        const date = String(dataCurrent.date ?? current?.date ?? '').slice(0, 10)
        let hasRedemption = false
        if (clientName && date) {
          const bookings = await strapi.documents('api::booking.booking').findMany({
            filters: { date: { $eq: date }, clientNameRaw: { $eqi: clientName } },
            fields: ['date', 'discount'],
            limit: 20,
          })
          // применённая скидка дозаписи (rebook, thank-you) — тоже легитимная
          // системная скидка: флаг «мимо программы» не ставим
          const hasRebookDiscount = bookings.some(
            (b: any) => b.discount?.type === 'rebook' && b.discount?.applied,
          )
          const ids = bookings.map((b: any) => b.documentId)
          if (ids.length && !hasRebookDiscount) {
            const used = await strapi.documents('api::redemption.redemption').count({
              filters: { status: { $eq: 'used' }, usedInBookingDocId: { $in: ids } },
            })
            hasRedemption = used > 0
          }
          hasRedemption = hasRedemption || hasRebookDiscount
        }
        if (!hasRedemption) flags.push('sleva_bez_karty')
      } catch (e: any) {
        // lookup failure must not block saving the record
        strapi.log.warn(`service-provided sleva_bez_karty check failed: ${e?.message || e}`)
      }
    }

    event.params.data.verifyFlags = flags
    event.params.data.verify = dominantEmoji(flags)
}

export default {
  async beforeCreate(event) {
    await validateOfferMoney(event);
  },
  async beforeUpdate(event) {
    await validateOfferMoney(event);
  },
};
