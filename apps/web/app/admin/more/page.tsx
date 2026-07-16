"use client";
import React, { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import { useRequireRole } from "@/hooks/useRequireRole";
import { AdminTabNav } from "@/components/admin/AdminTabNav";

// ── Workers tab ───────────────────────────────────────────────────────────────

type Worker = {
  id: string;
  name: string;
  isActive: boolean;
  lastLoginAt: string | null;
  failedAttempts: number;
  lockedUntil: string | null;
  createdAt: string;
};

function WorkersTab() {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add worker form
  const [newName, setNewName] = useState("");
  const [newPin, setNewPin] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [addLoading, setAddLoading] = useState(false);

  // PIN reset
  const [resetPinId, setResetPinId] = useState<string | null>(null);
  const [resetPinValue, setResetPinValue] = useState("");
  const [resetPinError, setResetPinError] = useState<string | null>(null);
  const [resetPinLoading, setResetPinLoading] = useState(false);

  // Delete confirm
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function loadWorkers() {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{ workers: Worker[] }>("/api/warehouse/workers");
      setWorkers(data.workers);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка загрузки");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadWorkers();
  }, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim() || newPin.length !== 4) {
      setAddError("Введите имя и 4-значный PIN");
      return;
    }
    setAddLoading(true);
    setAddError(null);
    try {
      await apiFetch("/api/warehouse/workers", {
        method: "POST",
        body: JSON.stringify({ name: newName.trim(), pin: newPin }),
      });
      setNewName("");
      setNewPin("");
      await loadWorkers();
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "Ошибка добавления");
    } finally {
      setAddLoading(false);
    }
  }

  async function handleToggleActive(worker: Worker) {
    try {
      await apiFetch(`/api/warehouse/workers/${worker.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !worker.isActive }),
      });
      await loadWorkers();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка обновления");
    }
  }

  async function handleResetPin(id: string) {
    if (resetPinValue.length !== 4) {
      setResetPinError("PIN должен быть 4-значным");
      return;
    }
    setResetPinLoading(true);
    setResetPinError(null);
    try {
      await apiFetch(`/api/warehouse/workers/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ pin: resetPinValue }),
      });
      setResetPinId(null);
      setResetPinValue("");
      await loadWorkers();
    } catch (e) {
      setResetPinError(e instanceof Error ? e.message : "Ошибка смены PIN");
    } finally {
      setResetPinLoading(false);
    }
  }

  async function handleDelete(id: string) {
    setDeleteLoading(true);
    setDeleteError(null);
    try {
      await apiFetch(`/api/warehouse/workers/${id}`, { method: "DELETE" });
      setDeleteId(null);
      await loadWorkers();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Ошибка удаления");
    } finally {
      setDeleteLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <h3 className="text-sm font-semibold text-ink">Кладовщики</h3>

      {/* Add worker form */}
      <form onSubmit={handleAdd} className="border border-border rounded-xl p-4 space-y-3 bg-surface">
        <p className="text-xs font-semibold text-ink-2 uppercase tracking-wider">Добавить кладовщика</p>
        <div className="flex gap-3 flex-wrap">
          <input
            type="text"
            placeholder="Имя"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="rounded border border-border px-3 py-2 text-sm bg-surface flex-1 min-w-[140px]"
          />
          <input
            type="text"
            placeholder="PIN (4 цифры)"
            value={newPin}
            maxLength={4}
            onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ""))}
            className="rounded border border-border px-3 py-2 text-sm bg-surface w-[120px]"
          />
          <button
            type="submit"
            disabled={addLoading}
            className="rounded bg-accent text-white px-4 py-2 text-sm hover:bg-accent-bright disabled:opacity-50"
          >
            {addLoading ? "..." : "Добавить"}
          </button>
        </div>
        {addError && <p className="text-xs text-rose">{addError}</p>}
      </form>

      {/* Workers list */}
      {loading && <p className="text-sm text-ink-3">Загрузка...</p>}
      {error && <p className="text-sm text-rose">{error}</p>}

      {/* Desktop table */}
      {!loading && workers.length > 0 && (
        <div className="hidden md:block border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface text-ink-2 text-xs">
              <tr>
                <th className="text-left px-4 py-3">Имя</th>
                <th className="text-left px-3 py-3">Статус</th>
                <th className="text-left px-3 py-3">Последний вход</th>
                <th className="text-left px-3 py-3">Попытки</th>
                <th className="text-left px-3 py-3">Блокировка</th>
                <th className="px-3 py-3 text-right">Действия</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {workers.map((w) => (
                <tr key={w.id} className="hover:bg-surface">
                  <td className="px-4 py-3 font-medium text-ink">{w.name}</td>
                  <td className="px-3 py-3">
                    {w.isActive ? (
                      <span className="inline-flex items-center rounded border px-2 py-0.5 text-xs bg-emerald-soft text-emerald border-emerald-border">Активен</span>
                    ) : (
                      <span className="inline-flex items-center rounded border px-2 py-0.5 text-xs bg-surface-muted text-ink-2 border-border">Отключён</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-ink-2 text-xs">
                    {w.lastLoginAt ? new Date(w.lastLoginAt).toLocaleString("ru-RU") : "—"}
                  </td>
                  <td className="px-3 py-3 text-ink-2">{w.failedAttempts}</td>
                  <td className="px-3 py-3 text-xs">
                    {w.lockedUntil ? (
                      <span className="text-rose">{new Date(w.lockedUntil).toLocaleString("ru-RU")}</span>
                    ) : (
                      <span className="text-ink-3">—</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => handleToggleActive(w)}
                        className="text-xs rounded border border-border px-2 py-1 text-ink-2 hover:bg-surface"
                      >
                        {w.isActive ? "Отключить" : "Включить"}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setResetPinId(w.id); setResetPinValue(""); setResetPinError(null); }}
                        className="text-xs rounded border border-border px-2 py-1 text-ink-2 hover:bg-surface"
                      >
                        Сменить PIN
                      </button>
                      <button
                        type="button"
                        onClick={() => { setDeleteId(w.id); setDeleteError(null); }}
                        className="text-xs rounded border border-rose-border px-2 py-1 text-rose hover:bg-rose-soft"
                      >
                        Удалить
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Mobile cards */}
      {!loading && workers.length > 0 && (
        <div className="md:hidden space-y-3">
          {workers.map((w) => (
            <div key={w.id} className="rounded-xl border border-border bg-surface p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium text-ink">{w.name}</span>
                {w.isActive ? (
                  <span className="inline-flex items-center rounded border px-2 py-0.5 text-xs bg-emerald-soft text-emerald border-emerald-border">Активен</span>
                ) : (
                  <span className="inline-flex items-center rounded border px-2 py-0.5 text-xs bg-surface-muted text-ink-2 border-border">Отключён</span>
                )}
              </div>
              <p className="text-xs text-ink-3 mb-1">
                Последний вход: {w.lastLoginAt ? new Date(w.lastLoginAt).toLocaleString("ru-RU") : "—"}
              </p>
              <p className="text-xs text-ink-3 mb-1">Неудачных попыток: {w.failedAttempts}</p>
              {w.lockedUntil && (
                <p className="text-xs text-rose mb-1">Заблокирован до: {new Date(w.lockedUntil).toLocaleString("ru-RU")}</p>
              )}
              <div className="flex gap-2 flex-wrap mt-3">
                <button
                  type="button"
                  onClick={() => handleToggleActive(w)}
                  className="text-xs rounded border border-border px-2 py-1.5 text-ink-2 hover:bg-surface"
                >
                  {w.isActive ? "Отключить" : "Включить"}
                </button>
                <button
                  type="button"
                  onClick={() => { setResetPinId(w.id); setResetPinValue(""); setResetPinError(null); }}
                  className="text-xs rounded border border-border px-2 py-1.5 text-ink-2 hover:bg-surface"
                >
                  Сменить PIN
                </button>
                <button
                  type="button"
                  onClick={() => { setDeleteId(w.id); setDeleteError(null); }}
                  className="text-xs rounded border border-rose-border px-2 py-1.5 text-rose hover:bg-rose-soft"
                >
                  Удалить
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && workers.length === 0 && !error && (
        <p className="text-sm text-ink-3 py-6 text-center border border-border rounded-xl">
          Кладовщики не добавлены
        </p>
      )}

      {/* Reset PIN modal */}
      {resetPinId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-xs bg-surface rounded-2xl border border-border shadow-lg p-6">
            <h2 className="text-base font-semibold text-ink mb-4">Сменить PIN</h2>
            <input
              type="text"
              placeholder="Новый PIN (4 цифры)"
              value={resetPinValue}
              maxLength={4}
              onChange={(e) => setResetPinValue(e.target.value.replace(/\D/g, ""))}
              className="w-full rounded border border-border px-3 py-2 text-sm mb-3"
            />
            {resetPinError && <p className="text-xs text-rose mb-3">{resetPinError}</p>}
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setResetPinId(null)}
                className="rounded border border-border px-4 py-2 text-sm text-ink-2 hover:bg-surface"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => handleResetPin(resetPinId)}
                disabled={resetPinLoading}
                className="rounded bg-accent text-white px-4 py-2 text-sm hover:bg-accent-bright disabled:opacity-50"
              >
                {resetPinLoading ? "..." : "Сохранить"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-xs bg-surface rounded-2xl border border-border shadow-lg p-6">
            <h2 className="text-base font-semibold text-ink mb-2">Удалить кладовщика?</h2>
            <p className="text-sm text-ink-2 mb-4">
              {workers.find((w) => w.id === deleteId)?.name}
            </p>
            {deleteError && <p className="text-xs text-rose mb-3">{deleteError}</p>}
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setDeleteId(null)}
                className="rounded border border-border px-4 py-2 text-sm text-ink-2 hover:bg-surface"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => handleDelete(deleteId)}
                disabled={deleteLoading}
                className="rounded bg-rose text-white px-4 py-2 text-sm hover:bg-rose/90 disabled:opacity-50"
              >
                {deleteLoading ? "..." : "Удалить"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

// Каталог, Импорт оборудования и Прайслист бота переехали в /settings/organization
// (табовый хаб настроек). Здесь остаётся только управление кладовщиками (PIN-доступ
// к киоску), потому что это управление персоналом склада, а не настройка.
export default function AdminMorePage() {
  useRequireRole(["SUPER_ADMIN"]);

  return (
    <div className="p-4 md:p-6 max-w-5xl">
      <AdminTabNav />
      <div className="mt-4 mb-5">
        <h1 className="text-xl font-semibold tracking-tight text-ink">Кладовщики</h1>
        <p className="text-sm text-ink-2 mt-1">
          PIN-доступ к киоску выдачи и возврата на складе.
        </p>
      </div>

      <div className="bg-surface rounded-lg border border-border p-6 shadow-xs">
        <WorkersTab />
      </div>
    </div>
  );
}
