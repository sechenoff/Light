"use client";

/**
 * ClientPickerPopover — выпадающий пикер клиента, открываемый из любой ячейки.
 *
 * Используется в /bookings (inline-смена клиента на броне) и потенциально
 * в других местах, где нужен быстрый выбор/создание клиента без полноразмерной
 * модалки.
 *
 * - Серверный поиск с debounce 250ms (тот же endpoint, что в ChangeClientModal).
 * - При вводе ≥2 символов и отсутствии точного совпадения — кнопка
 *   «+ Создать клиента "X"» (одним кликом создаёт + назначает на бронь).
 * - Anchored через @floating-ui/react: автопозиционирование, click-outside,
 *   Esc-dismiss, focus management.
 */

import { useEffect, useRef, useState } from "react";
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  useClick,
  useDismiss,
  useRole,
  useInteractions,
  FloatingFocusManager,
  FloatingPortal,
} from "@floating-ui/react";
import { apiFetch } from "../../lib/api";
import { toast } from "../ToastProvider";

interface ClientOption {
  id: string;
  name: string;
}

/**
 * Render-prop API: компонент-анкор сам решает, как себя рендерить.
 * Мы передаём `ref` и общий bag интерактивных пропсов (от useInteractions).
 * Тип специально опечатан как Record<string, unknown> + ref, т.к.
 * @floating-ui/react возвращает множество хэндлеров (onClick, onPointerDown,
 * onKeyDown…), и перечислять их все статически нет смысла.
 */
type TriggerProps = {
  ref: (node: HTMLElement | null) => void;
} & Record<string, unknown>;

interface Props {
  bookingId: string;
  currentClientId: string;
  currentClientName: string;
  /** Вызывается с новым клиентом после успешной смены/создания.
   *  Используется для оптимистичного обновления списка вверх по дереву. */
  onAssigned: (client: ClientOption) => void;
  /** Render-prop: компонент-анкор (обычно <button>) с переданными trigger-пропсами. */
  children: (props: TriggerProps) => React.ReactNode;
}

const SEARCH_DEBOUNCE_MS = 200;
const INITIAL_LIMIT = 40;
const SEARCH_LIMIT = 25;

export function ClientPickerPopover({
  bookingId,
  currentClientId,
  currentClientName,
  onAssigned,
  children,
}: Props) {
  const [open, setOpen] = useState(false);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [search, setSearch] = useState("");
  const [fetchingClients, setFetchingClients] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: (next) => {
      setOpen(next);
      if (!next) {
        // Сброс при закрытии — следующее открытие чистое
        setSearch("");
        setError(null);
        setClients([]);
      }
    },
    placement: "bottom-start",
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  const click = useClick(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: "dialog" });
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role]);

  // Загрузка клиентов с дебаунсом при открытом popover.
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
          setError(e instanceof Error ? e.message : "Не удалось загрузить");
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

  const trimmedSearch = search.trim();
  const hasExactMatch = clients.some(
    (c) => c.name.toLowerCase() === trimmedSearch.toLowerCase(),
  );
  const canCreate = trimmedSearch.length >= 2 && !hasExactMatch && !busy;

  async function assignClient(client: ClientOption): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/bookings/${bookingId}/change-client`, {
        method: "POST",
        body: JSON.stringify({ clientId: client.id }),
      });
      toast.success(`Клиент изменён на «${client.name}»`);
      onAssigned(client);
      setOpen(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось сменить клиента");
    } finally {
      setBusy(false);
    }
  }

  async function createAndAssign(): Promise<void> {
    if (!canCreate || !trimmedSearch) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ client: ClientOption }>("/api/clients", {
        method: "POST",
        body: JSON.stringify({ name: trimmedSearch }),
      });
      const created = res.client;
      // Сразу назначаем созданного клиента на бронь.
      await apiFetch(`/api/bookings/${bookingId}/change-client`, {
        method: "POST",
        body: JSON.stringify({ clientId: created.id }),
      });
      toast.success(`Клиент «${created.name}» создан и назначен`);
      onAssigned(created);
      setOpen(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось создать клиента");
    } finally {
      setBusy(false);
    }
  }

  // refs.setReference и getReferenceProps типизированы для абстрактного
  // ReferenceType — мы знаем, что наш анкор всегда HTMLElement, так что cast OK.
  const triggerProps: TriggerProps = {
    ref: refs.setReference as (node: HTMLElement | null) => void,
    ...getReferenceProps({
      onClick: (e: React.MouseEvent) => {
        // Не пускаем клик дальше — чтобы не активировать поведение строки.
        e.stopPropagation();
      },
    }),
    "aria-expanded": open,
    "aria-haspopup": "dialog",
  };

  return (
    <>
      {children(triggerProps)}

      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} initialFocus={searchInputRef} modal={false}>
            <div
              ref={refs.setFloating}
              style={floatingStyles}
              {...getFloatingProps()}
              className="z-50 w-72 rounded-lg border border-border bg-surface shadow-lg"
            >
              <div className="border-b border-border px-3 py-2">
                <p className="eyebrow mb-0.5">Сменить клиента</p>
                <p className="text-[11px] text-ink-3 truncate">
                  Сейчас: <span className="text-ink-2">{currentClientName}</span>
                </p>
              </div>

              <div className="p-2">
                <input
                  ref={searchInputRef}
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  disabled={busy}
                  placeholder="Имя клиента…"
                  className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm text-ink focus:border-accent focus:outline-none disabled:opacity-50"
                />
              </div>

              <div className="max-h-56 overflow-y-auto border-t border-border bg-surface-subtle">
                {fetchingClients ? (
                  <div className="px-3 py-4 text-center text-xs text-ink-3">Загрузка…</div>
                ) : clients.length === 0 ? (
                  <div className="px-3 py-4 text-center text-xs text-ink-3">
                    {trimmedSearch
                      ? "Совпадений нет"
                      : "Введите имя или создайте нового"}
                  </div>
                ) : (
                  clients.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => void assignClient(c)}
                      disabled={busy}
                      className="block w-full px-3 py-1.5 text-left text-sm text-ink hover:bg-surface transition-colors disabled:opacity-50"
                    >
                      {c.name}
                    </button>
                  ))
                )}
              </div>

              {canCreate && (
                <button
                  type="button"
                  onClick={() => void createAndAssign()}
                  disabled={busy}
                  className="block w-full border-t border-dashed border-accent-border bg-accent-soft px-3 py-2 text-left text-sm text-accent hover:bg-accent-soft/80 transition-colors disabled:opacity-50"
                >
                  {busy ? `Создаю…` : `+ Создать «${trimmedSearch}» и назначить`}
                </button>
              )}

              {error && (
                <p className="border-t border-border bg-rose-soft px-3 py-2 text-xs text-rose">
                  {error}
                </p>
              )}
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}
