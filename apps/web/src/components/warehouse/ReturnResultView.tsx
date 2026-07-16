"use client";

/**
 * RETURN result view — the post-«приёмка» canon screen.
 *
 * Pure presentational: takes the `/complete` response and renders the
 * outcome (counts + a partial-failure block + «Готово»). NO checklist state,
 * NO network — `ReturnChecklist` owns the POST and passes the result down.
 *
 * Contract fidelity (the whole point of this view): the backend
 * (`warehouseScan.ts`) returns TWO differently-shaped failure arrays —
 *  - `failedBrokenUnits: { unitId; reason; error }[]`   (reason = repair note)
 *  - `failedProblemUnits: { equipmentUnitId; reason }[]` (reason = the error)
 * They are rendered against their REAL shapes so no `undefined` can leak and
 * the operator always sees which unit failed and why («ничего не потеряно»).
 *
 * Header: emerald «завершена» ONLY when zero failures. Any failure demotes it
 * to an amber attention variant «завершена с замечаниями» — a partial failure
 * must never read as a clean walk-away success.
 *
 * Counts (props, NOT derived here): the displayed «Принято» is the count of
 * units the operator actually marked ✓ (+ accepted COUNT lines), computed by
 * `ReturnChecklist` from its authoritative outcome map. It is NOT
 * `result.scannedCount − repair − problem`: backend `scannedCount` only counts
 * ScanRecords, which in the RETURN flow exist ONLY for ACCEPTED units
 * (REPAIR/PROBLEM are never check()'d) — so subtracting repair/problem from it
 * would double-count and under-report «Принято». «На ремонт» / «В Потеряшки»
 * are the cards/requests the backend actually CREATED
 * (`createdRepairIds` / `createdProblemItemIds`) — distinct from "flagged".
 *
 * NEVER renders a barcode.
 */

import type { CompleteResult } from "./types";
import { pluralize } from "../../lib/format";

export function ReturnResultView({
  result,
  projectName,
  acceptedCount,
  unitNames,
  onDone,
}: {
  result: CompleteResult;
  projectName: string;
  /**
   * Units the operator marked ✓ (+ accepted COUNT lines) — the frontend
   * outcome truth from `ReturnChecklist`. Clamped ≥0 defensively here too.
   */
  acceptedCount: number;
  /**
   * unitId → человекочитаемое имя единицы. Failed-массивы бэкенда несут
   * только id — сырые id оператору не показываем (правило «без id в UX»),
   * фолбэк «Единица оборудования».
   */
  unitNames?: ReadonlyMap<string, string>;
  /** Back to the bookings list. */
  onDone: () => void;
}) {
  function unitName(id: string): string {
    return unitNames?.get(id) ?? "Единица оборудования";
  }
  const repairCount = result.createdRepairIds?.length ?? 0;
  const problemCount = result.createdProblemItemIds?.length ?? 0;
  const safeAccepted = Math.max(
    0,
    Number.isFinite(acceptedCount) ? acceptedCount : 0,
  );

  const failedBroken = result.failedBrokenUnits ?? [];
  const failedProblem = result.failedProblemUnits ?? [];
  const failedTotal = failedBroken.length + failedProblem.length;
  const hasFailures = failedTotal > 0;

  // ws-1: единицы, которые не отсканированы и не помечены (ремонт/проблема) —
  // «не приняты». Backend перевёл их в MISSING; показываем оператору, чтобы
  // частичный возврат не читался как чистый успех.
  const missingItems = result.missingItems ?? [];
  const missingCount = missingItems.length;
  const hasMissing = missingCount > 0;
  const needsAttention = hasFailures || hasMissing;

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <div className="flex-1 px-3 pb-6 pt-5 lg:px-5">
        <div className="mx-auto w-full max-w-[460px]">
          {/* Header — emerald only on a clean run; amber attention on any
              failure so a partial result never reads as a walk-away success. */}
          {needsAttention ? (
            <div className="rounded-lg border border-amber-border bg-amber-soft px-4 py-4 text-center">
              <p className="text-3xl leading-none" aria-hidden="true">
                ⚠
              </p>
              <h2 className="mt-2 text-[17px] font-semibold text-ink">
                Приёмка завершена с замечаниями
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
                Приёмка завершена
              </h2>
              <p className="mt-1 text-[13px] text-ink-2">
                {projectName || "Бронь"}
              </p>
            </div>
          )}

          <dl className="mt-3 space-y-1.5">
            <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2.5">
              <dt className="text-[13px] text-ink-2">Принято</dt>
              <dd className="mono-num text-[15px] font-semibold text-emerald">
                {safeAccepted}
              </dd>
            </div>
            {/* Distinct concepts: the VALUE is the count of cards/requests
                the backend actually created (createdRepairIds /
                createdProblemItemIds). We don't have a separate "flagged"
                count post-POST, so we show the one meaningful number with an
                unambiguous label — never the same number printed twice. */}
            <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2.5">
              <dt className="text-[13px] text-ink-2">
                На ремонт — создано{" "}
                {pluralize(
                  repairCount,
                  "карточка",
                  "карточки",
                  "карточек",
                )}
              </dt>
              <dd className="mono-num text-[15px] font-semibold text-amber">
                {repairCount}
              </dd>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2.5">
              <dt className="text-[13px] text-ink-2">
                В «Потеряшки» — создано{" "}
                {pluralize(problemCount, "заявка", "заявки", "заявок")}
              </dt>
              <dd className="mono-num text-[15px] font-semibold text-rose">
                {problemCount}
              </dd>
            </div>
            {hasMissing && (
              <div className="flex items-center justify-between rounded-lg border border-rose-border bg-rose-soft px-3 py-2.5">
                <dt className="text-[13px] font-medium text-rose">
                  Не принято — осталось у клиента / не отсканировано
                </dt>
                <dd className="mono-num text-[15px] font-semibold text-rose">
                  {missingCount}
                </dd>
              </div>
            )}
          </dl>

          {hasMissing && (
            <div className="mt-3 rounded-lg border border-rose-border bg-rose-soft px-3 py-3">
              <p className="text-[13px] font-semibold text-rose">
                {pluralize(missingCount, "Единица", "Единицы", "Единиц")}{" "}
                не {pluralize(missingCount, "принята", "приняты", "приняты")} — помечены как «не на складе» (MISSING)
              </p>
              <ul className="mt-2 space-y-1">
                {missingItems.map((u) => (
                  <li key={u.id} className="text-[12px] leading-snug text-rose">
                    • {u.name}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] leading-snug text-ink-3">
                Если единицы найдутся — верните им статус «На складе» в управлении единицами.
              </p>
            </div>
          )}

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
                    Не удалось создать ремонт:
                  </p>
                  <ul className="mt-1 space-y-1">
                    {failedBroken.map((f) => (
                      <li
                        key={f.unitId}
                        className="text-[12px] leading-snug text-rose"
                      >
                        • {unitName(f.unitId)} — {f.error}
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
                        • {unitName(f.equipmentUnitId)} — {f.reason}
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
