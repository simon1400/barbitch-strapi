// Пересчёт verify-флагов записи «Оказанная услуга» при сохранении из Content Manager.
//
// Два источника полной цены:
//   • booking-путь (вариант D2): запись создана чекаутом из календаря и несёт связь
//     `booking` → цены/скидки берём из брони (юниор-цена, дозапись −15 %, bitchcard);
//   • legacy CM-путь: связь `offer` → цена из оффера (записи эпохи Noona).
//
// ⚠️ Записи, созданные движком (POST /engine/admin/bookings/:id/checkout), флаги
// получают ОТ ДВИЖКА — при plain-REST create этот lifecycle не видит relations
// в CM-формате и посчитал бы null (гоча s129). Здесь формулы те же (общий модуль
// utils/verify-flags), поэтому пересохранение в CM даёт идентичный результат.

import {
  computeBookingFlags,
  computeOfferFlags,
  dominantEmoji,
  parseMoney,
  type VerifyFlag,
} from '../../../../utils/verify-flags';

const UID = 'api::service-provided.service-provided';
const OfferUID = 'api::offer.offer';
const PersonalUID = 'api::personal.personal';
const BookingUID = 'api::booking.booking';

async function validateOfferMoney(event: any) {

  const dataCurrent = event.params.data

  const documentId = dataCurrent.documentId

  // Правка из Content Manager несёт documentId в payload; plain-REST update (PUT
  // /api/services-provided/:id) — нет, там опереться можно только на event.params.where.id.
  // Без этого фолбэка REST-правка молча оставляла бы старые (устаревшие) флаги.
  const whereId = event.params?.where?.id
  const current = documentId
    ? await strapi.documents(UID).findOne({
        documentId,
        populate: {
          personal: { fields: ['ratePercent'] },
          offer: { fields: ['price'] },
          booking: { fields: ['services', 'totalPrice', 'priceOverride', 'discount'] },
        }
      })
    : typeof whereId === 'number'
      ? await (strapi.db as any).query(UID).findOne({
          where: { id: whereId },
          populate: { personal: true, offer: true, booking: true },
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
    const booking = dataCurrent?.booking?.connect?.length ? await (strapi.db as any).query(BookingUID).findOne({
      where: { id: { $in: dataCurrent.booking.connect[0].id } },
      select: ['documentId', 'services', 'totalPrice', 'priceOverride', 'discount'],
    }) : current?.booking

    // Skip validation if the price source or personal data is not available (e.g. during publish)
    if ((!offer && !booking) || !personal) return;

    // 🟥 On a partial update (e.g. publish) Strapi omits the scalar money/sale fields.
    // Number(undefined) = NaN, and every comparison with NaN is false, so computeFlags
    // used to fall through to 'ok' — silently overwriting the correct verifyFlags with
    // a green tick even when the salon/master price was never filled. Fall back to the
    // stored value ТОЛЬКО когда ключа в payload нет: `?? ` подставлял старое значение и
    // при ЯВНОЙ очистке поля (null) — снятая скидка продолжала считаться действующей.
    const pick = (key: string) => (key in dataCurrent ? dataCurrent[key] : current?.[key])
    const staffRaw = pick('staffSalaries')
    const salonRaw = pick('salonSalaries')
    const saleRaw = pick('sale')
    const staffSalaries = parseMoney(staffRaw)
    const salonSalaries = parseMoney(salonRaw)

    const internal = Boolean(pick('internal'))

    const ratePercent = Number(personal.ratePercent)

    // Бронь выигрывает у оффера: у booking-linked записи оффер — легаси-поле
    const flags: VerifyFlag[] = booking
      ? computeBookingFlags({ booking, ratePercent, staffSalaries, salonSalaries, sale: saleRaw, internal })
      : computeOfferFlags(Number(offer.price), ratePercent, staffSalaries, salonSalaries, saleRaw, internal)

    // K4 informational flag: sale present, but no used bitchcard redemption on the
    // client's bookings of that day → the discount was given outside the program.
    // Booking-linked запись матчится структурно (по documentId брони); legacy-запись —
    // по цепочке service-provided (clientName+date) → bookings по clientNameRaw →
    // redemptions used с usedInBookingDocId среди них.
    if (flags.includes('sleva') && process.env.LOYALTY_ENABLED === 'true') {
      try {
        let hasRedemption = false
        if (booking?.documentId) {
          const hasRebookDiscount = booking.discount?.type === 'rebook' && booking.discount?.applied
          if (hasRebookDiscount) {
            hasRedemption = true
          } else {
            const used = await strapi.documents('api::redemption.redemption').count({
              filters: { status: { $eq: 'used' }, usedInBookingDocId: { $eq: booking.documentId } },
            })
            hasRedemption = used > 0
          }
        } else {
          const clientName = String(dataCurrent.clientName ?? current?.clientName ?? '').trim()
          const date = String(dataCurrent.date ?? current?.date ?? '').slice(0, 10)
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
