"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import { formatRub } from "../../lib/format";
import { toast } from "../ToastProvider";

interface ClientOption {
  id: string;
  name: string;
}

interface Booking {
  id: string;
  client: { id: string; name: string };
  projectName: string;
  finalAmount: string;
  amountPaid: string;
  isLegacyImport: boolean;
}

interface Props {
  booking: Booking;
  onClose: () => void;
  onSaved: () => void;
}

export function BookingQuickEditModal({ booking, onClose, onSaved }: Props) {
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [clientsLoading, setClientsLoading] = useState(true);
  const [clientId, setClientId] = useState(booking.client.id);
  const [projectName, setProjectName] = useState(booking.projectName);
  const [finalAmount, setFinalAmount] = useState(booking.finalAmount);
  const [saving, setSaving] = useState(false);
  const firstFieldRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ clients: ClientOption[] }>("/api/clients?limit=500")
      .then((r) => {
        if (cancelled) return;
        const list = r.clients ?? [];
        // Убедимся, что текущий клиент присутствует в списке (на случай фильтрации)
        if (!list.some((c) => c.id === booking.client.id)) {
          list.unshift(booking.client);
        }
        setClients(list);
      })
      .catch(() => {
        if (cancelled) return;
        // Fallback: отдадим хотя бы текущего клиента
        setClients([booking.client]);
      })
      .finally(() => {
        if (!cancelled) setClientsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [booking.client]);

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const amountEditable = booking.isLegacyImport;

  const hasChanges = useMemo(() => {
    if (clientId !== booking.client.id) return true;
    if (projectName.trim() !== booking.projectName) return true;
    if (amountEditable && finalAmount !== booking.finalAmount) return true;
    return false;
  }, [clientId, projectName, finalAmount, amountEditable, booking]);

  const handleSubmit = async () => {
    const trimmedProject = projectName.trim();
    if (!trimmedProject) {
      toast.error("Укажите название проекта");
      return;
    }
    if (amountEditable && (!finalAmount || Number(finalAmount) < 0 || Number.isNaN(Number(finalAmount)))) {
      toast.error("Сумма должна быть неотрицательным числом");
      return;
    }

    const payload: Record<string, unknown> = {};
    if (clientId !== booking.client.id) payload.clientId = clientId;
    if (trimmedProject !== booking.projectName) payload.projectName = trimmedProject;
    if (amountEditable && finalAmount !== booking.finalAmount) {
      payload.finalAmount = Number(finalAmount);
    }

    if (Object.keys(payload).length === 0) {
      onClose();
      return;
    }

    setSaving(true);
    try {
      await apiFetch(`/api/bookings/${booking.id}/finance-corrections`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      toast.success("Бронь обновлена");
      onSaved();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Ошибка сохранения");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-surface rounded-lg border border-border shadow-xl w-full max-w-md">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-[15px] font-semibold text-ink">Редактировать бронь</h2>
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
          <div>
            <label className="eyebrow block mb-1">Клиент</label>
            <select
              ref={firstFieldRef}
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              disabled={clientsLoading}
            >
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="eyebrow block mb-1">Проект</label>
            <input
              type="text"
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="Название проекта"
            />
          </div>

          <div>
            <label className="eyebrow block mb-1">
              Сумма
              {!amountEditable && (
                <span className="ml-1 text-ink-3 font-normal normal-case">
                  (определяется сметой)
                </span>
              )}
            </label>
            <input
              type="number"
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink disabled:bg-surface-subtle disabled:text-ink-3"
              value={finalAmount}
              onChange={(e) => setFinalAmount(e.target.value)}
              min="0"
              step="0.01"
              disabled={!amountEditable}
            />
            {!amountEditable && (
              <p className="text-xs text-ink-3 mt-1">
                Итог считается из сметы. Откройте карточку брони, чтобы изменить позиции.
              </p>
            )}
            {amountEditable && Number(booking.amountPaid) > 0 && (
              <p className="text-xs text-ink-3 mt-1">
                Уже оплачено: {formatRub(booking.amountPaid)}. Остаток пересчитается автоматически.
              </p>
            )}
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
            disabled={saving || !hasChanges}
            className="px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent-bright disabled:opacity-50"
          >
            {saving ? "Сохранение…" : "Сохранить"}
          </button>
        </div>
      </div>
    </div>
  );
}
