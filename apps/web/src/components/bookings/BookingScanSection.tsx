"use client";

import Link from "next/link";
import { useState } from "react";

import { apiFetch } from "@/lib/api";
import { SCAN_CANCEL_REASON_LABELS } from "@/lib/auditFormat";
import { StatusPill, type StatusPillVariant } from "../StatusPill";
import { toast } from "../ToastProvider";
import { ConfirmActionModal } from "./ConfirmActionModal";

// Карточка «Киоск склада» на странице брони: сессии выдачи и приёмки в киоске
// и ссылка открыть бронь в киоске (?booking=). Показывается только для
// CONFIRMED / ISSUED / RETURNED.
//
// Брошенную сессию раньше нельзя было закрыть ничем, и она блокировала
// «+ Добор» до конца аренды. Теперь у открытой сессии есть «Прервать»
// (руководитель и кладовщик — те же роли, что у киоска), а сессия, которая
// больше не соответствует статусу брони, подписана «Устарела»: она ничего не
// блокирует, но закрыть её можно и отсюда.

export type ScanSessionSummary = {
  id: string;
  operation: string;
  status: string;
  workerName: string;
  createdAt: string;
  completedAt?: string | null;
  _count?: { scanRecords: number };
  /** ACTIVE, но бронь уже в другом статусе (контракт 2.6). Нет поля — считаем сами. */
  stale?: boolean;
  /** В чек-листе есть сохранённые отметки (черновик на сервере). */
  hasDraft?: boolean;
  /** Кто нажал «Готово»; у старых сессий пусто — тогда тот, кто открыл. */
  completedBy?: string | null;
  cancelReason?: string | null;
  cancelledAt?: string | null;
};

/** Кто может прервать сессию: те же роли, что работают в киоске. */
const KIOSK_ROLES = new Set(["SUPER_ADMIN", "WAREHOUSE"]);

/** Сессия устарела и ничего не значит — так же, как решает сервер (isSessionLive). */
function isLiveFor(operation: string, bookingStatus: string, archived: boolean): boolean {
  if (operation === "ISSUE") return bookingStatus === "CONFIRMED" && !archived;
  return bookingStatus === "ISSUED";
}

function isStale(ss: ScanSessionSummary, bookingStatus: string, archived: boolean): boolean {
  if (ss.status !== "ACTIVE") return false;
  return ss.stale ?? !isLiveFor(ss.operation, bookingStatus, archived);
}

/** «24.09 10:15» по Москве. */
function moscowDayTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(d)
    .replace(",", "");
}

function opNoun(operation: string): "выдачу" | "приёмку" {
  return operation === "ISSUE" ? "выдачу" : "приёмку";
}

/** Почему открытая сессия больше ничего не значит. */
function staleHint(operation: string, bookingStatus: string, archived: boolean): string {
  const why = archived
    ? "Бронь в архиве"
    : bookingStatus === "CANCELLED"
      ? "Бронь отменена"
      : bookingStatus === "RETURNED"
        ? "Бронь уже принята"
        : operation === "ISSUE" && bookingStatus === "ISSUED"
          ? "Бронь уже выдана"
          : operation === "ISSUE"
            ? "Бронь вернули на согласование"
            : "Бронь не выдана";
  return `${why} — эта сессия ничего не блокирует и закроется сама при следующем открытии в киоске`;
}

function abortMessage(ss: ScanSessionSummary): string {
  const head =
    ss.operation === "ISSUE"
      ? "Чек-лист выдачи в киоске закроется. Количества и отметки сбросятся, бронь останется «Подтверждена». Позиции, добавленные на месте, останутся в брони."
      : "Чек-лист приёмки в киоске закроется. Отметки приёмки сбросятся, бронь останется «Выдана» — принять её можно будет заново.";
  const draft = ss.hasDraft ? "\n\nВ чек-листе есть сохранённые отметки — они пропадут." : "";
  return `${head}${draft}\n\nЕсли кладовщик сейчас работает с этим чек-листом, предупредите его.`;
}

function statusPill(ss: ScanSessionSummary, stale: boolean): { variant: StatusPillVariant; label: string } {
  if (ss.status === "COMPLETED") return { variant: "ok", label: "Завершена" };
  if (ss.status === "CANCELLED") return { variant: "none", label: "Прервана" };
  if (stale) return { variant: "warn", label: "Устарела" };
  return { variant: "edit", label: "Идёт" };
}

function sessionNote(ss: ScanSessionSummary, stale: boolean, bookingStatus: string, archived: boolean): string | null {
  if (ss.status === "COMPLETED") {
    const when = moscowDayTime(ss.completedAt);
    return `Завершил ${ss.completedBy || ss.workerName}${when ? ` · ${when}` : ""}`;
  }
  if (ss.status === "CANCELLED") {
    const why = (ss.cancelReason && SCAN_CANCEL_REASON_LABELS[ss.cancelReason]) || null;
    const when = moscowDayTime(ss.cancelledAt);
    if (!why && !when) return null;
    return [why ?? "Прервали", when].filter(Boolean).join(" · ");
  }
  if (stale) return staleHint(ss.operation, bookingStatus, archived);
  // hasDraft знает только про черновик; позиции, добавленные на месте, и
  // отметки сканером в него не входят — поэтому «отметок нет» не пишем.
  if (ss.hasDraft === true) return "В чек-листе есть сохранённые отметки";
  return null;
}

function errorCode(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(e: unknown, fallback: string): string {
  if (typeof e === "object" && e !== null) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string" && m.trim()) return m;
  }
  return fallback;
}

export function BookingScanSection({
  bookingId,
  bookingStatus,
  scanSessions,
  userRole,
  archived = false,
  onChanged,
}: {
  bookingId: string;
  bookingStatus: string;
  scanSessions: ScanSessionSummary[] | null | undefined;
  /** Роль текущего пользователя: прервать сессию могут руководитель и кладовщик. */
  userRole?: string | null;
  /** Бронь в архиве — в киоск не ведём. */
  archived?: boolean;
  /** Перечитать карточку после закрытия сессии. */
  onChanged?: () => void | Promise<void>;
}) {
  const [confirmFor, setConfirmFor] = useState<ScanSessionSummary | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (!["CONFIRMED", "ISSUED", "RETURNED"].includes(bookingStatus)) return null;

  const sessions = scanSessions ?? [];
  const canManage = userRole != null && KIOSK_ROLES.has(userRole);
  const hasLiveSession = sessions.some((ss) => ss.status === "ACTIVE" && !isStale(ss, bookingStatus, archived));

  async function refreshCard() {
    try {
      await onChanged?.();
    } catch {
      // Карточку перечитаем при следующем действии — сама сессия уже закрыта.
    }
  }

  async function abort(ss: ScanSessionSummary, stale: boolean) {
    if (busyId) return;
    setBusyId(ss.id);
    try {
      await apiFetch(`/api/warehouse/sessions/${ss.id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: "CARD_ABORT" }),
      });
      setConfirmFor(null);
      toast.success(
        stale
          ? "Устаревшая сессия киоска закрыта"
          : `${ss.operation === "ISSUE" ? "Выдача" : "Приёмка"} в киоске прервана`,
      );
      await refreshCard();
    } catch (e: unknown) {
      const code = errorCode(e);
      if (code === "SESSION_STALE") {
        // Сервер сам закрыл устаревшую сессию — для карточки это успех.
        setConfirmFor(null);
        toast.success("Устаревшая сессия киоска закрыта");
        await refreshCard();
      } else if (code?.startsWith("SESSION_")) {
        // Сессию успели завершить или прервать — показываем, что с ней на самом деле.
        setConfirmFor(null);
        toast.info(errorMessage(e, "Сессия киоска уже закрыта"));
        await refreshCard();
      } else {
        toast.error(errorMessage(e, "Не удалось прервать сессию киоска"));
      }
    } finally {
      setBusyId(null);
    }
  }

  const linkLabel = hasLiveSession
    ? "Продолжить в киоске"
    : bookingStatus === "CONFIRMED"
      ? "Выдать через киоск"
      : "Принять через киоск";

  return (
    <div className="rounded-lg border border-border bg-surface shadow-xs overflow-hidden no-print">
      <div className="px-4 py-3 border-b border-border bg-surface-subtle">
        <p className="eyebrow">Киоск склада</p>
      </div>
      <div className="px-4 py-3 text-sm text-ink space-y-3">
        {sessions.length > 0 ? (
          <ul className="space-y-2" aria-label="Сессии киоска">
            {sessions.map((ss) => {
              const stale = isStale(ss, bookingStatus, archived);
              const pill = statusPill(ss, stale);
              const note = sessionNote(ss, stale, bookingStatus, archived);
              const showAction = canManage && ss.status === "ACTIVE";
              const busy = busyId === ss.id;
              return (
                <li key={ss.id} className="rounded-lg border border-border bg-surface-subtle px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <StatusPill
                        variant={ss.operation === "ISSUE" ? "info" : "ok"}
                        label={ss.operation === "ISSUE" ? "Выдача" : "Приёмка"}
                      />
                      <span className="truncate text-ink-2">{ss.workerName}</span>
                      <span className="shrink-0 text-xs text-ink-3 mono-num">{moscowDayTime(ss.createdAt)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusPill variant={pill.variant} label={pill.label} />
                      {showAction &&
                        (stale ? (
                          <button
                            type="button"
                            onClick={() => abort(ss, true)}
                            disabled={busy}
                            aria-label="Закрыть устаревшую сессию"
                            className="rounded border border-border px-2.5 py-1 text-xs text-ink-2 hover:bg-surface-muted disabled:opacity-50"
                          >
                            {busy ? "Закрываю…" : "Закрыть"}
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmFor(ss)}
                            disabled={busy}
                            aria-label={`Прервать ${opNoun(ss.operation)} в киоске`}
                            className="rounded border border-rose-border px-2.5 py-1 text-xs text-rose hover:bg-rose-soft disabled:opacity-50"
                          >
                            Прервать
                          </button>
                        ))}
                    </div>
                  </div>
                  {note && <p className="mt-1 text-xs text-ink-3">{note}</p>}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="text-ink-3 text-sm">В киоске по этой брони ещё не работали</div>
        )}
        {(bookingStatus === "CONFIRMED" || bookingStatus === "ISSUED") && !archived && (
          <Link
            href={`/warehouse/scan?booking=${bookingId}`}
            className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-sm hover:bg-surface-muted transition-colors"
          >
            {linkLabel}
            <span aria-hidden="true">→</span>
          </Link>
        )}
      </div>

      <ConfirmActionModal
        open={confirmFor != null}
        title={confirmFor ? `Прервать ${opNoun(confirmFor.operation)}` : ""}
        subtitle={
          confirmFor ? `Начал ${confirmFor.workerName} · ${moscowDayTime(confirmFor.createdAt)}` : undefined
        }
        message={confirmFor ? abortMessage(confirmFor) : ""}
        confirmLabel={confirmFor ? `Прервать ${opNoun(confirmFor.operation)}` : ""}
        tone="danger"
        loading={confirmFor != null && busyId === confirmFor.id}
        onClose={() => setConfirmFor(null)}
        onConfirm={() => {
          if (confirmFor) void abort(confirmFor, false);
        }}
      />
    </div>
  );
}
