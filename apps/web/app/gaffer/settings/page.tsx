"use client";

import { useEffect, useState } from "react";
import {
  listPaymentMethods,
  createPaymentMethod,
  updatePaymentMethod,
  deletePaymentMethod,
  GafferApiError,
  type GafferPaymentMethod,
} from "../../../src/lib/gafferApi";
import { toast } from "../../../src/components/ToastProvider";

function PaymentMethodRow({
  method,
  onUpdate,
  onDelete,
}: {
  method: GafferPaymentMethod;
  onUpdate: (id: string, data: { name?: string; isDefault?: boolean }) => Promise<void>;
  onDelete: (id: string, name: string) => void;
}) {
  const [name, setName] = useState(method.name);
  const [saving, setSaving] = useState(false);

  async function handleBlur() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === method.name) {
      setName(method.name);
      return;
    }
    setSaving(true);
    try {
      await onUpdate(method.id, { name: trimmed });
    } catch {
      setName(method.name);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-center gap-3 py-3 border-b border-border last:border-b-0">
      {/* Default radio */}
      <button
        type="button"
        onClick={() => onUpdate(method.id, { isDefault: true })}
        aria-label={method.isDefault ? "По умолчанию" : "Сделать по умолчанию"}
        className={`w-4 h-4 rounded-full border-2 shrink-0 transition-colors ${
          method.isDefault
            ? "bg-accent-bright border-accent-bright"
            : "bg-surface border-border hover:border-accent-border"
        }`}
      />

      {/* Name input */}
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={handleBlur}
        disabled={saving}
        className="flex-1 min-w-0 px-[9px] py-[7px] border border-transparent rounded text-[13px] text-ink bg-transparent hover:border-border focus:border-accent-bright focus:outline-none focus:ring-1 focus:ring-accent-border transition-colors disabled:opacity-60"
      />

      {/* Default badge */}
      {method.isDefault && (
        <span
          className="text-[10px] font-semibold text-accent-bright bg-accent-soft border border-accent-border px-2 py-0.5 rounded-full shrink-0"
          style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
        >
          По умолчанию
        </span>
      )}

      {/* Delete */}
      <button
        type="button"
        onClick={() => onDelete(method.id, method.name)}
        aria-label={`Удалить ${method.name}`}
        className="text-ink-3 hover:text-rose transition-colors text-[14px] shrink-0 w-7 h-7 flex items-center justify-center rounded"
      >
        ✕
      </button>
    </div>
  );
}

export default function GafferSettingsPage() {
  const [methods, setMethods] = useState<GafferPaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);

  // New method form
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  function load() {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await listPaymentMethods();
        if (!cancelled) setMethods(res.items);
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }

  useEffect(() => load(), []);

  async function handleUpdate(id: string, data: { name?: string; isDefault?: boolean }) {
    try {
      const res = await updatePaymentMethod(id, data);
      if (data.isDefault) {
        // Re-fetch to get correct server ordering (isDefault desc → sortOrder asc → name asc)
        load();
      } else {
        setMethods((prev) => prev.map((m) => m.id === id ? res.paymentMethod : m));
      }
    } catch (err) {
      if (err instanceof GafferApiError && err.code === "PAYMENT_METHOD_NAME_TAKEN") {
        toast.error("Метод с таким названием уже существует");
      } else {
        toast.error(err instanceof GafferApiError ? err.message : "Ошибка обновления");
      }
      throw err;
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setCreateError(null);
    setCreating(true);
    try {
      const res = await createPaymentMethod({ name });
      setMethods((prev) => [...prev, res.paymentMethod]);
      setNewName("");
      toast.success("Метод добавлен");
    } catch (err) {
      if (err instanceof GafferApiError && err.code === "PAYMENT_METHOD_NAME_TAKEN") {
        setCreateError("Метод с таким названием уже существует");
      } else {
        toast.error(err instanceof GafferApiError ? err.message : "Ошибка");
      }
    } finally {
      setCreating(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      await deletePaymentMethod(deleteTarget.id);
      setMethods((prev) => prev.filter((m) => m.id !== deleteTarget.id));
      toast.success("Метод удалён");
      setDeleteTarget(null);
    } catch (err) {
      toast.error(err instanceof GafferApiError ? err.message : "Ошибка удаления");
    } finally {
      setDeleteLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-surface">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-border">
        <h1 className="text-[17px] font-semibold text-ink">Настройки</h1>
      </div>

      {/* Payment methods section */}
      <div className="px-4 py-4">
        <p
          className="text-[11px] text-ink-3 font-semibold tracking-[0.08em] uppercase mb-3"
          style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
        >
          Способы оплаты
        </p>

        {loading ? (
          <div className="space-y-3 animate-pulse">
            {[1, 2, 3].map((n) => (
              <div key={n} className="h-10 bg-border rounded" />
            ))}
          </div>
        ) : methods.length === 0 ? (
          <p className="text-[13px] text-ink-3 mb-3">Нет способов оплаты</p>
        ) : (
          <div className="border border-border rounded-lg overflow-hidden bg-surface">
            {methods.map((m) => (
              <div key={m.id} className="px-3">
                <PaymentMethodRow
                  method={m}
                  onUpdate={handleUpdate}
                  onDelete={(id, name) => setDeleteTarget({ id, name })}
                />
              </div>
            ))}
          </div>
        )}

        {/* Add new */}
        <form onSubmit={handleCreate} className="mt-3 pt-3 border-t border-dashed border-border">
          <div className="flex gap-2">
            <input
              value={newName}
              onChange={(e) => { setNewName(e.target.value); setCreateError(null); }}
              placeholder="Название (напр. Сбер, Наличные)"
              className={`flex-1 px-[11px] py-[9px] border rounded text-[13.5px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright ${
                createError ? "border-rose-border" : "border-border"
              }`}
            />
            <button
              type="submit"
              disabled={creating || !newName.trim()}
              aria-label="Добавить способ оплаты"
              className="bg-accent-bright hover:bg-accent text-white font-medium rounded px-4 py-[9px] text-[13px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            >
              {creating ? "…" : "+ Добавить"}
            </button>
          </div>
          {createError && (
            <p className="text-rose text-[11.5px] mt-1">{createError}</p>
          )}
        </form>
      </div>

      {/* Delete confirm modal */}
      {deleteTarget && (
        <div
          className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setDeleteTarget(null); }}
        >
          <div className="bg-surface rounded-lg shadow-xl p-5 w-full max-w-sm">
            <h3 className="text-[15px] font-semibold text-ink mb-2">Удалить способ оплаты?</h3>
            <p className="text-[13px] text-ink-2 mb-5">
              Вы собираетесь удалить <span className="font-medium text-ink">«{deleteTarget.name}»</span>.
            </p>
            <div className="flex gap-2">
              <button
                onClick={confirmDelete}
                disabled={deleteLoading}
                className="flex-1 bg-rose hover:bg-rose/90 text-white font-medium rounded px-4 py-2.5 text-[13px] disabled:opacity-50"
              >
                {deleteLoading ? "Удаляем…" : "Удалить"}
              </button>
              <button
                onClick={() => setDeleteTarget(null)}
                className="flex-1 bg-surface border border-border text-ink rounded px-4 py-2.5 text-[13px] hover:bg-[#fafafa]"
              >
                Отменить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
