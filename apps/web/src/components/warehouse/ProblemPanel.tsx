"use client";

/**
 * ProblemPanel — the RED «✗ Проблема» expanded panel inside a RETURN row.
 *
 * Visual source of truth: docs/mockups/warehouse-scan/02-problem-reasons.html
 * `.panel` (and `.row.exp-prob` in 01-return-checklist.html) — a rose-tinted
 * block containing:
 *  - 4 single-select reason chips with emoji + Russian labels:
 *      📍 Остался на площадке · 🤷 Потерян · 💥 Уничтожен · 🚨 Украден
 *    (active = filled rose, inactive = rose outline),
 *  - a required comment <textarea> («Комментарий (обязательно)»),
 *  - an «ожидается к дате» <input type="date"> shown ONLY when the selected
 *    reason is «Остался на площадке» (LEFT_ON_SITE),
 *  - the sub-note «→ в список «Потеряшки» · заявка на поиск».
 *
 * CONTROLLED & pure (NO DB calls): the parent (ReturnChecklist, Task 7.2) owns
 * `reason` / `comment` / `expectedBackDate` so it can validate "comment
 * required per flagged row" before POSTing /complete. The panel never touches
 * the network.
 *
 * `expectedBackDate` is an ISO date string (YYYY-MM-DD) or null. It is null
 * unless the reason is LEFT_ON_SITE; switching the reason away from
 * LEFT_ON_SITE clears it (we emit `onExpectedBackDateChange(null)`).
 *
 * Never renders a barcode (product rule: hidden barcode IDs). Real
 * <button>/<textarea>/<input> semantics; Russian aria-labels; emoji
 * aria-hidden; touch targets ≥ 40px. Semantic canon tokens only.
 */

import type { ProblemReason } from "./types";

interface ReasonChipDef {
  readonly value: ProblemReason;
  /** Decorative glyph (aria-hidden). */
  readonly glyph: string;
  /** Visible Russian label. */
  readonly label: string;
}

/** Order + labels are the approved canon (mockup 02, option A — 4 reasons). */
const REASON_CHIPS: readonly ReasonChipDef[] = [
  { value: "LEFT_ON_SITE", glyph: "📍", label: "Остался на площадке" },
  { value: "LOST", glyph: "🤷", label: "Потерян" },
  { value: "DESTROYED", glyph: "💥", label: "Уничтожен" },
  { value: "STOLEN", glyph: "🚨", label: "Украден" },
];

export function ProblemPanel({
  reason,
  onReasonChange,
  comment,
  onCommentChange,
  expectedBackDate,
  onExpectedBackDateChange,
  disabled = false,
}: {
  reason: ProblemReason | null;
  onReasonChange: (r: ProblemReason) => void;
  comment: string;
  onCommentChange: (s: string) => void;
  /** ISO date string (YYYY-MM-DD) or null. Only meaningful for LEFT_ON_SITE. */
  expectedBackDate: string | null;
  onExpectedBackDateChange: (iso: string | null) => void;
  disabled?: boolean;
}) {
  function selectReason(next: ProblemReason) {
    // Switching away from «Остался на площадке» clears the date — the field
    // is only meaningful for LEFT_ON_SITE (mockup 02 map).
    if (next !== "LEFT_ON_SITE" && expectedBackDate !== null) {
      onExpectedBackDateChange(null);
    }
    onReasonChange(next);
  }

  return (
    <div
      className="rounded-lg border border-rose-border bg-rose-soft px-3 py-3"
      aria-label="Проблема — причина и комментарий"
    >
      <div
        role="radiogroup"
        aria-label="Причина проблемы"
        className="flex flex-wrap gap-1.5"
      >
        {REASON_CHIPS.map((chip) => {
          const active = reason === chip.value;
          return (
            <button
              key={chip.value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => selectReason(chip.value)}
              aria-label={`Причина: ${chip.label}`}
              className={`flex h-10 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                active
                  ? "border border-rose bg-rose text-white"
                  : "border border-rose bg-surface text-rose hover:bg-rose-soft"
              }`}
            >
              <span aria-hidden="true">{chip.glyph}</span>
              <span>{chip.label}</span>
            </button>
          );
        })}
      </div>

      {reason === "LEFT_ON_SITE" && (
        <div className="mt-2.5 flex items-center gap-2">
          <label
            htmlFor="problem-expected-back"
            className="text-[12px] text-rose"
          >
            Ожидается к:
          </label>
          <input
            id="problem-expected-back"
            type="date"
            value={expectedBackDate ?? ""}
            disabled={disabled}
            onChange={(e) =>
              onExpectedBackDateChange(
                e.target.value === "" ? null : e.target.value,
              )
            }
            aria-label="Ожидается к дате (только для «Остался на площадке»)"
            className="h-10 rounded-md border border-rose-border bg-surface px-2.5 text-[12px] text-ink outline-none focus:border-rose disabled:opacity-50"
          />
        </div>
      )}

      <label className="sr-only" htmlFor="problem-comment">
        Комментарий (обязательно)
      </label>
      <textarea
        id="problem-comment"
        rows={2}
        value={comment}
        disabled={disabled}
        onChange={(e) => onCommentChange(e.target.value)}
        placeholder="Комментарий (обязательно)"
        aria-label="Комментарий к проблеме (обязательно)"
        className="mt-2.5 block w-full resize-none rounded-md border border-rose-border bg-surface px-2.5 py-2 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-rose disabled:opacity-50"
      />

      <p className="mt-2 text-[11px] leading-snug text-rose">
        → в список «Потеряшки» · заявка на поиск
      </p>
    </div>
  );
}
