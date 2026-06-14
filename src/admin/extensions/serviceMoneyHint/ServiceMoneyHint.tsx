import * as React from 'react';
import {
  unstable_useContentManagerContext as useContentManagerContext,
  useFetchClient,
} from '@strapi/strapi/admin';
import { Box, Flex, Typography, Divider } from '@strapi/design-system';

/**
 * Side panel in the Content Manager Edit view of "Оказанные услуги"
 * (api::service-provided.service-provided). It mirrors the verifyFlags math from
 * src/api/service-provided/.../lifecycles.ts and shows the admin the recommended
 * "Цена мастера" / "Прибыль салона" so they don't have to compute on a calculator.
 *
 * It only DISPLAYS the numbers — it does NOT auto-fill the fields, so verifyFlags
 * stays meaningful as a typo / skim guard.
 *
 * Renders only for the service-provided model (returns null otherwise).
 */

const UID = 'api::service-provided.service-provided';
const OFFER_UID = 'api::offer.offer';
const PERSONAL_UID = 'api::personal.personal';

// --- mirror of parseSaleRate in lifecycles.ts ---
// Discount → fraction 0..1 of the full offer price. Percent ("20%","20","0.2") or
// absolute crowns ("400"): a percent can't exceed 100, so >100 = crowns off.
const parseSaleRate = (raw: unknown, offerPrice: number): number => {
  let n = 0;
  if (typeof raw === 'number') n = Number.isFinite(raw) ? raw : 0;
  else if (typeof raw === 'string') {
    const m = raw.match(/(-?\d+(?:[.,]\d+)?)/);
    n = m ? parseFloat(m[1].replace(',', '.')) : 0;
  }
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n <= 1) return n;
  if (n <= 100) return n / 100;
  return offerPrice > 0 ? Math.min(n / offerPrice, 1) : 0;
};

// Round to whole crowns/cents, like the lifecycle comparison.
const round2 = (n: number) => Math.round(n * 100) / 100;

// Render a number with a DOT separator so the admin copies a value that
// Number(staffSalaries) parses (a comma would become NaN in the lifecycle).
const fmt = (n: number) => String(round2(n));

type RelationFieldValue = {
  connect?: Array<{ documentId?: string; apiData?: { documentId?: string } }>;
  disconnect?: Array<unknown>;
};

/**
 * Resolve the currently selected relation documentId for `fieldName`.
 *  - a fresh pick lives in form.values[field].connect (creation + edit-with-change)
 *  - a removal (disconnect, no reconnect) → no selection
 *  - an unchanged existing record → query the relations endpoint (best-effort)
 */
const useSelectedDocId = (fieldName: string): string | null => {
  const ctx = useContentManagerContext() as any;
  const { get } = useFetchClient();

  const fieldVal: RelationFieldValue | undefined = ctx.form?.values?.[fieldName];
  const connect = fieldVal?.connect;
  const connectDocId =
    Array.isArray(connect) && connect.length > 0
      ? connect[connect.length - 1]?.apiData?.documentId ??
        connect[connect.length - 1]?.documentId ??
        null
      : null;
  const removed = Array.isArray(fieldVal?.disconnect) && fieldVal!.disconnect!.length > 0;

  const parentId: string | undefined = ctx.id;
  const isCreating = Boolean(ctx.isCreatingEntry) || parentId === 'create' || !parentId;

  const [serverDocId, setServerDocId] = React.useState<string | null>(null);

  React.useEffect(() => {
    // Fresh pick wins; removal → none; only query the server for an unchanged existing record.
    if (connectDocId || removed || isCreating) {
      setServerDocId(null);
      return;
    }
    let cancelled = false;
    get(`/content-manager/relations/${UID}/${parentId}/${fieldName}`)
      .then((res: any) => {
        if (cancelled) return;
        const results = res?.data?.results ?? [];
        setServerDocId(results[0]?.documentId ?? null);
      })
      .catch(() => {
        if (!cancelled) setServerDocId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [connectDocId, removed, isCreating, parentId, fieldName, get]);

  if (connectDocId) return connectDocId;
  if (removed) return null;
  return serverDocId;
};

/** Fetch a single numeric field of a related entry by documentId. */
const useEntityNumber = (model: string, docId: string | null, field: string): number | null => {
  const { get } = useFetchClient();
  const [val, setVal] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (!docId) {
      setVal(null);
      return;
    }
    let cancelled = false;
    get(`/content-manager/collection-types/${model}/${docId}`)
      .then((res: any) => {
        if (cancelled) return;
        const entry = res?.data?.data ?? res?.data;
        const n = Number(entry?.[field]);
        setVal(Number.isFinite(n) ? n : null);
      })
      .catch(() => {
        if (!cancelled) setVal(null);
      });
    return () => {
      cancelled = true;
    };
  }, [model, docId, field, get]);

  return val;
};

const Row = ({ label, value }: { label: string; value: string }) => (
  <Flex justifyContent="space-between" alignItems="baseline" gap={2}>
    <Typography variant="omega" textColor="neutral600">
      {label}
    </Typography>
    <Typography variant="beta" fontWeight="bold" textColor="neutral800">
      {value}
    </Typography>
  </Flex>
);

const ServiceMoneyContent = () => {
  const ctx = useContentManagerContext() as any;
  const values = ctx.form?.values ?? {};

  const offerDocId = useSelectedDocId('offer');
  const personalDocId = useSelectedDocId('personal');

  const price = useEntityNumber(OFFER_UID, offerDocId, 'price');
  const ratePercent = useEntityNumber(PERSONAL_UID, personalDocId, 'ratePercent');

  const sale = values.sale;
  const internal = Boolean(values.internal);

  const ready = price != null && ratePercent != null;

  const result = React.useMemo(() => {
    if (!ready) return null;
    const mustStaff = (price as number) * ((ratePercent as number) / 100);
    if (internal) {
      return { mustStaff, mustSalon: 0, discountRate: 0 };
    }
    const discountRate = parseSaleRate(sale, price as number);
    const mustSalon =
      discountRate > 0
        ? (price as number) * (1 - discountRate) - mustStaff
        : (price as number) - mustStaff;
    return { mustStaff, mustSalon, discountRate };
  }, [ready, price, ratePercent, internal, sale]);

  return (
    <Flex direction="column" alignItems="stretch" gap={3} padding={1}>
      {!ready ? (
        <Typography variant="omega" textColor="neutral600">
          Выберите «Мастера» и «Оказанную услугу» — подсказка посчитает сумму.
        </Typography>
      ) : (
        <>
          <Box
            background="primary100"
            padding={3}
            hasRadius
            borderColor="primary200"
            borderStyle="solid"
            borderWidth="1px"
          >
            <Flex direction="column" alignItems="stretch" gap={2}>
              <Row label="Цена мастера" value={`${fmt(result!.mustStaff)} Kč`} />
              <Divider />
              <Row
                label="Прибыль салона"
                value={`${fmt(result!.mustSalon)} Kč`}
              />
            </Flex>
          </Box>

          <Flex direction="column" alignItems="stretch" gap={1}>
            <Typography variant="pi" textColor="neutral600">
              Услуга {fmt(price as number)} Kč · процент мастера {ratePercent}%
            </Typography>
            {internal ? (
              <Typography variant="pi" textColor="warning600">
                🤝 Внутренняя услуга — прибыль салона 0 Kč (норма).
              </Typography>
            ) : result!.discountRate > 0 ? (
              <Typography variant="pi" textColor="secondary600">
                🟦 Со скидкой {Math.round(result!.discountRate * 100)}% — скидку
                поглощает салон, мастер получает % от полной цены.
              </Typography>
            ) : null}
            <Typography variant="pi" textColor="neutral500">
              Рекомендуемые значения. Чаевые вписывайте отдельно.
            </Typography>
          </Flex>
        </>
      )}
    </Flex>
  );
};

/**
 * Edit-view side panel descriptor. Returns null for any content type other than
 * service-provided so the panel is scoped (the renderer drops null descriptions).
 */
export const ServiceMoneyPanel = ({ model }: { model: string }) => {
  if (model !== UID) return null;
  return {
    title: 'Расчёт (подсказка)',
    content: <ServiceMoneyContent />,
  };
};
