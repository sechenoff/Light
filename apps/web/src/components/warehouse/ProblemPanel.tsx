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
 * `expectedBackDate` is a bare calendar date string (YYYY-MM-DD) or null — it
 * is the raw value of a controlled `<input type="date">`. It is null unless
 * the reason is LEFT_ON_SITE; switching the reason away from LEFT_ON_SITE
 * clears it (we emit `onExpectedBackDateChange(null)`).
 *
 * ⚠ WIRE-FORMAT TRAP — this is NOT what `POST /complete` accepts. The backend
 * Zod for `problemUnits[].expectedBackDate` is `z.string().datetime()` (full
 * ISO-8601 datetime, see `apps/api/src/routes/warehouse.ts`). A bare
 * YYYY-MM-DD fails that schema → 400. This panel does NOT POST; the consumer
 * (ReturnChecklist, Task 7.2) OWNS the conversion and MUST upgrade the value
 * to an ISO datetime before sending, e.g.:
 *   `new Date(d + "T00:00:00.000Z").toISOString()`.
 * The emitted format is intentionally left as YYYY-MM-DD here: a controlled
 * date input legitimately yields that, and centralising the conversion in the
 * POST owner avoids every consumer re-deriving it.
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

/**
 * Что реально произойдёт с единицей — зеркалит бэкенд-маппинг в
 * `problemItemService.createProblemItem`: LEFT_ON_SITE → EXPECTED (ожидаем
 * возврат), LOST/STOLEN → SEARCHING (заявка на поиск), DESTROYED → сразу
 * WROTE_OFF + unit RETIRED (списание, без поиска). Единая подпись «заявка на
 * поиск» для всех причин вводила оператора в заблуждение.
 */
const REASON_CONSEQUENCE: Record<ProblemReason, string> = {
  LEFT_ON_SITE: "→ в «Потеряшки» · ожидается возврат",
  LOST: "→ в «Потеряшки» · заявка на поиск",
  STOLEN: "→ в «Потеряшки» · заявка на поиск",
  DESTROYED: "→ списание единицы (без поиска)",
};

export function ProblemPanel({
  reason,
  onReasonChange,
  comment,
  onCommentChange,
  expectedBackDate,
  onExpectedBackDateChange,
  disabled = false,
  fieldIdPrefix = "problem",
}: {
  reason: ProblemReason | null;
  onReasonChange: (r: ProblemReason) => void;
  comment: string;
  onCommentChange: (s: string) => void;
  /**
   * Bare calendar date `YYYY-MM-DD` (raw `<input type="date">` value) or null.
   * Only meaningful for LEFT_ON_SITE.
   *
   * ⚠ NOT a wire-ready value: `POST /complete` expects ISO-8601 datetime
   * (backend Zod `z.string().datetime()`). The consumer (ReturnChecklist,
   * Task 7.2) MUST convert before POST — see this file's header note.
   */
  expectedBackDate: string | null;
  /** Receives `YYYY-MM-DD` (or null on clear). NOT ISO datetime — see above. */
  onExpectedBackDateChange: (date: string | null) => void;
  disabled?: boolean;
  /**
   * Префикс DOM-id полей (`{prefix}-comment`, `{prefix}-expected-back`).
   * На приёмке рендерится по одной панели на каждую проблемную единицу —
   * без уникального префикса id дублируются (невалидный DOM, label/`for`
   * попадает не в то поле). Передавайте unitId.
   */
  fieldIdPrefix?: string;
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
            htmlFor={`${fieldIdPrefix}-expected-back`}
            className="text-[12px] text-rose"
          >
            Ожидается к:
          </label>
          {/* NOTE: a controlled <input type="date"> yields a bare
              `YYYY-MM-DD` string — we emit it verbatim. The backend
              `POST /complete` Zod requires full ISO-8601 datetime
              (`z.string().datetime()`), so the consumer (ReturnChecklist,
              Task 7.2) MUST convert before POST, e.g.
              `new Date(d + "T00:00:00.000Z").toISOString()`, or the API 400s.
              Conversion is intentionally NOT done here (see file header). */}
          <input
            id={`${fieldIdPrefix}-expected-back`}
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

      <label className="sr-only" htmlFor={`${fieldIdPrefix}-comment`}>
        Комментарий (обязательно)
      </label>
      <textarea
        id={`${fieldIdPrefix}-comment`}
        rows={2}
        value={comment}
        disabled={disabled}
        onChange={(e) => onCommentChange(e.target.value)}
        placeholder="Комментарий (обязательно)"
        aria-label="Комментарий к проблеме (обязательно)"
        className="mt-2.5 block w-full resize-none rounded-md border border-rose-border bg-surface px-2.5 py-2 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-rose disabled:opacity-50"
      />

      <p className="mt-2 text-[11px] leading-snug text-rose">
        {reason ? REASON_CONSEQUENCE[reason] : "→ в список «Потеряшки»"}
      </p>
    </div>
  );
}
