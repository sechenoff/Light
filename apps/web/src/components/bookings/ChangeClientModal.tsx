"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import { toast } from "../ToastProvider";

type ClientOption = {
  id: string;
  name: string;
};

type Props = {
  open: boolean;
  currentClientId: string;
  currentClientName: string;
  onClose: () => void;
  onSuccess: () => void;
  bookingId: string;
};

export function ChangeClientModal({
  open,
  currentClientId,
  currentClientName,
  onClose,
  onSuccess,
  bookingId,
}: Props) {
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(false);
  const [fetchingClients, setFetchingClients] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Загружаем список клиентов при открытии модалки
  useEffect(() => {
    if (!open) {
      setSearch("");
      setSelectedId("");
      setError(null);
      return;
    }

    setTimeout(() => searchRef.current?.focus(), 50);

    setFetchingClients(true);
    apiFetch<{ clients: ClientOption[] }>("/api/clients?limit=200")
      .then((data) => {
        // Исключаем текущего клиента из списка
        setClients(data.clients.filter((c) => c.id !== currentClientId));
      })
      .catch(() => {
        setError("Не удалось загрузить список клиентов");
      })
      .finally(() => setFetchingClients(false));
  }, [open, currentClientId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !loading) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, loading, onClose]);

  if (!open) return null;

  const filtered = search.trim()
    ? clients.filter((c) => c.name.toLowerCase().includes(search.trim().toLowerCase()))
    : clients;

  const disabled = loading || !selectedId;

  async function handleConfirm() {
    if (!selectedId) return;
    setError(null);
    setLoading(true);
    try {
      await apiFetch(`/api/bookings/${bookingId}/change-client`, {
        method: "POST",
        body: JSON.stringify({ clientId: selectedId }),
      });
      toast.success("Клиент изменён");
      onSuccess();
    } catch (e: any) {
      setError(e?.message ?? "Не удалось сменить клиента");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 px-4"
      onClick={() => !loading && onClose()}
    >
      <div
        className="w-full max-w-md rounded-lg bg-surface p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="eyebrow mb-2">Смена клиента</div>
        <h2 className="mb-1 text-lg font-semibold text-ink">Сменить клиента</h2>
        <p className="mb-4 text-sm text-ink-3">
          Бронь будет переназначена другому клиенту. Действие будет залогировано в аудит.
        </p>

        <div className="mb-3 text-sm text-ink-2">
          <span className="text-ink-3">Текущий клиент:</span>{" "}
          <span className="font-medium">{currentClientName}</span>
        </div>

        <label htmlFor="change-client-search" className="mb-1 block text-sm text-ink-2">
          Выберите нового клиента
        </label>
        <input
          id="change-client-search"
          ref={searchRef}
          type="text"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setSelectedId("");
          }}
          disabled={loading || fetchingClients}
          placeholder="Поиск по имени…"
          className="mb-2 w-full rounded border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
        />

        {fetchingClients ? (
          <div className="h-40 flex items-center justify-center text-sm text-ink-3">Загрузка…</div>
        ) : (
          <div className="h-40 overflow-y-auto rounded border border-border bg-surface-subtle">
            {filtered.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-ink-3">
                {search.trim() ? "Клиенты не найдены" : "Нет доступных клиентов"}
              </div>
            ) : (
              filtered.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedId(c.id)}
                  className={[
                    "w-full px-3 py-2 text-left text-sm transition-colors",
                    selectedId === c.id
                      ? "bg-accent-soft text-accent font-medium"
                      : "text-ink hover:bg-surface",
                  ].join(" ")}
                >
                  {c.name}
                </button>
              ))
            )}
          </div>
        )}

        {error && <p className="mt-2 text-xs text-rose">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="rounded border border-border px-4 py-2 text-sm text-ink-2 hover:bg-surface-soft disabled:opacity-50"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={disabled}
            className="rounded bg-accent px-4 py-2 text-sm text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {loading ? "Сохраняю…" : "Сменить клиента"}
          </button>
        </div>
      </div>
    </div>
  );
}
