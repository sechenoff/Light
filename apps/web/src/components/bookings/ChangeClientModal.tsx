"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import { toast } from "../ToastProvider";

interface ClientOption {
  id: string;
  name: string;
}

interface Props {
  open: boolean;
  currentClientId: string;
  currentClientName: string;
  onClose: () => void;
  onSuccess: () => void;
  bookingId: string;
}

const SEARCH_DEBOUNCE_MS = 250;
const INITIAL_LIMIT = 50;
const SEARCH_LIMIT = 30;

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
  const [submitting, setSubmitting] = useState(false);
  const [fetchingClients, setFetchingClients] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Reset on open/close.
  useEffect(() => {
    if (!open) {
      setSearch("");
      setSelectedId("");
      setError(null);
      setClients([]);
      return;
    }
    setTimeout(() => searchRef.current?.focus(), 50);
  }, [open]);

  // Debounced server-side search.
  useEffect(() => {
    if (!open) return;

    const trimmed = search.trim();
    const timer = window.setTimeout(() => {
      let cancelled = false;
      setFetchingClients(true);
      setError(null);

      const params = new URLSearchParams();
      if (trimmed) {
        params.set("search", trimmed);
        params.set("limit", String(SEARCH_LIMIT));
      } else {
        params.set("limit", String(INITIAL_LIMIT));
      }

      apiFetch<{ clients: ClientOption[] }>(`/api/clients?${params.toString()}`)
        .then((data) => {
          if (cancelled) return;
          setClients(data.clients.filter((c) => c.id !== currentClientId));
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          const message = e instanceof Error ? e.message : "Не удалось загрузить список клиентов";
          setError(message);
          setClients([]);
        })
        .finally(() => {
          if (!cancelled) setFetchingClients(false);
        });

      return () => {
        cancelled = true;
      };
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [open, search, currentClientId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting && !creating) {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !root.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, submitting, creating, onClose]);

  if (!open) return null;

  const trimmedSearch = search.trim();
  // Покажем «+ Создать клиента» если введено ≥2 символа и среди подгруженных
  // совпадений нет точного (без учёта регистра). Это позволяет создать нового
  // клиента сразу из модалки, не уходя в отдельный экран.
  const hasExactMatch = clients.some(
    (c) => c.name.toLowerCase() === trimmedSearch.toLowerCase(),
  );
  const canCreate = trimmedSearch.length >= 2 && !hasExactMatch;

  const confirmDisabled = submitting || creating || !selectedId;

  async function handleConfirm(): Promise<void> {
    if (!selectedId) return;
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch(`/api/bookings/${bookingId}/change-client`, {
        method: "POST",
        body: JSON.stringify({ clientId: selectedId }),
      });
      toast.success("Клиент изменён");
      onSuccess();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Не удалось сменить клиента";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCreate(): Promise<void> {
    if (!canCreate || !trimmedSearch) return;
    setError(null);
    setCreating(true);
    try {
      const res = await apiFetch<{ client: ClientOption }>("/api/clients", {
        method: "POST",
        body: JSON.stringify({ name: trimmedSearch }),
      });
      // Сразу переключаемся на нового клиента и подтверждаем смену.
      const newClient = res.client;
      setClients((prev) => [newClient, ...prev]);
      setSelectedId(newClient.id);
      setSearch(newClient.name);
      toast.success(`Клиент «${newClient.name}» создан`);

      // Сразу применяем смену — пользователь редко хочет создать и не назначить.
      try {
        await apiFetch(`/api/bookings/${bookingId}/change-client`, {
          method: "POST",
          body: JSON.stringify({ clientId: newClient.id }),
        });
        toast.success("Клиент назначен на бронь");
        onSuccess();
      } catch (assignErr: unknown) {
        const message =
          assignErr instanceof Error ? assignErr.message : "Не удалось назначить клиента на бронь";
        setError(message);
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Не удалось создать клиента";
      setError(message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 px-4"
      onClick={() => !submitting && !creating && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Сменить клиента"
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
          disabled={submitting || creating}
          placeholder="Поиск по имени…"
          className="mb-2 w-full rounded border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none disabled:opacity-50"
        />

        {fetchingClients ? (
          <div className="h-40 flex items-center justify-center text-sm text-ink-3">Загрузка…</div>
        ) : (
          <div className="h-40 overflow-y-auto rounded border border-border bg-surface-subtle">
            {clients.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-ink-3 px-3 text-center">
                {trimmedSearch
                  ? `Клиент «${trimmedSearch}» не найден — создайте нового кнопкой ниже`
                  : "Начните ввод имени"}
              </div>
            ) : (
              clients.map((c) => (
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

        {/* Inline-создание нового клиента: появляется, как только введено ≥2 символа
            и среди совпадений нет точного. Создаёт клиента + сразу назначает на бронь. */}
        {canCreate && (
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating || submitting}
            className="mt-2 w-full rounded border border-dashed border-accent-border bg-accent-soft px-3 py-2 text-sm text-accent hover:bg-accent-soft/80 disabled:opacity-50 transition-colors text-left"
          >
            {creating
              ? `Создаю «${trimmedSearch}»…`
              : `+ Создать нового клиента «${trimmedSearch}» и назначить на бронь`}
          </button>
        )}

        {error && <p className="mt-2 text-xs text-rose">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting || creating}
            className="rounded border border-border px-4 py-2 text-sm text-ink-2 hover:bg-surface-soft disabled:opacity-50"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={confirmDisabled}
            className="rounded bg-accent px-4 py-2 text-sm text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {submitting ? "Сохраняю…" : "Сменить клиента"}
          </button>
        </div>
      </div>
    </div>
  );
}
