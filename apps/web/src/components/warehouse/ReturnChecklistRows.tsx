"use client";

/**
 * Строки чек-листа приёмки — одна позиция брони.
 *
 *  - UNIT (штучный учёт): по строке на каждый экземпляр — `UnitRow` с тремя
 *    исходами и раскрывающиеся `RepairPanel` / `ProblemPanel`.
 *  - COUNT (учёт количеством, весь прод): сетка ячеек `UnitGridRow`.
 *
 * Чистая раскладка: состояние исходов и обработчики держит `ReturnChecklist`.
 * Каждая строка регистрирует свой DOM-узел в `registerRow`, чтобы при ошибке
 * валидации экран прокрутил к первой проблемной строке. Штрихкодов нет —
 * только название и «прибор N из M».
 */

import { UnitRow } from "./UnitRow";
import { RepairPanel } from "./RepairPanel";
import { ProblemPanel } from "./ProblemPanel";
import { UnitGridRow, type UnitSlot } from "./UnitGridRow";
import type { ChecklistItem, ProblemDraft, ReturnOutcome } from "./types";
import type { OutcomeMap } from "./returnChecklistDraft";

/** id `<p>` с ошибкой строки — на него ссылается `aria-describedby`. */
export function rowErrorId(rowId: string): string {
  return `return-row-error-${rowId}`;
}

export interface ReturnRowHandlers {
  setUnitOutcome: (unitId: string, next: ReturnOutcome) => void;
  setRepairComment: (unitId: string, comment: string) => void;
  patchProblem: (unitId: string, patch: Partial<ProblemDraft>) => void;
  cycleSlot: (bookingItemId: string, index: number, qty: number) => void;
  acceptRow: (bookingItemId: string, qty: number) => void;
  setSlotRepairComment: (bookingItemId: string, index: number, comment: string, qty: number) => void;
  patchSlotProblem: (
    bookingItemId: string,
    index: number,
    patch: Partial<ProblemDraft>,
    qty: number,
  ) => void;
}

function RowError({ id, message }: { id: string; message: string }) {
  return (
    <p
      id={id}
      role="alert"
      className="rounded-md border border-rose-border bg-rose-soft px-2.5 py-1.5 text-[12px] text-rose"
    >
      {message}
    </p>
  );
}

export function ReturnItemRows({
  item,
  sessionId,
  outcomes,
  slots,
  rowErrors,
  resetNotice,
  disabled,
  handlers,
  registerRow,
}: {
  item: ChecklistItem;
  sessionId: string;
  outcomes: OutcomeMap;
  /** Сетка COUNT-строки (для UNIT не используется). */
  slots: UnitSlot[];
  rowErrors: Readonly<Record<string, string>>;
  /** Жёлтая пометка COUNT-строки, например «отметки сброшены». */
  resetNotice: string | null;
  disabled: boolean;
  handlers: ReturnRowHandlers;
  registerRow: (rowId: string, node: HTMLDivElement | null) => void;
}) {
  if (item.trackingMode === "UNIT" && item.units) {
    const total = item.units.length;
    return (
      <>
        {item.units.map((u, idx) => {
          const o = outcomes[u.unitId];
          const rowError = rowErrors[u.unitId];
          const errId = rowErrorId(u.unitId);
          return (
            <div
              key={u.unitId}
              ref={(node) => registerRow(u.unitId, node)}
              tabIndex={-1}
              aria-invalid={rowError ? true : undefined}
              aria-describedby={rowError ? errId : undefined}
              className="space-y-1.5 outline-none"
            >
              <UnitRow
                name={item.equipmentName}
                ordinalLabel={`прибор ${idx + 1} из ${total}`}
                mode="RETURN"
                value={o?.outcome ?? null}
                onChange={(next) => handlers.setUnitOutcome(u.unitId, next)}
                disabled={disabled}
              />

              {o?.outcome === "REPAIR" && (
                <RepairPanel
                  sessionId={sessionId}
                  unitId={u.unitId}
                  comment={o.repairComment ?? ""}
                  onCommentChange={(s) => handlers.setRepairComment(u.unitId, s)}
                  disabled={disabled}
                />
              )}

              {o?.outcome === "PROBLEM" && (
                <ProblemPanel
                  reason={o.problem?.reason ?? null}
                  onReasonChange={(r) => handlers.patchProblem(u.unitId, { reason: r })}
                  comment={o.problem?.comment ?? ""}
                  onCommentChange={(s) => handlers.patchProblem(u.unitId, { comment: s })}
                  expectedBackDate={o.problem?.expectedBackDate ?? null}
                  onExpectedBackDateChange={(d) =>
                    handlers.patchProblem(u.unitId, { expectedBackDate: d })
                  }
                  disabled={disabled}
                  fieldIdPrefix={`problem-${u.unitId}`}
                />
              )}

              {rowError && <RowError id={errId} message={rowError} />}
            </div>
          );
        })}
      </>
    );
  }

  // COUNT — сетка ячеек: принято / ремонт / проблема по каждому прибору.
  const biId = item.bookingItemId;
  const qty = item.quantity;
  const rowError = rowErrors[biId];
  const errId = rowErrorId(biId);
  return (
    <div
      ref={(node) => registerRow(biId, node)}
      tabIndex={-1}
      aria-invalid={rowError ? true : undefined}
      aria-describedby={rowError ? errId : undefined}
      className="space-y-1.5 outline-none"
    >
      <UnitGridRow
        name={item.equipmentName}
        totalQty={qty}
        units={slots}
        disabled={disabled}
        onCycle={(index) => handlers.cycleSlot(biId, index, qty)}
        onAcceptAll={() => handlers.acceptRow(biId, qty)}
        onRepairCommentChange={(index, comment) =>
          handlers.setSlotRepairComment(biId, index, comment, qty)
        }
        onProblemPatch={(index, patch) => handlers.patchSlotProblem(biId, index, patch, qty)}
        rowError={rowError ?? null}
        rowErrorId={errId}
        notice={resetNotice}
      />
    </div>
  );
}
