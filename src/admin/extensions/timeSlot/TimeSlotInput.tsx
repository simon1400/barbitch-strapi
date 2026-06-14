import * as React from 'react';
import { useIntl } from 'react-intl';
import { Field, SingleSelect, SingleSelectOption } from '@strapi/design-system';

/**
 * Input for the `global::time-slot` custom field — a trimmed time dropdown used by
 * work-time `startTime` / `endTime`. Native Strapi can't trim a `time` picker and rejects
 * enum values that start with a digit ("08:00"), so this renders a plain SingleSelect of
 * the allowed slots and stores a clean "HH:MM" string.
 *
 * Range / step is shared with the migration (backup/migrate_work_time.mjs) and the DB:
 * 08:00..21:00, every 30 min. To change it, update TIME_OPTIONS here AND re-migrate.
 */

const buildOptions = (): string[] => {
  const out: string[] = [];
  for (let m = 8 * 60; m <= 21 * 60; m += 30) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
  return out;
};

export const TIME_OPTIONS = buildOptions();

const TimeSlotInput = React.forwardRef<HTMLButtonElement, any>((props, ref) => {
  const {
    attribute,
    disabled,
    intlLabel,
    label,
    name,
    onChange,
    required,
    value,
    error,
    hint,
    labelAction,
  } = props;
  const { formatMessage } = useIntl();

  const handleChange = (val: string | number) => {
    onChange({
      target: { name, type: attribute?.type ?? 'string', value: val ? String(val) : '' },
    });
  };

  const fieldLabel = label ?? (intlLabel ? formatMessage(intlLabel) : name);
  const fieldError =
    typeof error === 'string' ? error : error?.id ? formatMessage(error) : undefined;

  return (
    <Field.Root name={name} id={name} error={fieldError} hint={hint} required={required}>
      <Field.Label action={labelAction}>{fieldLabel}</Field.Label>
      <SingleSelect
        ref={ref}
        onChange={handleChange}
        value={value ?? ''}
        disabled={disabled}
        placeholder="—"
      >
        {TIME_OPTIONS.map((t) => (
          <SingleSelectOption key={t} value={t}>
            {t}
          </SingleSelectOption>
        ))}
      </SingleSelect>
      <Field.Hint />
      <Field.Error />
    </Field.Root>
  );
});

export default TimeSlotInput;
