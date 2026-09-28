"use client";

/**
 * SessionClosedNotice — экран «с этой сессией больше работать нельзя».
 *
 * Показывается вместо чек-листа, когда любой вызов киоска вернул код
 * `SESSION_*` (таблица 2.2 плана):
 *  - `SESSION_ALREADY_COMPLETED` — выдачу или приёмку уже оформили (другой
 *    планшет, повторное «Готово»);
 *  - `SESSION_CANCELLED` — сессию прервали (в киоске, на карточке брони,
 *    ручной «Выдать»/«Вернуть», отмена или архив брони);
 *  - `SESSION_STALE` — бронь изменили на карточке, чек-лист устарел;
 *  - `SESSION_NOT_FOUND` — сессии нет.
 *
 * Раньше такие ответы были тостом «Внутренняя ошибка сервера» (500) поверх
 * живого на вид чек-листа — кладовщик продолжал отмечать строки в закрытой
 * сессии. Здесь один выход: «К списку броней» (страница закрывает чек-лист и
 * обновляет списки). Текст ошибки приходит с сервера по-русски; заголовок и
 * строка «кто и когда» — из кода и `details`.
 */

import type {
  ScanApiError,
  ScanCancelReason,
  ScanOperation,
} from "./types";
import { SCAN_ERROR, getScanErrorDetails, scanErrorCode } from "./types";
import { formatMoscowDayTime } from "./useChecklistDraft";

/** Почему сессию закрыли — по-человечески, для строки «Причина: …». */
export const CANCEL_REASON_LABEL: Record<ScanCancelReason, string> = {
  KIOSK_ABORT: "прервали в киоске",
  CARD_ABORT: "прервали на карточке брони",
  EMPTY_LEAVE: "закрыли без изменений",
  BOOKING_ISSUED_MANUALLY: "бронь выдали кнопкой на карточке",
  BOOKING_RETURNED_MANUALLY: "возврат отметили кнопкой на карточке",
  BOOKING_CANCELLED: "бронь отменили",
  BOOKING_ARCHIVED: "бронь убрали в архив",
  STALE: "бронь изменили на карточке",
};

export interface SessionClosedView {
  tone: "done" | "warn";
  title: string;
  message: string;
  /** «Завершено 12.07, 14:05 · Иван» / «Причина: … · когда, кто»; может не быть. */
  meta: string | null;
}

function joinMeta(parts: Array<string | null | undefined>): string | null {
  const clean = parts.map((p) => p?.trim()).filter((p): p is string => Boolean(p));
  return clean.length > 0 ? clean.join(", ") : null;
}

/**
 * Заголовок, текст и строка «кто и когда» по ошибке закрытой сессии.
 * `operation` — запасной вариант, если в `details` операции нет.
 */
export function describeClosedSession(
  error: ScanApiError,
  operation?: ScanOperation,
): SessionClosedView {
  const code = scanErrorCode(error);

  if (code === SCAN_ERROR.SESSION_ALREADY_COMPLETED) {
    const d = getScanErrorDetails(error, SCAN_ERROR.SESSION_ALREADY_COMPLETED);
    const op = d?.operation ?? operation;
    const title =
      op === "RETURN"
        ? "Приёмка уже завершена"
        : op === "ISSUE"
          ? "Выдача уже оформлена"
          : "Сессия уже завершена";
    const when = formatMoscowDayTime(d?.completedAt);
    const by = d?.completedBy?.trim() || null;
    const meta = when
      ? `Завершено ${when}${by ? ` · ${by}` : ""}`
      : by
        ? `Завершил сотрудник: ${by}`
        : null;
    return {
      tone: "done",
      title,
      message:
        error.message ||
        "Изменения с этого экрана не применены — повторно оформлять не нужно.",
      meta,
    };
  }

  if (code === SCAN_ERROR.SESSION_CANCELLED) {
    const d = getScanErrorDetails(error, SCAN_ERROR.SESSION_CANCELLED);
    const reason = d?.cancelReason ? CANCEL_REASON_LABEL[d.cancelReason] ?? null : null;
    const who = joinMeta([formatMoscowDayTime(d?.cancelledAt), d?.cancelledBy]);
    const meta = reason
      ? `Причина: ${reason}${who ? ` · ${who}` : ""}`
      : who
        ? `Прервано: ${who}`
        : null;
    return {
      tone: "warn",
      title: "Сессию прервали",
      message: error.message || "Сессию склада прервали — откройте бронь заново.",
      meta,
    };
  }

  if (code === SCAN_ERROR.SESSION_STALE) {
    return {
      tone: "warn",
      title: "Чек-лист закрыт",
      message:
        error.message ||
        "Бронь изменили на карточке — чек-лист закрыт, изменения из него не применены.",
      meta: null,
    };
  }

  if (code === SCAN_ERROR.SESSION_NOT_FOUND) {
    return {
      tone: "warn",
      title: "Сессия не найдена",
      message: error.message || "Сессия склада не найдена — откройте бронь заново.",
      meta: null,
    };
  }

  return {
    tone: "warn",
    title: "С этим чек-листом больше работать нельзя",
    message: error.message || "Откройте бронь заново из списка.",
    meta: null,
  };
}

interface SessionClosedNoticeProps {
  /** Ошибка с кодом `SESSION_*` (`closedError` из `useScanSession` и т. п.). */
  error: ScanApiError;
  /** Выдача или приёмка — если сервер не прислал операцию в `details`. */
  operation?: ScanOperation;
  /** «К списку броней»: закрыть чек-лист и обновить списки. */
  onBack: () => void;
}

export function SessionClosedNotice({ error, operation, onBack }: SessionClosedNoticeProps) {
  const view = describeClosedSession(error, operation);
  const done = view.tone === "done";

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-12">
      <section
        role="alert"
        aria-labelledby="session-closed-title"
        className={`w-full max-w-[440px] rounded-xl border px-4 py-4 shadow-xs ${
          done ? "border-emerald-border bg-emerald-soft" : "border-amber-border bg-amber-soft"
        }`}
      >
        <div className="flex items-start gap-2.5">
          <span aria-hidden="true" className="text-[18px] leading-none">
            {done ? "✓" : "⚠"}
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="session-closed-title"
              className={`text-[15px] font-semibold ${done ? "text-emerald" : "text-amber"}`}
            >
              {view.title}
            </h2>
            <p className="mt-1 text-[13px] leading-snug text-ink">{view.message}</p>
            {view.meta && (
              <p className="mt-1.5 text-[12px] leading-snug text-ink-2">{view.meta}</p>
            )}
          </div>
        </div>
      </section>
      <button
        type="button"
        onClick={onBack}
        className="mt-4 rounded-lg bg-accent-bright px-5 py-3 text-[14px] font-semibold text-surface transition-colors hover:opacity-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-bright"
      >
        ← К списку броней
      </button>
    </div>
  );
}
