"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import { toast } from "../ToastProvider";

interface Props {
  open: boolean;
  paymentId: string | null;
  onClose: () => void;
  onVoided: () => void;
}

/**
 * Модалка «Аннулировать платёж» (T11).
 * Требует обязательную причину (min 3 символа после trim).
 * Вызывает DELETE /api/payments/:id (передаёт reason в теле).
 */
export function VoidPaymentModal({ open, paymentId, onClose, onVoided }: Props) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-focus on open
  useEffect(() => {
    if (open) {
      setReason("");
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [open]);

  // Esc to close
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
    if (!isValid || !paymentId) return;
    setSaving(true);
    try {
      // Передаём reason в теле DELETE-запроса.
      // Сервер пишет аудит PAYMENT_DELETE (reason в before-поле).
      await apiFetch(`/api/payments/${paymentId}`, {
        method: "DELETE",
        body: JSON.stringify({ reason: trimmedReason }),
      });
      toast.success("Платёж аннулирован");
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
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-[15px] font-semibold text-ink">Аннулировать платёж</h2>
          <button
            onClick={onClose}
            aria-label="Закрыть"
            className="text-ink-3 hover:text-ink text-lg leading-none"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-3">
          <p className="text-sm text-ink-2">
            Укажите причину аннулирования. Это действие нельзя отменить.
          </p>
          <div>
            <label className="eyebrow block mb-1">
              Причина *{" "}
              <span className="text-ink-3 font-normal">({trimmedReason.length}/3 мин.)</span>
            </label>
            <textarea
              ref={textareaRef}
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink resize-none"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Например: ошибка ввода суммы"
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2 justify-end px-5 pb-5">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm border border-border rounded text-ink-2 hover:bg-surface-subtle"
          >
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
