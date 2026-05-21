"use client";

/**
 * ISSUE result view — финальный экран после успешного `POST /complete`.
 *
 * Pure presentational: takes the `/complete` response + FE-authoritative
 * counts and renders the outcome (counts + info-block + optional failure
 * alert + «Готово»). NO checklist state, NO network — `IssueChecklist` owns
 * the POST and passes the result down.
 *
 * Mirrors `ReturnResultView`:
 *  - emerald header «Выдача оформлена» on zero failures;
 *  - amber «Выдача оформлена с замечаниями» on ANY failure (defensive — for
 *    ISSUE the backend doesn't produce failedBroken/failedProblem today, but
 *    the contract is shared with RETURN and we render it correctly if it
 *    ever does).
 *
 * Counts come from PROPS, not from `result.scannedCount`. Rationale: COUNT
 * lines never produce ScanRecords (no server-side unit ids), so
 * `scannedCount` counts only UNIT units — it would under-report «Выдано».
 * `IssueChecklist` computes the authoritative `|issuedUnits|+|issuedCountLines|`
 * and passes it as `issuedCount`.
 *
 * NEVER renders a barcode.
 */

import type { CompleteResult } from "./types";
import { pluralize } from "../../lib/format";

export function IssueResultView({
  result,
  projectName,
  issuedCount,
  addonsCount,
  substitutedCount,
  onDone,
}: {
  result: CompleteResult;
  projectName: string;
  /** UNIT units marked ✓ + COUNT lines marked ✓ — FE truth from IssueChecklist. */
  issuedCount: number;
  /** Number of bookingItems with `isExtra=true`. */
  addonsCount: number;
  /** `result.substitutedItems.length`, lifted into a prop for symmetry. */
  substitutedCount: number;
  /** Back to the bookings list. */
  onDone: () => void;
}) {
  const safeIssued = Math.max(
    0,
    Number.isFinite(issuedCount) ? issuedCount : 0,
  );

  const failedBroken = result.failedBrokenUnits ?? [];
  const failedProblem = result.failedProblemUnits ?? [];
  const failedTotal = failedBroken.length + failedProblem.length;
  const hasFailures = failedTotal > 0;

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <div className="flex-1 px-3 pb-6 pt-5 lg:px-5">
        <div className="mx-auto w-full max-w-[460px]">
          {hasFailures ? (
            <div className="rounded-lg border border-amber-border bg-amber-soft px-4 py-4 text-center">
              <p className="text-3xl leading-none" aria-hidden="true">
                ⚠
              </p>
              <h2 className="mt-2 text-[17px] font-semibold text-ink">
                Выдача оформлена с замечаниями
              </h2>
              <p className="mt-1 text-[13px] text-ink-2">
                {projectName || "Бронь"}
              </p>
            </div>
          ) : (
            <div className="rounded-lg border border-emerald-border bg-emerald-soft px-4 py-4 text-center">
              <p className="text-3xl leading-none" aria-hidden="true">
                ✓
              </p>
              <h2 className="mt-2 text-[17px] font-semibold text-ink">
                Выдача оформлена
              </h2>
              <p className="mt-1 text-[13px] text-ink-2">
                {projectName || "Бронь"}
              </p>
            </div>
          )}

          <dl className="mt-3 space-y-1.5">
            <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2.5">
              <dt className="text-[13px] text-ink-2">Выдано</dt>
              <dd className="mono-num text-[15px] font-semibold text-emerald">
                {safeIssued}
              </dd>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2.5">
              <dt className="text-[13px] text-ink-2">
                Добавлено доборов
              </dt>
              <dd className="mono-num text-[15px] font-semibold text-ink">
                {addonsCount}
              </dd>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2.5">
              <dt className="text-[13px] text-ink-2">
                Замены (другая единица)
              </dt>
              <dd className="mono-num text-[15px] font-semibold text-ink">
                {substitutedCount}
              </dd>
            </div>
          </dl>

          <div className="mt-3 rounded-lg border border-accent-soft bg-accent-soft/50 px-3 py-2.5 text-[12px] leading-snug text-ink-2">
            Бронь переведена в «Выдана» — появится в списке для приёмки.
          </div>

          {hasFailures && (
            <div
              role="alert"
              className="mt-3 rounded-lg border border-rose-border bg-rose-soft px-3 py-3"
            >
              <p className="text-[13px] font-semibold text-rose">
                Не удалось обработать {failedTotal}{" "}
                {pluralize(failedTotal, "единицу", "единицы", "единиц")} —
                проверьте вручную, ничего не потеряно
              </p>

              {failedBroken.length > 0 && (
                <>
                  <p className="mt-2 text-[12px] font-medium text-rose">
                    Не удалось обработать ремонт:
                  </p>
                  <ul className="mt-1 space-y-1">
                    {failedBroken.map((f) => (
                      <li
                        key={f.unitId}
                        className="text-[12px] leading-snug text-rose"
                      >
                        • {f.reason}: {f.error}
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {failedProblem.length > 0 && (
                <>
                  <p className="mt-2 text-[12px] font-medium text-rose">
                    Не удалось завести в «Потеряшки»:
                  </p>
                  <ul className="mt-1 space-y-1">
                    {failedProblem.map((f) => (
                      <li
                        key={f.equipmentUnitId}
                        className="text-[12px] leading-snug text-rose"
                      >
                        • {f.equipmentUnitId}: {f.reason}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="sticky bottom-0 border-t border-border bg-surface px-3 py-3 lg:px-5">
        <button
          type="button"
          onClick={onDone}
          aria-label="Готово — вернуться к списку броней"
          className="block w-full rounded-lg bg-accent px-4 py-3 text-center text-sm font-semibold text-white transition-colors hover:opacity-95"
        >
          Готово
        </button>
      </div>
    </div>
  );
}
