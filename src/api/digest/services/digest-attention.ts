// Дополнения дайджеста для управляющей (s230, решение владельца вместо Фазы H):
// администратор смены, «Ke schválení», ваучеры к подтверждению, сроки документов
// сотрудников, ближайшие дни рождения. Источники — те же сервисы, что у «Сегодня»
// (blocks/pending, today.vouchers, staff.reminders, birthdays, shifts); здесь только
// чистое форматирование, без базы.
//
// 🟥 Чат дайджеста читают и администраторы: документы — только имя, тип и срок
// (номеров и сканов нет), договоры — имя, тип и дата (без IČO, фаза 2 карточки),
// дни рождения — только день и месяц.
// Запросы управляющей по затратам (s237) — только ЧИСЛО: администраторам затраты
// не показываются (решение владельца, план затрат §0.1).

export const BIRTHDAY_DAYS = 7;
export const MAX_ROWS = 8;

const WEEKDAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const dm = (ymd: unknown): string => {
  const s = String(ymd ?? '');
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? `${s.slice(8, 10)}.${s.slice(5, 7)}` : '';
};

const hhmm = (min: unknown): string => {
  const n = Number(min);
  if (min == null || !Number.isFinite(n)) return '';
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
};

const span = (from: unknown, to: unknown): string => {
  const a = hhmm(from);
  const b = hhmm(to);
  return a && b ? `${a}–${b}` : '';
};

const kc = (n: unknown): string => `${Math.round(Number(n) || 0).toLocaleString('cs-CZ').replace(/ /g, ' ')} Kč`;

const days = (n: number): string => `${n} дн.`;

const CONTRACT_TYPE_LABEL = { hpp: 'HPP', dpp: 'DPP', ico: 'IČO' };

/** Имя администратора из недели графика (`shift`) на дату; '' — не указан. */
export const adminOnDate = (week: { days?: Record<string, string> | null } | null | undefined, date: string): string => {
  if (!week?.days || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
  const key = WEEKDAY_KEYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
  return String(week.days[key] ?? '').replace(/\s+/g, ' ').trim();
};

/** Понедельник недели даты (ГГГГ-ММ-ДД). */
export const mondayOf = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

const capped = (rows: string[], tail: (n: number) => string): string[] =>
  rows.length > MAX_ROWS ? [...rows.slice(0, MAX_ROWS), tail(rows.length - MAX_ROWS)] : rows;

const more = (n: number) => `• …і ще ${n}`;

export interface AttentionInput {
  today: string;
  /** undefined — источник упал (раздел не выводится); '' — в графике не указан */
  admin?: string;
  pending?: { items: any[]; planRequests: any[] };
  /** запросов управляющей по затратам ждёт владельца (s237); undefined — источник упал */
  costRequests?: number;
  vouchers?: { paidRecent: any[]; unpaid: any[] };
  staffDocs?: any[];
  /** staff.reminders().contracts: конец договора / испытательного срока */
  staffContracts?: any[];
  birthdays?: any[];
}

/**
 * Строки дайджеста: `adminLine` — сразу под рабочим днём, `sections` — блоки,
 * каждый уже со строкой-заголовком. Пустые разделы не выводятся.
 */
export const buildAttention = (input: AttentionInput): { adminLine: string | null; sections: string[][] } => {
  const sections: string[][] = [];

  const adminLine =
    input.admin === undefined
      ? null
      : input.admin
        ? `👩‍💼 Адміністратор сьогодні: <b>${esc(input.admin)}</b>`
        : '👩‍💼 Адміністратор сьогодні: <i>у графіку не вказано</i>';

  // ── Ke schválení: новые блоки, правки блоков, предложения по графику ──
  if (input.pending) {
    const rows = [];
    for (const b of input.pending.items || []) {
      const who = esc(b.employeeName || '—');
      if (b.kind === 'change') {
        const was = span(b.startMin, b.endMin);
        const next = span(b.proposedStartMin, b.proposedEndMin);
        const by = b.proposedByName ? ` · ${esc(b.proposedByName)}` : '';
        rows.push(`• ${dm(b.date)} <b>${who}</b> — зміна блоку${was && next ? ` ${was} → ${next}` : ''}${by}`);
      } else {
        const t = span(b.startMin, b.endMin);
        const title = b.title ? ` «${esc(b.title)}»` : '';
        const by = b.createdByName ? ` · ${esc(b.createdByName)}` : '';
        rows.push(`• ${dm(b.date)} <b>${who}</b> — блок${title}${t ? ` ${t}` : ''}${by}`);
      }
    }
    for (const r of input.pending.planRequests || []) {
      const label = r.label ? ` → ${esc(r.label)}` : '';
      const by = r.by ? ` · ${esc(r.by)}` : '';
      rows.push(`• ${dm(r.date)} <b>${esc(r.employeeName || '—')}</b> — графік${label}${by}`);
    }
    if (rows.length) sections.push([`⏳ <b>Чекає підтвердження (Ke schválení): ${rows.length}</b>`, ...capped(rows, more)]);
  }
  // ── Затраты: только число, без сумм и названий ──
  const costReq = Number(input.costRequests) || 0;
  if (costReq > 0) {
    const line = `• Витрати — запитів на зміну чи видалення: <b>${costReq}</b> (адмінка → Затраты)`;
    const ke = sections.find((sec) => sec[0].startsWith('⏳'));
    if (ke) ke.push(line);
    else sections.push(['⏳ <b>Чекає підтвердження (Ke schválení):</b>', line]);
  }

  // ── Ваучеры: оплачены за 7 дней и ещё не реализованы — проверить potvrzení ──
  if (input.vouchers) {
    const paid = input.vouchers.paidRecent || [];
    const unpaid = input.vouchers.unpaid || [];
    if (paid.length) {
      const rows = paid.map((v) => {
        const to = v.for ? ` → ${esc(v.for)}` : '';
        return `• <b>${esc(String(v.name || '').trim() || '—')}</b>${to} · ${kc(v.sum)} · оплачено ${dm(v.datePay)}${v.idVoucher ? ` · № ${esc(v.idVoucher)}` : ''}`;
      });
      const block = [`🎁 <b>Ваучери: оплачені за 7 днів — перевірте, що potvrzení надіслано (${paid.length})</b>`, ...capped(rows, more)];
      if (unpaid.length) block.push(`<i>Не оплачено замовлень за 30 днів: ${unpaid.length}</i>`);
      sections.push(block);
    } else if (unpaid.length) {
      sections.push([`🎁 <b>Ваучери:</b> не оплачено замовлень за 30 днів: ${unpaid.length}`]);
    }
  }

  // ── Документы и договоры сотрудников: срок ≤ 30 дней или истёк; испытательный ≤ 14 дней ──
  const docRows = (input.staffDocs || []).map((d) => {
    const n = Number(d.daysLeft);
    const when = n < 0 ? `прострочено ${days(-n)}` : n === 0 ? 'закінчується сьогодні' : `до ${dm(d.validUntil)} (через ${days(n)})`;
    return `• <b>${esc(d.name)}</b> — ${esc(d.title || d.kind)}: ${when}`;
  });
  const contractRows = (input.staffContracts || []).map((c) => {
    const n = Number(c.daysLeft);
    const type = CONTRACT_TYPE_LABEL[c.type] || esc(c.type);
    if (c.kind === 'probation_end') {
      return `• <b>${esc(c.name)}</b> — випробувальний термін (${type}): ${n === 0 ? 'закінчується сьогодні' : `до ${dm(c.date)} (через ${days(n)})`}`;
    }
    const when = n < 0 ? `закінчився ${dm(c.date)}, нового немає` : n === 0 ? 'закінчується сьогодні' : `до ${dm(c.date)} (через ${days(n)})`;
    return `• <b>${esc(c.name)}</b> — договір ${type}: ${when}`;
  });
  if (docRows.length || contractRows.length) {
    const title = contractRows.length ? '🪪 <b>Документи й договори співробітників — терміни:</b>' : '🪪 <b>Документи співробітників — терміни:</b>';
    sections.push([title, ...capped([...docRows, ...contractRows], more)]);
  }

  // ── Дни рождения: ближайшие BIRTHDAY_DAYS дней ──
  const bd = (input.birthdays || []).filter((b) => Number(b.daysLeft) >= 0 && Number(b.daysLeft) <= BIRTHDAY_DAYS);
  if (bd.length) {
    const rows = bd.map((b) => {
      const d = `${String(b.day).padStart(2, '0')}.${String(b.month).padStart(2, '0')}`;
      return Number(b.daysLeft) === 0 ? `• 🎉 <b>${esc(b.name)}</b> — сьогодні!` : `• <b>${esc(b.name)}</b> — ${d} (через ${days(Number(b.daysLeft))})`;
    });
    sections.push([`🎂 <b>Дні народження (${BIRTHDAY_DAYS} днів):</b>`, ...rows]);
  }

  return { adminLine, sections };
};
