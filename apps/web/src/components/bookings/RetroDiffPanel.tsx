"use client";

/**
 * Live-сводка изменений в retro-edit режиме. Рендерится в правой колонке
 * страницы /bookings/:id когда retroEditMode === true.
 *
 * Подход — простой и быстрый: считаем diff из текущего retroEdits state vs
 * исходный booking, без обращения к серверу. Финальную сумму не предсказываем
 * (это требует quoteEstimate на backend) — пишем «после сохранения смета
 * пересчитается». Это даёт оператору ясность что именно меняется, без
 * латентности dryRun-запроса.
 */

import type { ReactNode } from "react";

interface DiffItemRow {
  id: string;
  /** Display name машины/проекта/etc */
  label: string;
  /** Описание изменения, рендерится курсивом-сером */
  detail?: string;
  /** rose | amber | emerald — для дельта-цвета */
  tone?: "rose" | "amber" | "emerald";
}

interface Props {
  /** Поля брони (исходное состояние + правки) */
  originalProjectName: string;
  editedProjectName?: string;
  originalComment: string;
  editedComment: string;
  originalDiscountPercent: number | null;
  editedDiscountPercent: number | null;

  /** Итог-override (manualFinalAmount). null/"" = автомат, число = override */
  originalManualFinalAmount: string | null;
  editedManualFinalAmount: string;
  /** Автоматически вычисленный итог (для подсказки «вернётся к авто») */
  autoFinalAmount: string;

  /** Items diff — массивы со своими отметками _added/_deleted/changedQty */
  itemsAdded: number;
  itemsRemoved: number;
  itemsQtyChanged: number;

  /** Транспорт — кол-во машин с изменёнными полями */
  vehiclesDriverChanged: number;
  vehiclesMileageChanged: number;
}

function formatRu(n: number): string {
  return n.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
}

function trim(s: string | null | undefined): string {
  return (s ?? "").trim();
}

export function RetroDiffPanel({
  originalProjectName,
  editedProjectName,
  originalComment,
  editedComment,
  originalDiscountPercent,
  editedDiscountPercent,
  originalManualFinalAmount,
  editedManualFinalAmount,
  autoFinalAmount,
  itemsAdded,
  itemsRemoved,
  itemsQtyChanged,
  vehiclesDriverChanged,
  vehiclesMileageChanged,
}: Props): ReactNode {
  const rows: DiffItemRow[] = [];

  if (
    editedProjectName !== undefined &&
    trim(editedProjectName) !== trim(originalProjectName)
  ) {
    rows.push({
      id: "projectName",
      label: "Название проекта",
      detail: `${trim(originalProjectName) || "—"} → ${trim(editedProjectName) || "—"}`,
      tone: "amber",
    });
  }

  if (trim(editedComment) !== trim(originalComment)) {
    rows.push({
      id: "comment",
      label: "Комментарий",
      detail:
        trim(editedComment) === ""
          ? "удалён"
          : trim(originalComment) === ""
            ? "добавлен"
            : "изменён",
      tone: "amber",
    });
  }

  const oldDisc = originalDiscountPercent ?? null;
  const newDisc = editedDiscountPercent ?? null;
  if (oldDisc !== newDisc) {
    rows.push({
      id: "discount",
      label: "Скидка",
      detail: `${oldDisc ?? 0}% → ${newDisc ?? 0}%`,
      tone: "amber",
    });
  }

  // manualFinalAmount diff: пустая edited-строка = clear override.
  const editedOverrideRaw = editedManualFinalAmount.trim();
  const origOverride = originalManualFinalAmount ?? "";
  if (editedOverrideRaw !== origOverride) {
    let detail: string;
    if (editedOverrideRaw === "") {
      // Сброс override → возврат к автомату
      const orig = origOverride === "" ? "—" : `${formatRu(Number(origOverride))} ₽`;
      detail = `${orig} → авто (${formatRu(Number(autoFinalAmount))} ₽)`;
    } else {
      const newN = Number.parseFloat(editedOverrideRaw.replace(",", "."));
      const orig = origOverride === ""
        ? `авто (${formatRu(Number(autoFinalAmount))} ₽)`
        : `${formatRu(Number(origOverride))} ₽`;
      const newFmt = Number.isFinite(newN) ? `${formatRu(newN)} ₽` : editedOverrideRaw;
      detail = `${orig} → ${newFmt}`;
    }
    rows.push({
      id: "manual-final",
      label: editedOverrideRaw === "" ? "Сброс ручного итога" : "Итог брони (ручной)",
      detail,
      tone: "amber",
    });
  }

  if (itemsQtyChanged > 0) {
    rows.push({
      id: "items-qty",
      label: `Изменено количество: ${itemsQtyChanged}`,
      detail: itemsQtyChanged === 1 ? "позиция" : itemsQtyChanged < 5 ? "позиции" : "позиций",
      tone: "amber",
    });
  }
  if (itemsAdded > 0) {
    rows.push({
      id: "items-added",
      label: `Добавлено: ${itemsAdded}`,
      detail: itemsAdded === 1 ? "позиция" : itemsAdded < 5 ? "позиции" : "позиций",
      tone: "emerald",
    });
  }
  if (itemsRemoved > 0) {
    rows.push({
      id: "items-removed",
      label: `К удалению: ${itemsRemoved}`,
      detail: itemsRemoved === 1 ? "позиция" : itemsRemoved < 5 ? "позиции" : "позиций",
      tone: "rose",
    });
  }

  if (vehiclesDriverChanged > 0) {
    rows.push({
      id: "vehicles-driver",
      label: `Водитель: ${vehiclesDriverChanged}`,
      detail: vehiclesDriverChanged === 1 ? "машина" : vehiclesDriverChanged < 5 ? "машины" : "машин",
      tone: "amber",
    });
  }
  if (vehiclesMileageChanged > 0) {
    rows.push({
      id: "vehicles-mileage",
      label: `Пробег: ${vehiclesMileageChanged}`,
      detail: vehiclesMileageChanged === 1 ? "машина" : vehiclesMileageChanged < 5 ? "машины" : "машин",
      tone: "amber",
    });
  }

  const toneClass = (tone?: DiffItemRow["tone"]): string => {
    switch (tone) {
      case "emerald":
        return "text-emerald";
      case "rose":
        return "text-rose";
      case "amber":
      default:
        return "text-amber";
    }
  };

  return (
    <article className="rounded-lg border border-amber-border bg-surface shadow-xs overflow-hidden">
      <header className="px-3 py-2 border-b border-amber-border bg-amber-soft">
        <p className="eyebrow text-amber">Что изменится при сохранении</p>
      </header>
      <div className="p-3">
        {rows.length === 0 ? (
          <p className="text-sm text-ink-3">Изменений пока нет.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-col gap-0.5">
                <span className={`font-medium ${toneClass(r.tone)}`}>{r.label}</span>
                {r.detail && (
                  <span className="text-xs text-ink-3 mono-num">{r.detail}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {editedOverrideRaw !== "" && (itemsAdded + itemsRemoved + itemsQtyChanged) > 0 && (
          <p className="mt-3 rounded border border-rose-border bg-rose-soft px-2.5 py-2 text-xs text-rose">
            ⚠ Задан ручной итог — он перекроет изменения позиций: сумма брони
            станет {formatRu(Number(editedOverrideRaw.replace(",", ".")))} ₽ независимо
            от правок состава. Очистите ручной итог, если хотите, чтобы сумма
            считалась по позициям.
          </p>
        )}
        <p className="mt-3 pt-3 border-t border-amber-border text-xs text-ink-3">
          После сохранения смета и финансы пересчитаются автоматически. Запись в
          аудит-логе появится как <span className="font-mono">BOOKING_RETROACTIVE_EDIT</span>.
        </p>
      </div>
    </article>
  );
}
