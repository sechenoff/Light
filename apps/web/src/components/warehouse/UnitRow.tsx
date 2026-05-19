"use client";

/**
 * One scannable-less checklist row: equipment name + optional «прибор N из M»
 * ordinal, plus a segmented control of outcome buttons.
 *
 * Visual source of truth:
 *  - ISSUE: mockup `03-issue-and-desktop.html` block 2 `.row` / block 4 `.drow`
 *           — 2 segments: ✓ «выдано» (emerald when active) / ✗ «не выдаём»
 *           (slate when active). Default: nothing selected.
 *  - RETURN: mockup `01-return-checklist.html` `.seg` — 3 segments:
 *           ✓ «Принято» (emerald) / 🔧 «Ремонт» (amber) / ✗ «Проблема» (rose).
 *           Amber for Ремонт is the approved canon (option A in that mockup).
 *
 * NEVER renders a barcode (product rule: hidden barcode IDs). The row is
 * identified by human name + ordinal only. Pure & controlled — all state lives
 * with the parent; this component just renders `value` and emits `onChange`.
 *
 * Touch targets ≥ 40px (h-10). Emoji glyphs are decorative → aria-hidden;
 * each button carries a Russian aria-label that names the item + action.
 */

import type { ReturnOutcome } from "./types";

/** ISSUE outcome: marked issued, marked withheld, or untouched. */
export type IssueValue = "ISSUED" | "WITHHELD" | null;

interface SegmentDef<V> {
  /** The value this segment selects. */
  readonly value: V;
  /** Decorative glyph (aria-hidden). */
  readonly glyph: string;
  /** Visible label text. */
  readonly label: string;
  /** Active classes (canon tokens) when this segment is selected. */
  readonly activeClass: string;
  /** aria-label verb fragment, e.g. «отметить выданным». */
  readonly aria: string;
}

const ISSUE_SEGMENTS: readonly SegmentDef<Exclude<IssueValue, null>>[] = [
  {
    value: "ISSUED",
    glyph: "✓",
    label: "выдано",
    activeClass: "border-emerald bg-emerald text-white",
    aria: "отметить выданным",
  },
  {
    value: "WITHHELD",
    glyph: "✗",
    label: "не выдаём",
    activeClass: "border-slate bg-slate text-white",
    aria: "отметить «не выдаём»",
  },
];

const RETURN_SEGMENTS: readonly SegmentDef<ReturnOutcome>[] = [
  {
    value: "ACCEPTED",
    glyph: "✓",
    label: "Принято",
    activeClass: "border-emerald bg-emerald text-white",
    aria: "принять без замечаний",
  },
  {
    value: "REPAIR",
    glyph: "🔧",
    label: "Ремонт",
    activeClass: "border-amber bg-amber text-white",
    aria: "отправить в ремонт",
  },
  {
    value: "PROBLEM",
    glyph: "✗",
    label: "Проблема",
    activeClass: "border-rose bg-rose text-white",
    aria: "зарегистрировать проблему",
  },
];

type UnitRowProps =
  | {
      name: string;
      ordinalLabel?: string;
      mode: "ISSUE";
      value: IssueValue;
      onChange: (next: IssueValue) => void;
      disabled?: boolean;
    }
  | {
      name: string;
      ordinalLabel?: string;
      mode: "RETURN";
      value: ReturnOutcome | null;
      onChange: (next: ReturnOutcome) => void;
      disabled?: boolean;
    };

export function UnitRow(props: UnitRowProps) {
  const { name, ordinalLabel, mode, disabled = false } = props;

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-2 lg:px-3 lg:py-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] leading-tight text-ink">
          {name}
        </div>
        {ordinalLabel && (
          <div className="mt-0.5 truncate text-[11px] text-ink-3">
            {ordinalLabel}
          </div>
        )}
      </div>

      <div className="flex shrink-0 gap-1">
        {mode === "ISSUE"
          ? ISSUE_SEGMENTS.map((seg) => {
              const active = props.value === seg.value;
              return (
                <button
                  key={seg.value}
                  type="button"
                  disabled={disabled}
                  aria-pressed={active}
                  aria-label={`${name}${ordinalLabel ? ` (${ordinalLabel})` : ""} — ${seg.aria}`}
                  onClick={() =>
                    props.onChange(active ? null : seg.value)
                  }
                  className={`flex h-10 min-w-[40px] items-center justify-center gap-1 rounded px-2 text-[13px] font-medium transition-colors disabled:opacity-50 ${
                    active
                      ? seg.activeClass
                      : "border border-border bg-surface-muted text-ink-2 hover:bg-surface-subtle"
                  }`}
                >
                  <span aria-hidden="true">{seg.glyph}</span>
                  <span className="hidden sm:inline">{seg.label}</span>
                </button>
              );
            })
          : RETURN_SEGMENTS.map((seg) => {
              const active = props.value === seg.value;
              return (
                <button
                  key={seg.value}
                  type="button"
                  disabled={disabled}
                  aria-pressed={active}
                  aria-label={`${name}${ordinalLabel ? ` (${ordinalLabel})` : ""} — ${seg.aria}`}
                  onClick={() => props.onChange(seg.value)}
                  className={`flex h-10 min-w-[40px] items-center justify-center gap-1 rounded px-2 text-[13px] font-medium transition-colors disabled:opacity-50 ${
                    active
                      ? seg.activeClass
                      : "border border-border bg-surface-muted text-ink-2 hover:bg-surface-subtle"
                  }`}
                >
                  <span aria-hidden="true">{seg.glyph}</span>
                  <span className="hidden sm:inline">{seg.label}</span>
                </button>
              );
            })}
      </div>
    </div>
  );
}
