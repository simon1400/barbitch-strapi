// Čistá část ručky GET /api/vaucher-page/service-vouchers (bez Strapi):
// karty voucherů na službu ze stránky + služba z katalogu rezervací → seznam
// pro web. Oddělené kvůli testům.

export interface ServiceVoucherRow {
  service?: { documentId?: string; title?: string; price?: number; active?: boolean; onlineBookable?: boolean } | null
  tag?: string | null
  name?: string | null
  title?: string | null
  desc?: string | null
  photo?: { url?: string; formats?: Record<string, { url?: string }> } | null
  active?: boolean | null
}

export interface ServiceVoucherOut {
  /** Stabilní id karty — podle služby, ne podle řádku komponenty (ten se při uložení mění). */
  id: string
  serviceId: string
  tag: string
  name: string
  title: string
  desc: string
  photo: string | null
  price: number
}

/** Fotka pro kartu (~460 px): large, jinak originál. */
const photoUrl = (photo: ServiceVoucherRow['photo']): string | null =>
  photo?.formats?.large?.url || photo?.url || null

/**
 * Vyřadí vypnuté karty, karty bez služby, se službou vypnutou nebo bez online
 * rezervace a s nulovou cenou; duplicitní službu nechá jen jednou. Pořadí = pořadí v CMS.
 */
export const shapeServiceVouchers = (rows: ServiceVoucherRow[] | null | undefined): ServiceVoucherOut[] => {
  const out: ServiceVoucherOut[] = []
  const seen = new Set<string>()
  for (const row of rows ?? []) {
    if (row.active === false) continue
    const svc = row.service
    if (!svc?.documentId || svc.active === false || svc.onlineBookable === false) continue
    const price = Number(svc.price)
    if (!(price > 0)) continue
    if (seen.has(svc.documentId)) continue
    seen.add(svc.documentId)
    const name = (row.name || svc.title || '').trim()
    if (!name) continue
    out.push({
      id: `sluzba-${svc.documentId}`,
      serviceId: svc.documentId,
      tag: (row.tag || '').trim(),
      name,
      title: (row.title || `Voucher na ${name.toLowerCase()}`).trim(),
      desc: (row.desc || '').trim(),
      photo: photoUrl(row.photo),
      price,
    })
  }
  return out
}
