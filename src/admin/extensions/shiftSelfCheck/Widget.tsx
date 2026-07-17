import * as React from 'react';
import { useFetchClient } from '@strapi/strapi/admin';
import { Box, Flex, Typography, Button, Loader, Divider } from '@strapi/design-system';

/**
 * Виджет «Kontrola směny» на дашборде Strapi для администраторов.
 *
 * Read-only самопроверка СЕГОДНЯШНЕЙ смены: показывает только то, что админ может
 * исправить в своих записях (расхождения календарь↔Strapi, записи с неверными
 * суммами, услуга ≠ календарь, отсутствующие записи) + «Rozdíl» (только недостача).
 * НИЧЕГО не публикует и не показывает финметрик владельца. Данные с серверного
 * эндпоинта /api/shift-selfcheck.
 */

interface Flagged {
  client: string;
  master: string;
  flags: { emoji: string; label: string }[];
  staffDelta: number | null;
  salonDelta: number | null;
}

interface SelfCheck {
  date: string;
  ok: boolean;
  problemCount: number;
  rozdil: number; // ≤ 0 (плюс не показывается)
  counts: { services: number; cash: number; workTime: number; calendar: number };
  calendarAvailable: boolean;
  flagged: Flagged[];
  calendarOnly: string[];
  strapiOnly: string[];
  serviceMismatch: { client: string; strapi: string; calendar: string }[];
  missing: { services: boolean; cash: boolean; workTime: boolean };
}

const fmt = (n: number) => n.toLocaleString('cs-CZ', { maximumFractionDigits: 0 });

const fmtDelta = (n: number | null) => {
  if (n == null || n === 0) return '';
  return ` (${n > 0 ? '+' : ''}${fmt(n)} Kč)`;
};

// Theme-aware баннер: фон/рамка через токены design-system (адаптируются к light/dark),
// иначе светлый хардкод-фон + адаптивный текст = невидимо в тёмной теме.
const Banner = ({ tone, children }: { tone: 'ok' | 'danger'; children: React.ReactNode }) => (
  <Box
    padding={4}
    hasRadius
    background={tone === 'ok' ? 'success100' : 'danger100'}
    borderColor={tone === 'ok' ? 'success200' : 'danger200'}
  >
    {children}
  </Box>
);

// Секция со списком — рендерится только когда есть что показать.
const Section = ({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) => (
  <Box paddingTop={3}>
    <Typography variant="sigma" textColor="neutral800">
      {title}
    </Typography>
    {hint && (
      <Box paddingTop={1}>
        <Typography variant="pi" textColor="neutral500">
          {hint}
        </Typography>
      </Box>
    )}
    <Box paddingTop={2}>{children}</Box>
  </Box>
);

const Chip = ({ children, tone }: { children: React.ReactNode; tone: 'danger' | 'warning' | 'neutral' }) => {
  const map = {
    danger: { bg: '#FCECEA', fg: '#B72B1A' },
    warning: { bg: '#FAE7B9', fg: '#9E6A02' },
    neutral: { bg: '#EAEAEF', fg: '#4A4A6A' },
  } as const;
  const c = map[tone];
  return (
    <span
      style={{
        display: 'inline-block',
        background: c.bg,
        color: c.fg,
        borderRadius: 4,
        padding: '2px 8px',
        margin: '2px 6px 2px 0',
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      {children}
    </span>
  );
};

const ShiftSelfCheckWidget = () => {
  const { get } = useFetchClient();
  const [data, setData] = React.useState<SelfCheck | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await get('/api/shift-selfcheck');
      setData(res.data as SelfCheck);
    } catch (e) {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [get]);

  React.useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <Flex justifyContent="center" padding={6}>
        <Loader small>Kontroluji směnu…</Loader>
      </Flex>
    );
  }

  if (error || !data) {
    return (
      <Flex direction="column" gap={2} alignItems="flex-start" padding={2}>
        <Typography textColor="danger600">Nepodařilo se načíst kontrolu směny.</Typography>
        <Button variant="tertiary" onClick={load}>
          Zkusit znovu
        </Button>
      </Flex>
    );
  }

  const hasMissing = data.missing.services || data.missing.cash || data.missing.workTime;

  // Краткая расшифровка проблем по категориям (счётчики в сумме = problemCount) —
  // показывается прямо в баннере, чтобы было видно БЕЗ скролла внутри виджета.
  const summary: string[] = [];
  if (data.missing.services) summary.push('Provedené služby: chybí');
  if (data.missing.cash) summary.push('Pokladna: chybí');
  if (data.missing.workTime) summary.push('Pracovní doba: chybí');
  if (data.calendarOnly.length) summary.push(`Nezapsaní klienti: ${data.calendarOnly.length}`);
  if (data.strapiOnly.length) summary.push(`Záznam navíc / překlep: ${data.strapiOnly.length}`);
  if (data.serviceMismatch.length)
    summary.push(`Služba ≠ kalendář: ${data.serviceMismatch.length}`);
  if (data.flagged.length) summary.push(`Špatně zadané platby: ${data.flagged.length}`);

  return (
    <Flex direction="column" alignItems="stretch" gap={3} padding={2}>
      {/* Маркер: по нему CSS в app.tsx снимает фикс-высоту 261px у <main> виджета
          (Strapi оборачивает контент в Box height=261px overflow=auto) → виджет
          растёт под содержимое, без внутреннего скролла. */}
      <span data-bb-shift-selfcheck aria-hidden style={{ display: 'none' }} />

      {/* Общий статус + краткая расшифровка */}
      {data.ok ? (
        <Banner tone="ok">
          <Typography fontWeight="bold" textColor="success600">
            ✅ Vše v pořádku — směna sedí
          </Typography>
        </Banner>
      ) : (
        <Banner tone="danger">
          <Typography fontWeight="bold" textColor="danger600">
            ⚠️ Najděte a opravte ({data.problemCount}):
          </Typography>
          <Box paddingTop={2}>
            {summary.map((s, i) => (
              <Box key={i} paddingBottom={1}>
                <Typography variant="omega" textColor="danger600">
                  • {s}
                </Typography>
              </Box>
            ))}
          </Box>
        </Banner>
      )}

      {/* Отсутствующие записи */}
      {hasMissing && (
        <Section title="Chybějící záznamy">
          {data.missing.services && <Chip tone="warning">Provedené služby: 0</Chip>}
          {data.missing.cash && <Chip tone="warning">Pokladna: 0</Chip>}
          {data.missing.workTime && <Chip tone="warning">Pracovní doba: 0</Chip>}
        </Section>
      )}

      {/* Не записанные клиенты (есть в календаре, нет в Strapi) */}
      {data.calendarOnly.length > 0 && (
        <Section
          title={`Nezapsaní klienti (${data.calendarOnly.length})`}
          hint="Jsou v kalendáři, ale chybí v záznamech — doplňte je."
        >
          {data.calendarOnly.map((n, i) => (
            <Chip key={i} tone="danger">
              {n}
            </Chip>
          ))}
        </Section>
      )}

      {/* Лишние записи / опечатки имён (нет в календаре) */}
      {data.strapiOnly.length > 0 && (
        <Section
          title={`Záznam navíc / překlep (${data.strapiOnly.length})`}
          hint="V záznamech je, v kalendáři ne — překlep jména nebo záznam navíc."
        >
          {data.strapiOnly.map((n, i) => (
            <Chip key={i} tone="warning">
              {n}
            </Chip>
          ))}
        </Section>
      )}

      {/* Услуга ≠ календарь */}
      {data.serviceMismatch.length > 0 && (
        <Section
          title={`Služba ≠ kalendář (${data.serviceMismatch.length})`}
          hint="Připojená služba se liší od služby v kalendáři."
        >
          {data.serviceMismatch.map((m, i) => (
            <Box key={i} paddingBottom={1}>
              <Typography variant="pi" textColor="neutral800" fontWeight="bold">
                {m.client}
              </Typography>
              <Typography variant="pi" textColor="neutral600">
                {' '}
                — záznam: {m.strapi} / kalendář: {m.calendar}
              </Typography>
            </Box>
          ))}
        </Section>
      )}

      {/* Записи с неверными суммами */}
      {data.flagged.length > 0 && (
        <Section
          title={`Špatně zadané platby (${data.flagged.length})`}
          hint="Částky neodpovídají ceníku a procentu mistra."
        >
          {data.flagged.map((f, i) => {
            const isZtrata = f.flags.some((x) => x.label.includes('Ztráta'));
            const delta = isZtrata ? f.salonDelta : f.staffDelta ?? f.salonDelta;
            return (
              <Box key={i} paddingBottom={1}>
                <Typography variant="pi" textColor="neutral800" fontWeight="bold">
                  {f.client}
                </Typography>
                <Typography variant="pi" textColor="neutral600">
                  {' '}
                  — {f.master}: {f.flags.map((x) => `${x.emoji} ${x.label}`).join(', ')}
                  {fmtDelta(delta)}
                </Typography>
              </Box>
            );
          })}
        </Section>
      )}

      <Divider />

      <Flex justifyContent="space-between" alignItems="center">
        <Typography variant="pi" textColor="neutral500">
          Dnes: {data.date}
          {!data.calendarAvailable && ' · kontrola kalendáře nedostupná'}
        </Typography>
        <Button variant="tertiary" size="S" onClick={load}>
          Zkontrolovat znovu
        </Button>
      </Flex>
    </Flex>
  );
};

export default ShiftSelfCheckWidget;
