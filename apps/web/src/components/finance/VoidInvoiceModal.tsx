"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import { toast } from "../ToastProvider";

interface Props {
  open: boolean;
  invoiceId: string | null;
  onClose: () => void;
  onVoided: () => void;
}

/**
 * Модалка «Аннулировать счёт».
 * POST /api/invoices/:id/void с обязательной причиной.
 */
export function VoidInvoiceModal({ open, invoiceId, onClose, onVoided }: Props) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setReason("");
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const trimmedReason = reason.trim();
  const isValid = trimmedReason.length >= 3;

  const handleSubmit = async () => {
    if (!isValid || !invoiceId) return;
    setSaving(true);
    try {
      await apiFetch(`/api/invoices/${invoiceId}/void`, {
        method: "POST",
        body: JSON.stringify({ reason: trimmedReason }),
      });
      toast.success("Счёт аннулирован");
      onVoided();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Ошибка аннулирования");
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-surface rounded-lg border border-border shadow-xl w-full max-w-sm">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-[15px] font-semibold text-ink">Аннулировать счёт</h2>
          <button onClick={onClose} aria-label="Закрыть" className="text-ink-3 hover:text-ink text-lg leading-none">×</button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <p className="text-sm text-ink-2">Укажите причину аннулирования. Это действие нельзя отменить.</p>
          <div>
            <label className="eyebrow block mb-1">
              Причина * <span className="text-ink-3 font-normal">({trimmedReason.length}/3 мин.)</span>
            </label>
            <textarea
              ref={textareaRef}
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink resize-none"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Например: ошибка суммы, дублирующий счёт"
            />
          </div>
        </div>

        <div className="flex gap-2 justify-end px-5 pb-5">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-border rounded text-ink-2 hover:bg-surface-subtle">
            Отмена
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving || !isValid}
            className="px-4 py-2 text-sm bg-rose text-white rounded hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Аннулирование…" : "Аннулировать"}
          </button>
        </div>
      </div>
    </div>
  );
}
