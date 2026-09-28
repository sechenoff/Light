"use client";

/**
 * ResumedSessionBanner — amber-плашка над чек-листом, когда createSession
 * вернул уже идущую ACTIVE-сессию (`resumed: true`).
 *
 * Зачем: повторное открытие брони продолжает старую сессию. Плашка говорит,
 * кто и когда её начал и что из начатого восстановлено. Раньше она обещала
 * «Доборы и принятые позиции сохранены» безусловно, хотя количества на
 * степпере и отметки жили только в памяти экрана и терялись (P6). Теперь они
 * хранятся черновиком на сервере, и плашка пишет правду: восстановлен
 * черновик (когда и кем сохранён) или сохранённых отметок нет.
 *
 * Рендерят её сами чек-листы (у них есть `/state` с черновиком), страница
 * лишь передаёт `resumed` из createSession.
 *
 * Осознанно БЕЗ кнопки «Начать заново»: для этого есть «Прервать выдачу /
 * приёмку» (`AbortSessionButton`) с подтверждением.
 */

import type { ScanOperation } from "./types";
import { formatMoscowDayTime, formatMoscowTime } from "./useChecklistDraft";

interface ResumedSessionBannerProps {
  /** Выдача или приёмка — от этого зависят формулировки. Без неё — общий текст. */
  operation?: ScanOperation;
  /** ISO-время начала сессии (ScanSession.startedAt); null — не показываем время. */
  startedAt: string | null;
  /** Кто открыл сессию (`session.workerName`). */
  startedBy?: string | null;
  /**
   * Черновик восстановлен на экране. `undefined` — старый режим: про
   * восстановление ничего не утверждаем.
   */
  restored?: boolean;
  /** ISO — когда черновик сохранили последний раз. */
  draftSavedAt?: string | null;
  /** Кто сохранил черновик последним. */
  draftSavedBy?: string | null;
  /**
   * Часть черновика не подошла к текущему составу брони (строки изменились) —
   * жёлтая приписка «проверьте».
   */
  partial?: boolean;
  /** Закрыть плашку (локально, до конца текущего чек-листа). */
  onDismiss: () => void;
}

function headline(operation: ScanOperation | undefined): string {
  if (operation === "ISSUE") return "Продолжена выдача";
  if (operation === "RETURN") return "Продолжена приёмка";
  return "Продолжена незавершённая сессия";
}

function restoredText(
  operation: ScanOperation | undefined,
  savedAt: string | null,
  savedBy: string | null,
): string {
  const what =
    operation === "RETURN"
      ? "Отметки приёмки восстановлены"
      : operation === "ISSUE"
        ? "Количества и отметки восстановлены"
        : "Отметки восстановлены";
  const time = formatMoscowTime(savedAt);
  const who = savedBy?.trim() || null;
  if (time && who) return `${what} — сохранено в ${time}, ${who}.`;
  if (time) return `${what} — сохранено в ${time}.`;
  return `${what}.`;
}

function notRestoredText(operation: ScanOperation | undefined): string {
  if (operation === "RETURN") return "Сохранённых отметок нет — отметьте приёмку заново.";
  return "Сохранённых отметок нет — проверьте количества.";
}

export function ResumedSessionBanner({
  operation,
  startedAt,
  startedBy,
  restored,
  draftSavedAt = null,
  draftSavedBy = null,
  partial = false,
  onDismiss,
}: ResumedSessionBannerProps) {
  const started = formatMoscowDayTime(startedAt);
  const by = startedBy?.trim() || null;

  let startedPart = "";
  if (started && by) startedPart = `, начатая ${started} (${by})`;
  else if (started) startedPart = `, начатая ${started}`;
  else if (by) startedPart = ` (${by})`;

  const body =
    restored === undefined
      ? null
      : restored
        ? restoredText(operation, draftSavedAt, draftSavedBy)
        : notRestoredText(operation);

  return (
    <div
      role="status"
      className="flex items-start gap-2 border-b border-amber-border bg-amber-soft px-3 py-2.5 lg:px-4"
    >
      <span aria-hidden="true" className="text-[14px] leading-snug">
        ⏳
      </span>
      <p className="flex-1 text-[12px] leading-snug text-amber">
        <span className="font-semibold">{headline(operation)}</span>
        {startedPart}.
        {body ? ` ${body}` : ""}
        {restored && partial
          ? " Часть позиций брони с тех пор изменилась — проверьте отмеченные строки."
          : ""}
      </p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Скрыть уведомление о продолженной сессии"
        className="-mr-1 -mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded text-[16px] leading-none text-amber transition-colors hover:bg-amber-soft"
      >
        ✕
      </button>
    </div>
  );
}
