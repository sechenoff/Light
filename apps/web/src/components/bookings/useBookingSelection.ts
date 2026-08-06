"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Выбор броней чекбоксами на /bookings.
 *
 * Главная тонкость — список живёт под фильтрами и курсорной пагинацией.
 * Выбор хранится как Set id и «подрезается» при смене набора строк: если
 * бронь ушла из выдачи (сменили фильтр, отправили в архив), она обязана
 * пропасть и из выбора — иначе групповое действие уедет по невидимым
 * пользователю броням. При этом дозагрузка выбор сохраняет: прежние строки
 * остаются в списке, значит остаются и в выборе.
 *
 * `maxSelectable` ограничивает «выбрать все». Список подгружается сам по мере
 * скролла, так что загруженных строк легко набирается несколько сотен — больше
 * серверного потолка пачки. Без ограничения один клик выбрал бы всё и увёл бы
 * панель действий в полностью недоступное состояние.
 */
export function useBookingSelection<T extends { id: string }>(rows: T[], maxSelectable?: number) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  // Подрезка выбора под актуальный набор строк. Сравниваем по составу id,
  // а не по ссылке на массив: список пересоздаётся при каждом рендере
  // мутаций, и подрезка на каждый рендер была бы лишней работой.
  const idsKey = rows.map((r) => r.id).join(",");
  const idsKeyRef = useRef(idsKey);
  useEffect(() => {
    if (idsKeyRef.current === idsKey) return;
    idsKeyRef.current = idsKey;
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(rows.map((r) => r.id));
      const next = new Set<string>();
      for (const id of prev) if (live.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clear = useCallback(() => setSelected(new Set()), []);

  /** Сколько строк реально возьмёт «выбрать все». */
  const selectableCount = maxSelectable ? Math.min(rows.length, maxSelectable) : rows.length;

  /** «Выбрать все» — по загруженным строкам сверху вниз; повторный клик снимает. */
  const toggleAll = useCallback(() => {
    setSelected((prev) =>
      prev.size >= selectableCount && selectableCount > 0
        ? new Set()
        : new Set(rows.slice(0, selectableCount).map((r) => r.id)),
    );
  }, [rows, selectableCount]);

  /** Снять с выбора конкретные id (после успешного группового действия). */
  const deselect = useCallback((ids: string[]) => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);

  const allSelected = selectableCount > 0 && selected.size >= selectableCount;
  const someSelected = selected.size > 0 && !allSelected;

  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);

  return {
    selected,
    selectedRows,
    toggle,
    toggleAll,
    clear,
    deselect,
    allSelected,
    someSelected,
    selectableCount,
    /** Загруженных строк больше, чем можно выбрать разом. */
    selectionCapped: selectableCount < rows.length,
  };
}
