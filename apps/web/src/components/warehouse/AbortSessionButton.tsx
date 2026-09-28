"use client";

/**
 * AbortSessionButton — «Прервать выдачу» / «Прервать приёмку» в киоске (P1).
 *
 * Зачем: брошенную сессию киоска закрыть было нечем. Она висела ACTIVE и
 * блокировала «+ Добор» на карточке брони, а совет из ошибки («завершите или
 * отмените в киоске») выполнить было нельзя: кнопки отмены не существовало.
 *
 * Кнопка с подтверждением: количества и отметки сбрасываются (черновик
 * забывается), сессия уходит в «Прервана» с причиной `KIOSK_ABORT`, бронь
 * остаётся в своём статусе. Доборы, уже добавленные в этой сессии, остаются в
 * брони — они записаны в неё сразу, и модалка об этом предупреждает.
 *
 * Сессию уже закрыли (оформили на другом планшете, прервали на карточке) —
 * вместо ошибки зовётся `onSessionClosed`: чек-лист покажет
 * `SessionClosedNotice`. Без этого колбэка — сразу `onAborted`.
 */

import { useEffect, useRef, useState } from "react";
import { toast } from "../ToastProvider";
import { scanApi } from "./api";
import { isScanApiError, isSessionClosedError } from "./types";
import type { ScanApiError, ScanOperation } from "./types";
import { discardDraft } from "./useChecklistDraft";

interface AbortSessionButtonProps {
  sessionId: string;
  operation: ScanOperation;
  /** Сколько доборов сделано в этой сессии — они останутся в брони. */
  addonsInSession?: number;
  /** Сессию прервали: страница закрывает чек-лист и обновляет списки. */
  onAborted: () => void;
  /** Сессию уже закрыли раньше (`SESSION_*`) — показать `SessionClosedNotice`. */
  onSessionClosed?: (err: ScanApiError) => void;
  disabled?: boolean;
  /**
   * `header` — компактная текстовая кнопка для шапки чек-листа,
   * `block` — во всю ширину (мобильный низ экрана).
   */
  variant?: "header" | "block";
}

const BOOKING_STATUS_AFTER: Record<ScanOperation, string> = {
  ISSUE: "Подтверждена",
  RETURN: "Выдана",
};

function addonsPhrase(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `Добор этой сессии (${n}) останется в брони.`;
  return `Доборы этой сессии (${n}) останутся в брони.`;
}

export function AbortSessionButton({
  sessionId,
  operation,
  addonsInSession = 0,
  onAborted,
  onSessionClosed,
  disabled = false,
  variant = "header",
}: AbortSessionButtonProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);

  const isIssue = operation === "ISSUE";
  const label = isIssue ? "Прервать выдачу" : "Прервать приёмку";

  useEffect(() => {
    if (!open) return;
    cancelBtnRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy]);

  function close() {
    if (busy) return;
    setOpen(false);
    setError(null);
  }

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await scanApi.cancel(sessionId, { reason: "KIOSK_ABORT" });
      discardDraft(sessionId);
      setOpen(false);
      toast.success(isIssue ? "Выдача прервана" : "Приёмка прервана");
      onAborted();
    } catch (err: unknown) {
      if (isSessionClosedError(err)) {
        discardDraft(sessionId);
        setOpen(false);
        if (onSessionClosed) onSessionClosed(err);
        else onAborted();
        return;
      }
      setError(
        isScanApiError(err) ? err.message : "Не удалось прервать — попробуйте ещё раз",
      );
    } finally {
      setBusy(false);
    }
  }

  const triggerClass =
    variant === "block"
      ? "block w-full rounded-lg border border-rose-border bg-surface px-4 py-2.5 text-center text-sm font-semibold text-rose transition-colors hover:bg-rose-soft disabled:opacity-50"
      : "whitespace-nowrap rounded border border-rose-border px-2.5 py-1 text-xs font-semibold text-rose transition-colors hover:bg-rose-soft disabled:opacity-50";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        className={triggerClass}
      >
        {label}
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="abort-session-title"
          className="fixed inset-0 z-50 flex items-end justify-center bg-scrim/40 lg:items-center lg:p-4"
          onClick={close}
        >
          <div
            className="w-full max-w-[440px] rounded-t-2xl border border-border bg-surface px-4 pb-5 pt-4 shadow-lg lg:rounded-xl lg:pb-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="abort-session-title" className="text-[15px] font-semibold text-ink">
              {label}?
            </h3>
            <p className="mt-1.5 text-[13px] leading-snug text-ink-2">
              {isIssue ? "Количества и отметки сбросятся" : "Отметки приёмки сбросятся"},
              бронь останется «{BOOKING_STATUS_AFTER[operation]}».
              {isIssue && addonsInSession > 0 ? ` ${addonsPhrase(addonsInSession)}` : ""}
            </p>
            {error && (
              <p
                role="alert"
                className="mt-3 rounded-lg border border-rose-border bg-rose-soft px-3 py-2 text-[12px] text-rose"
              >
                {error}
              </p>
            )}
            <div className="mt-4 flex gap-2">
              <button
                ref={cancelBtnRef}
                type="button"
                onClick={close}
                disabled={busy}
                className="flex-1 rounded-lg border border-border bg-surface px-4 py-3 text-center text-[14px] font-semibold text-ink transition-colors hover:bg-surface-muted disabled:opacity-50"
              >
                {isIssue ? "Продолжить выдачу" : "Продолжить приёмку"}
              </button>
              <button
                type="button"
                onClick={() => void confirm()}
                disabled={busy}
                className="flex-1 rounded-lg bg-rose px-4 py-3 text-center text-[14px] font-semibold text-surface transition-colors hover:opacity-95 disabled:opacity-60"
              >
                {busy ? "Прерываем…" : label}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
