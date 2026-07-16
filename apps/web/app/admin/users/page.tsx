"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { apiFetch } from "@/lib/api";
import { useRequireRole } from "@/hooks/useRequireRole";
import { AdminTabNav } from "@/components/admin/AdminTabNav";
import { RoleBadge } from "@/components/RoleBadge";
import { SectionHeader } from "@/components/SectionHeader";
import { toast } from "@/components/ToastProvider";

// ── Types ─────────────────────────────────────────────────────────────────────

type UserRole = "SUPER_ADMIN" | "WAREHOUSE" | "TECHNICIAN";

type AdminUserRow = {
  id: string;
  username: string;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function roleLabel(role: UserRole): string {
  switch (role) {
    case "SUPER_ADMIN": return "Руководитель";
    case "WAREHOUSE": return "Кладовщик";
    case "TECHNICIAN": return "Техник";
  }
}

function getInitials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

// Роль-пилюли рендерит канонический <RoleBadge />; здесь только фон аватара.
const AVATAR_BG: Record<UserRole, string> = {
  SUPER_ADMIN: "bg-indigo",
  WAREHOUSE: "bg-teal",
  TECHNICIAN: "bg-amber",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AdminUsersPage() {
  const { authorized, loading: authLoading } = useRequireRole(["SUPER_ADMIN"]);

  const [users, setUsers] = useState<AdminUserRow[] | null>(null);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<UserRole>("WAREHOUSE");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [showNewPassword, setShowNewPassword] = useState(false);

  // Password change modal
  const [pwTarget, setPwTarget] = useState<{ id: string; username: string } | null>(null);

  // Search
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // Role change inline
  const [changingRoleId, setChangingRoleId] = useState<string | null>(null);
  const [pendingRole, setPendingRole] = useState<UserRole | null>(null);

  // Confirm modal (удаление / отключение доступа)
  const [confirmTarget, setConfirmTarget] = useState<{ kind: "delete" | "deactivate"; user: AdminUserRow } | null>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);

  // Единая точка загрузки списка. isCancelled — защита от setState после
  // unmount (используется только в маунт-эффекте).
  async function loadUsers(isCancelled: () => boolean = () => false) {
    setLoadingUsers(true);
    setError(null);
    try {
      const res = await apiFetch<{ users: AdminUserRow[] }>("/api/admin-users");
      if (!isCancelled()) setUsers(res.users);
    } catch (e) {
      if (!isCancelled()) setError(e instanceof Error ? e.message : "Ошибка загрузки");
    } finally {
      if (!isCancelled()) setLoadingUsers(false);
    }
  }

  useEffect(() => {
    if (!authorized) return;
    let cancelled = false;
    void loadUsers(() => cancelled);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorized]);

  // Хоткей «/» фокусирует поиск (kbd-бейдж рядом с полем это обещает).
  // Игнорируем нажатие, если фокус уже в поле ввода/textarea/select.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/") return;
      const el = document.activeElement;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setCreating(true);
    try {
      await apiFetch("/api/admin-users", {
        method: "POST",
        body: JSON.stringify({ username: newUsername.trim(), password: newPassword, role: newRole }),
      });
      setNewUsername("");
      setNewPassword("");
      setNewRole("WAREHOUSE");
      setShowNewPassword(false);
      setShowCreate(false);
      await loadUsers();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Ошибка создания");
    } finally {
      setCreating(false);
    }
  }

  // «Уволить»: реально работавшего сотрудника удалить нельзя (аудит-история),
  // поэтому основной сценарий — деактивация. Кнопка удаления остаётся для
  // никогда не работавших (без записей аудита).
  async function handleToggleActive(u: AdminUserRow) {
    if (u.isActive) {
      // Деструктивное действие — подтверждение через модалку, не window.confirm.
      setConfirmTarget({ kind: "deactivate", user: u });
      return;
    }
    try {
      await apiFetch(`/api/admin-users/${u.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: true }),
      });
      toast.success("Доступ включён");
      await loadUsers();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Ошибка");
    }
  }

  function handleDelete(u: AdminUserRow) {
    setConfirmTarget({ kind: "delete", user: u });
  }

  async function handleConfirmAction() {
    if (!confirmTarget) return;
    const { kind, user } = confirmTarget;
    setConfirmLoading(true);
    try {
      if (kind === "delete") {
        await apiFetch(`/api/admin-users/${user.id}`, { method: "DELETE" });
        toast.success("Пользователь удалён");
      } else {
        await apiFetch(`/api/admin-users/${user.id}`, {
          method: "PATCH",
          body: JSON.stringify({ isActive: false }),
        });
        toast.success("Доступ отключён");
      }
      setConfirmTarget(null);
      await loadUsers();
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if (kind === "delete" && code === "ADMIN_HAS_AUDIT_HISTORY") {
        toast.error("Нельзя удалить: у пользователя есть история действий. Деактивируйте вместо удаления");
      } else {
        toast.error(e instanceof Error ? e.message : "Ошибка");
      }
    } finally {
      setConfirmLoading(false);
    }
  }

  async function handleChangePassword(id: string, password: string) {
    await apiFetch(`/api/admin-users/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ password }),
    });
  }

  async function applyRoleChange(id: string, current: UserRole, next: UserRole) {
    if (current === "SUPER_ADMIN" && next !== "SUPER_ADMIN") {
      if (
        !window.confirm(
          `Понизить Руководителя до роли «${roleLabel(next)}»? Пользователь потеряет доступ к финансам и управлению пользователями.`
        )
      ) {
        setChangingRoleId(null);
        setPendingRole(null);
        return;
      }
    }
    try {
      await apiFetch(`/api/admin-users/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ role: next }),
      });
      await loadUsers();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setChangingRoleId(null);
      setPendingRole(null);
    }
  }

  if (authLoading) {
    return (
      <div className="p-6">
        <AdminTabNav />
        <div className="mt-6 space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-10 bg-surface-muted rounded animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (!authorized) return null;

  const filtered = (users ?? []).filter(
    (u) =>
      u.id !== "_system_" &&
      (search.trim() === "" ||
        u.username.toLowerCase().includes(search.toLowerCase()))
  );

  const roleCounts = (users ?? []).filter((u) => u.id !== "_system_").reduce(
    (acc, u) => {
      acc[u.role] = (acc[u.role] ?? 0) + 1;
      return acc;
    },
    {} as Partial<Record<UserRole, number>>
  );

  // admin-07: служебная запись _system_ не должна попадать в счётчики «Всего».
  const realUserCount = (users ?? []).filter((u) => u.id !== "_system_").length;

  return (
    <div className="p-6 space-y-6">
      {/* Бейдж счётчика не показываем, пока список ещё не загружен (иначе мигает «0»). */}
      <AdminTabNav counts={{ users: users === null ? undefined : realUserCount }} />

      {/* Header */}
      <div>
        <SectionHeader eyebrow="Администрирование" title="Пользователи" />
        <p className="text-sm text-ink-2 mt-1">
          Управление доступом к системе. Только Руководитель видит эту страницу.
        </p>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 text-sm select-none">⌕</span>
          <input
            ref={searchRef}
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по логину…"
            className="w-full pl-8 pr-10 py-2 text-sm border border-border rounded-lg bg-surface placeholder:text-ink-3 focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
          <kbd className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-ink-3 font-mono border border-border rounded px-1 hidden sm:block">
            /
          </kbd>
        </div>

        {/* Role count pills */}
        <div className="flex items-center gap-2">
          {(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"] as UserRole[]).map((role) => (
            <span key={role} className="inline-flex items-center gap-1">
              <RoleBadge role={role} />
              {roleCounts[role] !== undefined && (
                <span className="mono-num text-[11px] text-ink-3">{roleCounts[role]}</span>
              )}
            </span>
          ))}
        </div>

        {/* Add button */}
        <button
          onClick={() => setShowCreate((v) => !v)}
          className="ml-auto bg-accent-bright hover:bg-accent text-white font-medium rounded-lg px-4 py-2 text-sm transition-colors"
        >
          + Добавить пользователя
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <form
          onSubmit={handleCreate}
          className="bg-surface rounded-lg border border-border overflow-hidden"
        >
          <div className="px-4 py-3 bg-surface-muted border-b border-border">
            <span className="eyebrow">Новый пользователь</span>
          </div>
          <div className="p-4 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-ink-2 mb-1">Логин</label>
                <input
                  type="text"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  disabled={creating}
                  placeholder="ivan"
                  className="w-full px-3 py-2 border border-border rounded-lg text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-accent/30"
                  required
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-2 mb-1">Пароль</label>
                <div className="relative">
                  <input
                    type={showNewPassword ? "text" : "password"}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    disabled={creating}
                    placeholder="Минимум 3 символа"
                    className="w-full px-3 py-2 pr-16 border border-border rounded-lg text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-accent/30"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewPassword((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-ink-2 hover:text-ink"
                  >
                    {showNewPassword ? "Скрыть" : "Показать"}
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-2 mb-1">Роль</label>
                <select
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value as UserRole)}
                  disabled={creating}
                  className="w-full px-3 py-2 border border-border rounded-lg text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-accent/30"
                >
                  <option value="WAREHOUSE">Кладовщик</option>
                  <option value="TECHNICIAN">Техник</option>
                  <option value="SUPER_ADMIN">Руководитель</option>
                </select>
              </div>
            </div>
            {createError && (
              <div className="bg-rose-soft border border-rose-border text-rose text-xs rounded px-3 py-2">
                {createError}
              </div>
            )}
            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={creating || !newUsername || !newPassword}
                className="bg-accent-bright hover:bg-accent text-white font-medium rounded-lg px-4 py-2 text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {creating ? "Создаём…" : "Создать"}
              </button>
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="px-4 py-2 text-sm text-ink-2 hover:text-ink transition-colors"
              >
                Отмена
              </button>
            </div>
          </div>
        </form>
      )}

      {/* Error */}
      {error && (
        <div className="bg-rose-soft border border-rose-border text-rose text-sm rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {/* Table */}
      {loadingUsers ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 bg-surface-muted rounded-lg animate-pulse" />
          ))}
        </div>
      ) : filtered.length > 0 ? (
        <div className="border border-border rounded-lg overflow-x-auto shadow-xs">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-surface-muted">
              <tr>
                <th className="text-left px-4 py-2.5 eyebrow">Пользователь</th>
                <th className="text-left px-4 py-2.5 eyebrow">Роль</th>
                <th className="text-left px-4 py-2.5 eyebrow hidden md:table-cell">Создан</th>
                <th className="text-left px-4 py-2.5 eyebrow hidden lg:table-cell">Статус</th>
                <th className="text-right px-4 py-2.5 eyebrow">Действия</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((u) => {
                return (
                  <tr
                    key={u.id}
                    className={`hover:bg-surface-muted transition-colors ${u.isActive ? "" : "opacity-60"}`}
                  >
                    {/* Avatar + name */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-[30px] h-[30px] rounded flex items-center justify-center shrink-0 ${AVATAR_BG[u.role]}`}
                        >
                          <span className="font-mono text-[11px] font-bold text-white">
                            {getInitials(u.username)}
                          </span>
                        </div>
                        <div>
                          <div className="font-medium text-ink">{u.username}</div>
                          <div className="text-[11px] text-ink-3">{roleLabel(u.role)}</div>
                        </div>
                      </div>
                    </td>

                    {/* Role */}
                    <td className="px-4 py-3">
                      {changingRoleId === u.id ? (
                        <span className="inline-flex items-center gap-1">
                          <select
                            value={pendingRole ?? u.role}
                            onChange={(e) => setPendingRole(e.target.value as UserRole)}
                            className="text-xs border border-border rounded px-1 py-0.5 bg-surface"
                            autoFocus
                          >
                            <option value="WAREHOUSE">Кладовщик</option>
                            <option value="TECHNICIAN">Техник</option>
                            <option value="SUPER_ADMIN">Руководитель</option>
                          </select>
                          <button
                            onClick={() => applyRoleChange(u.id, u.role, pendingRole ?? u.role)}
                            className="text-xs text-accent hover:underline"
                          >
                            ОК
                          </button>
                          <button
                            onClick={() => {
                              setChangingRoleId(null);
                              setPendingRole(null);
                            }}
                            aria-label="Отмена смены роли"
                            className="text-xs text-ink-3 hover:underline"
                          >
                            ✕
                          </button>
                        </span>
                      ) : (
                        <RoleBadge role={u.role} />
                      )}
                    </td>

                    {/* Created */}
                    <td className="px-4 py-3 hidden md:table-cell">
                      <span className="mono-num text-xs text-ink-3">{formatDate(u.createdAt)}</span>
                    </td>

                    {/* Status — тумблер по реальному полю isActive */}
                    <td className="px-4 py-3 hidden lg:table-cell">
                      <button
                        onClick={() => handleToggleActive(u)}
                        title={u.isActive ? "Отключить доступ" : "Включить доступ"}
                        className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium border transition-colors ${
                          u.isActive
                            ? "bg-emerald-soft text-emerald border-emerald-border hover:bg-emerald-soft/70"
                            : "bg-surface-muted text-ink-3 border-border hover:bg-surface"
                        }`}
                      >
                        {u.isActive ? "● активен" : "○ отключён"}
                      </button>
                    </td>

                    {/* Actions */}
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => handleToggleActive(u)}
                          className="text-xs text-ink-2 hover:text-ink underline transition-colors lg:hidden py-2 px-2 -my-1"
                        >
                          {u.isActive ? "Отключить" : "Включить"}
                        </button>
                        <button
                          onClick={() => setPwTarget({ id: u.id, username: u.username })}
                          className="text-xs text-ink-2 hover:text-ink underline transition-colors py-2 px-2 -my-1"
                        >
                          Пароль
                        </button>
                        <button
                          onClick={() => {
                            setChangingRoleId(u.id);
                            setPendingRole(u.role);
                          }}
                          className="text-xs text-ink-2 hover:text-ink underline transition-colors py-2 px-2 -my-1"
                        >
                          Роль
                        </button>
                        <button
                          onClick={() => handleDelete(u)}
                          className="text-xs text-rose hover:text-rose/80 underline transition-colors py-2 px-2 -my-1"
                        >
                          Удалить
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-center py-12 text-ink-3 text-sm border border-border rounded-lg bg-surface">
          {search ? "Ничего не найдено" : "Пользователей пока нет"}
        </div>
      )}

      {/* Legend */}
      {users && users.length > 0 && (
        <div className="flex items-center gap-4 flex-wrap text-xs text-ink-3 pt-2 border-t border-border">
          <span>Всего: {realUserCount}</span>
          {(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"] as UserRole[]).map((role) =>
            roleCounts[role] ? (
              <span key={role}>
                {roleLabel(role)}: {roleCounts[role]}
              </span>
            ) : null
          )}
        </div>
      )}

      {pwTarget && (
        <ChangePasswordModal
          username={pwTarget.username}
          onClose={() => setPwTarget(null)}
          onSubmit={(password) => handleChangePassword(pwTarget.id, password)}
        />
      )}

      {confirmTarget && (
        <ConfirmModal
          title={confirmTarget.kind === "delete" ? "Удалить пользователя?" : "Отключить доступ?"}
          message={
            confirmTarget.kind === "delete" ? (
              <>
                Пользователь <span className="font-medium text-ink">«{confirmTarget.user.username}»</span> будет
                удалён навсегда. Это действие нельзя отменить.
              </>
            ) : (
              <>
                Учётная запись <span className="font-medium text-ink">«{confirmTarget.user.username}»</span> будет
                отключена — пользователь не сможет войти в систему.
              </>
            )
          }
          confirmLabel={confirmTarget.kind === "delete" ? "Удалить" : "Отключить"}
          loading={confirmLoading}
          onConfirm={handleConfirmAction}
          onClose={() => {
            if (!confirmLoading) setConfirmTarget(null);
          }}
        />
      )}
    </div>
  );
}

// ── Confirm Modal (удаление / отключение) ─────────────────────────────────────

function ConfirmModal({
  title,
  message,
  confirmLabel,
  loading,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  loading: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Автофокус на «Отмена»: случайный Enter не должен подтверждать
    // деструктивное действие (Esc также закрывает).
    const t = setTimeout(() => cancelRef.current?.focus(), 50);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !loading) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [loading, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 px-4"
      onClick={() => !loading && onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-user-action-title"
    >
      <div
        className="w-full max-w-md rounded-lg bg-surface p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-user-action-title" className="text-[17px] font-semibold text-ink mb-2">
          {title}
        </h2>
        <p className="text-[13.5px] text-ink-2 mb-5">{message}</p>
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            disabled={loading}
            className="rounded border border-border px-4 py-2 text-sm text-ink-2 hover:bg-surface-soft disabled:opacity-50"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className="rounded bg-rose px-4 py-2 text-sm text-white hover:bg-rose/90 disabled:opacity-50"
          >
            {loading ? "Выполняю…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Change Password Modal ─────────────────────────────────────────────────────

function ChangePasswordModal({
  username,
  onClose,
  onSubmit,
}: {
  username: string;
  onClose: () => void;
  onSubmit: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saving, onClose]);

  const trimmedLen = password.trim().length;
  const disabled = saving || trimmedLen < 3;

  async function handleSave() {
    if (trimmedLen < 3) {
      setError("Пароль должен быть не короче 3 символов");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSubmit(password.trim());
      setDone(true);
      setTimeout(onClose, 900);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка");
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 px-4"
      onClick={() => !saving && onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="change-password-title"
    >
      <div
        className="w-full max-w-md rounded-lg bg-surface p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="eyebrow mb-2">Смена пароля</div>
        <h2 id="change-password-title" className="mb-4 text-lg font-semibold text-ink">{username}</h2>

        {done ? (
          <div className="rounded-lg bg-emerald-soft border border-emerald-border text-emerald text-sm px-3 py-2">
            Пароль изменён
          </div>
        ) : (
          <>
            <label htmlFor="new-user-password" className="mb-2 block text-sm text-ink-2">
              Новый пароль <span className="text-rose">*</span>
            </label>
            <div className="relative">
              <input
                id="new-user-password"
                ref={inputRef}
                type={show ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !disabled) handleSave();
                }}
                disabled={saving}
                placeholder="Минимум 3 символа"
                className="w-full rounded border border-border bg-surface px-3 py-2 pr-16 text-sm text-ink focus:border-accent focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShow((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-ink-2 hover:text-ink"
              >
                {show ? "Скрыть" : "Показать"}
              </button>
            </div>

            {error && (
              <div className="mt-3 rounded bg-rose-soft border border-rose-border text-rose text-xs px-3 py-2">
                {error}
              </div>
            )}

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="px-4 py-2 text-sm text-ink-2 hover:text-ink transition-colors disabled:opacity-50"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={disabled}
                className="bg-accent-bright hover:bg-accent text-white font-medium rounded-lg px-4 py-2 text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? "Сохраняем…" : "Изменить пароль"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
