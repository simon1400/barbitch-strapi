// @ts-nocheck

// Revert a shift close: UN-PUBLISH every record published for the given day so it
// returns to draft (Strapi 5 unpublish KEEPS the draft version → data is preserved)
// and can be edited & re-closed. This NEVER deletes anything.
//
// Why a custom endpoint: Strapi 5 REST has no safe "unpublish". The only safe way is
// the server-side Document Service API (`strapi.documents(uid).unpublish`). The
// content-API `DELETE ?status=published` DELETES the whole record (s48 incident).
//
// Card-profit (monthly, cumulative across shifts) is intentionally left untouched —
// re-closing overwrites its sum/extraIncome. Vouchers are handled on the admin side
// (clearing dateRealized via the proven REST inverse of publish).
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default {
  async revertShift(date: string) {
    if (!date || !DATE_RE.test(date)) {
      throw new Error('Invalid date (expected YYYY-MM-DD)');
    }
    const result = {
      date,
      unpublished: { cashs: 0, 'services-provided': 0, 'work-times': 0, payrolls: 0 },
      errors: [] as string[],
    };

    const collections = [
      { key: 'cashs', uid: 'api::cash.cash', filters: { date } },
      { key: 'services-provided', uid: 'api::service-provided.service-provided', filters: { date } },
      { key: 'work-times', uid: 'api::work-time.work-time', filters: { date } },
      { key: 'payrolls', uid: 'api::payroll.payroll', filters: { date } },
    ];

    for (const c of collections) {
      try {
        const items = await strapi.documents(c.uid).findMany({
          filters: c.filters,
          status: 'published',
          pagination: { pageSize: 200 },
        });
        for (const it of items) {
          try {
            await strapi.documents(c.uid).unpublish({ documentId: it.documentId });
            result.unpublished[c.key]++;
          } catch (e: any) {
            result.errors.push(`${c.key} ${it.documentId}: ${e.message}`);
          }
        }
      } catch (e: any) {
        result.errors.push(`${c.key}: ${e.message}`);
      }
    }

    return result;
  },
};
