"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";
import { formatRub } from "../../lib/format";
import { toast } from "../ToastProvider";

interface CreditNote {
  id: string;
  amount: string;
  remainingAmount: string;
  reason: string;
  expiresAt: string | null;
  appliedToBookingId: string | null;
  createdAt: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  bookingId: string;
  clientId: string;
  onApplied: () => void;
}

/**
 * Секция «Кредит-ноты клиента» на /bookings/[id].
 * Показывает applicable кредит-ноты клиента и позволяет применить к текущей броне.
 * POST /api/credit-notes/:id/apply
 */
export function CreditNoteApplyModal({ open, onClose, bookingId, clientId, onApplied }: Props) {
  const [notes, setNotes] = useState<CreditNote[]>([]);
  const [loading, setLoading] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !clientId) return;
    let cancelled = false;
    setLoading(true);
    apiFetch<{ items: CreditNote[] }>(`/api/credit-notes?contactClientId=${clientId}`)
      .then((d) => {
        if (!cancelled) {
          // Фильтруем: только не применённые + не истёкшие + с остатком > 0
          const applicable = d.items.filter((n) => {
            if (n.appliedToBookingId) return false;
            if (Number(n.remainingAmount) <= 0) return false;
            if (n.expiresAt && new Date(n.expiresAt) < new Date()) return false;
            return true;
          });
          setNotes(applicable);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) toast.error(e instanceof Error ? e.message : "Ошибка загрузки кредит-нот");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, clientId]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function applyNote(noteId: string) {
    setApplyingId(noteId);
    try {
      await apiFetch(`/api/credit-notes/${noteId}/apply`, {
        method: "POST",
        body: JSON.stringify({ applyToBookingId: bookingId }),
      });
      toast.success("Кредит-нота применена к броне");
      onApplied();
      onClose();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Ошибка применения кредит-ноты");
    } finally {
      setApplyingId(null);
    }
  }

  function formatExpiry(iso: string | null): string {
    if (!iso) return "Бессрочно";
    return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" });
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-surface rounded-lg border border-border shadow-xl w-full max-w-sm">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-[15px] font-semibold text-ink">Кредит-ноты клиента</h2>
          <button onClick={onClose} aria-label="Закрыть" className="text-ink-3 hover:text-ink text-lg leading-none">×</button>
        </div>

        <div className="px-5 py-4">
          {loading ? (
            <div className="py-6 text-center text-ink-3 text-sm">Загрузка…</div>
          ) : notes.length === 0 ? (
            <div className="py-6 text-center text-ink-3 text-sm">
              Нет доступных кредит-нот у этого клиента
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-ink-2">Выберите кредит-ноту для применения к этой броне:</p>
              {notes.map((note) => (
                <div key={note.id} className="border border-border rounded-lg p-3 flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-ink mono-num">{formatRub(Number(note.remainingAmount))}</div>
                    <div className="text-xs text-ink-3 mt-0.5">{note.reason}</div>
                    <div className="text-xs text-ink-3">Действует до: {formatExpiry(note.expiresAt)}</div>
                  </div>
                  <button
                    onClick={() => applyNote(note.id)}
                    disabled={applyingId === note.id}
                    className="px-3 py-1.5 text-[12px] bg-accent-bright text-white rounded hover:opacity-90 disabled:opacity-50 flex-shrink-0"
                  >
                    {applyingId === note.id ? "…" : "Применить"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end px-5 pb-4">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-border rounded text-ink-2 hover:bg-surface-subtle">
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}
