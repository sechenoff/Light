"use client";

import { useEffect, useRef, useState } from "react";
import { SectionHeader } from "../../../src/components/SectionHeader";
import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { apiFetch } from "../../../src/lib/api";
import { toast } from "../../../src/components/ToastProvider";

type Client = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  comment: string | null;
  bookingCount: number;
  createdAt: string;
};

// ─── Modal ──────────────────────────────────────────────────────────────────

type ClientModalProps = {
  open: boolean;
  mode: "create" | "edit";
  initial?: Partial<Client>;
  onClose: () => void;
  onSaved: () => void;
};

function ClientModal({ open, mode, initial = {}, onClose, onSaved }: ClientModalProps) {
  const [name, setName] = useState(initial.name ?? "");
  const [phone, setPhone] = useState(initial.phone ?? "");
  const [email, setEmail] = useState(initial.email ?? "");
  const [comment, setComment] = useState(initial.comment ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName(initial.name ?? "");
      setPhone(initial.phone ?? "");
      setEmail(initial.email ?? "");
      setComment(initial.comment ?? "");
      setError(null);
      setTimeout(() => nameRef.current?.focus(), 50);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !loading) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, loading, onClose]);

  if (!open) return null;

  const handleSave = async () => {
    if (!name.trim()) {
      setError("Имя клиента обязательно");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      if (mode === "create") {
        await apiFetch("/api/clients", {
          method: "POST",
          body: JSON.stringify({ name: name.trim(), phone: phone.trim() || undefined, email: email.trim() || undefined, comment: comment.trim() || undefined }),
        });
        toast.success("Клиент создан");
      } else {
        await apiFetch(`/api/clients/${initial.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name: name.trim(), phone: phone.trim() || undefined, email: email.trim() || undefined, comment: comment.trim() || undefined }),
        });
        toast.success("Клиент обновлён");
      }
      onSaved();
    } catch (e: any) {
      setError(e?.message ?? "Ошибка при сохранении");
    } finally {
      setLoading(false);
    }
  };

  const title = mode === "create" ? "Новый клиент" : "Редактировать клиента";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 px-4"
      onClick={() => !loading && onClose()}
      aria-modal="true"
      role="dialog"
    >
      <div
        className="w-full max-w-md rounded-lg bg-surface p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[17px] font-semibold text-ink">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="text-ink-3 hover:text-ink disabled:opacity-50 text-xl leading-none"
            aria-label="Закрыть"
          >
            ×
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-[11.5px] text-ink-2 mb-1">
              Имя клиента <span className="text-rose">*</span>
            </label>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={loading}
              maxLength={200}
              className="w-full rounded border border-border px-3 py-2 text-[13.5px] text-ink bg-surface focus:outline-none focus:border-accent-bright focus:ring-[3px] focus:ring-accent-soft disabled:opacity-60"
              placeholder="Название компании / заказчика"
            />
          </div>

          <div>
            <label className="block text-[11.5px] text-ink-2 mb-1">Телефон</label>
            <input
              type="text"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={loading}
              maxLength={50}
              className="w-full rounded border border-border px-3 py-2 text-[13.5px] text-ink bg-surface focus:outline-none focus:border-accent-bright focus:ring-[3px] focus:ring-accent-soft disabled:opacity-60"
              placeholder="+7 999 000 00 00"
            />
          </div>

          <div>
            <label className="block text-[11.5px] text-ink-2 mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
              maxLength={200}
              className="w-full rounded border border-border px-3 py-2 text-[13.5px] text-ink bg-surface focus:outline-none focus:border-accent-bright focus:ring-[3px] focus:ring-accent-soft disabled:opacity-60"
              placeholder="client@example.com"
            />
          </div>

          <div>
            <label className="block text-[11.5px] text-ink-2 mb-1">Комментарий</label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              disabled={loading}
              rows={3}
              maxLength={1000}
              className="w-full rounded border border-border px-3 py-2 text-[13.5px] text-ink bg-surface focus:outline-none focus:border-accent-bright focus:ring-[3px] focus:ring-accent-soft disabled:opacity-60 resize-none"
              placeholder="Заметки о клиенте"
            />
          </div>

          {error && <p className="text-sm text-rose">{error}</p>}
        </div>

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
            onClick={handleSave}
            disabled={loading || !name.trim()}
            className="rounded bg-accent-bright px-4 py-2 text-sm text-white hover:bg-accent disabled:opacity-50"
          >
            {loading ? "Сохраняю…" : "Сохранить"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Delete Confirmation Modal ───────────────────────────────────────────────

type DeleteModalProps = {
  open: boolean;
  clientName: string;
  loading: boolean;
  onConfirm: () => void;
  onClose: () => void;
};

function DeleteConfirmModal({ open, clientName, loading, onConfirm, onClose }: DeleteModalProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // Auto-focus the primary action so Enter confirms (Esc cancels).
    setTimeout(() => confirmRef.current?.focus(), 50);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !loading) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, loading, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 px-4"
      onClick={() => !loading && onClose()}
      aria-modal="true"
      role="dialog"
      aria-labelledby="delete-client-title"
    >
      <div
        className="w-full max-w-md rounded-lg bg-surface p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="delete-client-title" className="text-[17px] font-semibold text-ink mb-2">
          Удалить клиента?
        </h2>
        <p className="text-[13.5px] text-ink-2 mb-5">
          Клиент <span className="font-medium text-ink">«{clientName}»</span> будет удалён навсегда.
          Это действие нельзя отменить.
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="rounded border border-border px-4 py-2 text-sm text-ink-2 hover:bg-surface-soft disabled:opacity-50"
          >
            Отмена
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className="rounded bg-rose px-4 py-2 text-sm text-white hover:bg-rose/90 disabled:opacity-50"
          >
            {loading ? "Удаляю…" : "Удалить"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function AdminClientsPage() {
  const { authorized, loading: authLoading } = useRequireRole(["SUPER_ADMIN"]);
  const [clients, setClients] = useState<Client[]>([]);
  const [search, setSearch] = useState("");
  const [fetching, setFetching] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Client | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Client | null>(null);
  const [deleting, setDeleting] = useState(false);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchClients = async (q: string) => {
    setFetching(true);
    try {
      const params = q.trim() ? `?search=${encodeURIComponent(q.trim())}&limit=100` : "?limit=100";
      const data = await apiFetch<{ clients: Client[] }>(`/api/clients${params}`);
      setClients(data.clients);
    } catch (e: any) {
      toast.error(e?.message ?? "Ошибка при загрузке клиентов");
    } finally {
      setFetching(false);
    }
  };

  useEffect(() => {
    if (!authorized) return;
    void fetchClients(search);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorized]);

  const handleSearchChange = (v: string) => {
    setSearch(v);
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => {
      void fetchClients(v);
    }, 200);
  };

  const requestDelete = (client: Client) => {
    setDeleteTarget(client);
  };

  const cancelDelete = () => {
    if (deleting) return;
    setDeleteTarget(null);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/clients/${deleteTarget.id}`, { method: "DELETE" });
      toast.success("Клиент удалён");
      setDeleteTarget(null);
      void fetchClients(search);
    } catch (e: any) {
      if (e?.details === "CLIENT_HAS_BOOKINGS") {
        toast.error("У клиента есть брони — удаление невозможно");
      } else {
        toast.error(e?.message ?? "Ошибка при удалении");
      }
    } finally {
      setDeleting(false);
    }
  };

  const openCreate = () => {
    setEditTarget(null);
    setModalOpen(true);
  };

  const openEdit = (client: Client) => {
    setEditTarget(client);
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditTarget(null);
  };

  const handleSaved = () => {
    closeModal();
    void fetchClients(search);
  };

  if (authLoading) {
    return (
      <div className="p-6">
        <div className="h-8 bg-surface-muted rounded animate-pulse w-48 mb-4" />
        <div className="h-4 bg-surface-muted rounded animate-pulse w-full mb-2" />
      </div>
    );
  }

  if (!authorized) return null;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <SectionHeader
        eyebrow="Администрирование"
        title="Клиенты"
        className="mb-5"
        actions={
          <button
            type="button"
            onClick={openCreate}
            className="rounded bg-accent-bright px-4 py-2 text-sm text-white hover:bg-accent"
          >
            + Добавить клиента
          </button>
        }
      />

      {/* Search */}
      <div className="mb-4">
        <input
          type="text"
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="Поиск по имени…"
          className="w-full max-w-sm rounded border border-border px-3 py-2 text-[13.5px] text-ink bg-surface focus:outline-none focus:border-accent-bright focus:ring-[3px] focus:ring-accent-soft"
        />
      </div>

      {/* Table */}
      <div className="bg-surface border border-border rounded-md shadow-xs overflow-hidden">
        {fetching ? (
          <div className="p-8 text-center text-ink-3 text-sm">Загружаю…</div>
        ) : clients.length === 0 ? (
          <div className="p-8 text-center text-ink-3 text-sm">
            {search.trim() ? "Ничего не найдено" : "Клиенты ещё не добавлены"}
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-border bg-surface-muted">
                <th className="px-4 py-2.5 text-left eyebrow text-ink-2">Имя</th>
                <th className="px-4 py-2.5 text-left eyebrow text-ink-2">Телефон</th>
                <th className="px-4 py-2.5 text-left eyebrow text-ink-2">Email</th>
                <th className="px-4 py-2.5 text-right eyebrow text-ink-2 tabular-nums">Броней</th>
                <th className="px-4 py-2.5 text-left eyebrow text-ink-2">Создан</th>
                <th className="px-4 py-2.5 text-right eyebrow text-ink-2">Действия</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((client) => (
                <tr
                  key={client.id}
                  className="border-b border-border last:border-0 hover:bg-surface-muted transition-colors"
                >
                  <td className="px-4 py-2.5 font-medium text-ink">{client.name}</td>
                  <td className="px-4 py-2.5 text-ink-2">{client.phone ?? "—"}</td>
                  <td className="px-4 py-2.5 text-ink-2">{client.email ?? "—"}</td>
                  <td className="px-4 py-2.5 text-right mono-num text-ink">{client.bookingCount}</td>
                  <td className="px-4 py-2.5 text-ink-3">
                    {new Date(client.createdAt).toLocaleDateString("ru-RU")}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => openEdit(client)}
                        className="p-1.5 rounded hover:bg-surface-soft text-ink-3 hover:text-ink transition-colors"
                        aria-label={`Редактировать клиента ${client.name}`}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        onClick={() => requestDelete(client)}
                        disabled={client.bookingCount > 0}
                        title={
                          client.bookingCount > 0
                            ? "Нельзя удалить клиента с активными бронями"
                            : undefined
                        }
                        className="p-1.5 rounded hover:bg-rose-soft text-ink-3 hover:text-rose transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                        aria-label={`Удалить клиента ${client.name}`}
                      >
                        🗑
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <ClientModal
        open={modalOpen}
        mode={editTarget ? "edit" : "create"}
        initial={editTarget ?? {}}
        onClose={closeModal}
        onSaved={handleSaved}
      />

      <DeleteConfirmModal
        open={deleteTarget !== null}
        clientName={deleteTarget?.name ?? ""}
        loading={deleting}
        onConfirm={confirmDelete}
        onClose={cancelDelete}
      />
    </div>
  );
}
