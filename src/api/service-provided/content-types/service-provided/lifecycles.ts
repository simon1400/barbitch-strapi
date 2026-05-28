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
type VerifyFlag = 'ok' | 'sleva' | 'ztrata' | 'salon_up' | 'mistr_up' | 'mistr_down'

const FLAG_EMOJI: Record<VerifyFlag, string> = {
  ok: '🟩',
  sleva: '🟦',
  ztrata: '🟥',
  salon_up: '🟪',
  mistr_up: '🟨',
  mistr_down: '🟨',
}

// Priority for the legacy single-emoji `verify` field (highest first)
const FLAG_PRIORITY: VerifyFlag[] = ['ztrata', 'salon_up', 'mistr_down', 'mistr_up', 'sleva', 'ok']

const dominantEmoji = (flags: VerifyFlag[]): string => {
  for (const f of FLAG_PRIORITY) if (flags.includes(f)) return FLAG_EMOJI[f]
  return FLAG_EMOJI.ok
}

// Parse discount string ("20%", "0.2", "20") → fraction 0..1
const parseSaleRate = (raw: unknown): number => {
  if (raw == null) return 0
  if (typeof raw === 'number') return Number.isFinite(raw) ? (raw > 1 ? raw / 100 : raw) : 0
  if (typeof raw !== 'string') return 0
  const m = raw.match(/(-?\d+(?:[.,]\d+)?)/)
  if (!m) return 0
  const n = parseFloat(m[1].replace(',', '.'))
  if (!Number.isFinite(n) || n <= 0) return 0
  return n > 1 ? n / 100 : n
}

const computeFlags = (
  offerPrice: number,
  ratePercent: number,
  staffSalaries: number,
  salonSalaries: number,
  sale: unknown,
): VerifyFlag[] => {
  const discountRate = parseSaleRate(sale)
  const hasSale = discountRate > 0
  const mustStaff = offerPrice * (ratePercent / 100)
  const mustSalonNow = hasSale
    ? offerPrice * (1 - discountRate) - mustStaff
    : offerPrice - mustStaff

  const flags: VerifyFlag[] = []

  // Master always compared to full-price rule — sale is absorbed by salon
  if (staffSalaries > mustStaff) flags.push('mistr_up')
  if (staffSalaries < mustStaff) flags.push('mistr_down')

  // Salon compared to sale-adjusted expectation
  if (salonSalaries > mustSalonNow) flags.push('salon_up')
  if (salonSalaries < mustSalonNow) flags.push('ztrata')

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

    const staffSalaries = Number(dataCurrent.staffSalaries)
    const salonSalaries = Number(dataCurrent.salonSalaries)

    const flags = computeFlags(
      Number(offer.price),
      Number(personal.ratePercent),
      staffSalaries,
      salonSalaries,
      dataCurrent.sale,
    )

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
