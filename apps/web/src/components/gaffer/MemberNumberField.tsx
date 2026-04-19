"use client";

import type { ChangeEvent } from "react";

/**
 * Controlled numeric input used in the "Смены участников" block on the gaffer
 * project wizard (/gaffer/projects/new и /gaffer/projects/[id]).
 *
 * Key behaviour: when the underlying value is 0 the field is shown EMPTY, not
 * as "0". On submit the parent filters members with `shifts === 0 || hours === 0`,
 * so 0 is effectively a "not entered yet" marker — displaying it as "" lets the
 * user clear the field with Backspace without the cursor ending up in front of a
 * stuck "0".
 */
export type MemberNumberFieldProps = {
  label: string;
  value: number;
  onChange: (next: number) => void;
  /** Test hook */
  ariaLabel?: string;
};

export function MemberNumberField({
  label,
  value,
  onChange,
  ariaLabel,
}: MemberNumberFieldProps) {
  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value;
    if (raw === "") {
      onChange(0);
      return;
    }
    const n = Number(raw);
    // Guard against NaN (e.g. partial typing like "1e" in some browsers).
    // Parent treats 0 as "not entered" — safer to fall back there than propagate NaN.
    const next = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    onChange(next);
  }

  return (
    <label className="text-[11.5px] text-ink-2">
      {label}
      <input
        type="number"
        min={0}
        step={1}
        inputMode="numeric"
        value={value === 0 ? "" : value}
        onChange={handleChange}
        aria-label={ariaLabel ?? label}
        className="block w-full mt-0.5 px-2 py-1 border border-border rounded text-[13px] bg-surface text-ink mono-num focus:ring-2 focus:ring-accent-border"
      />
    </label>
  );
}
