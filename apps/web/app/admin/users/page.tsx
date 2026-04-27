"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useRequireRole } from "@/hooks/useRequireRole";
import { AdminTabNav } from "@/components/admin/AdminTabNav";

// ── Types ─────────────────────────────────────────────────────────────────────

type UserRole = "SUPER_ADMIN" | "WAREHOUSE" | "TECHNICIAN";

type AdminUserRow = {
  id: string;
  username: string;
  role: UserRole;
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

function roleColor(role: UserRole): { bg: string; pill: string } {
  switch (role) {
    case "SUPER_ADMIN":
      return { bg: "bg-indigo", pill: "bg-indigo-soft text-indigo border border-indigo-border" };
    case "WAREHOUSE":
      return { bg: "bg-teal", pill: "bg-teal-soft text-teal border border-teal-border" };
    case "TECHNICIAN":
      return { bg: "bg-amber", pill: "bg-amber-soft text-amber border border-amber-border" };
  }
}

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

  // Search
  const [search, setSearch] = useState("");

  // Role change inline
  const [changingRoleId, setChangingRoleId] = useState<string | null>(null);
  const [pendingRole, setPendingRole] = useState<UserRole | null>(null);

  async function load() {
    setLoadingUsers(true);
    setError(null);
    try {
      const res = await apiFetch<{ users: AdminUserRow[] }>("/api/admin-users");
      setUsers(res.users);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка загрузки");
    } finally {
      setLoadingUsers(false);
    }
  }

  useEffect(() => {
    if (!authorized) return;
    let cancelled = false;
    (async () => {
      setLoadingUsers(true);
      setError(null);
      try {
        const res = await apiFetch<{ users: AdminUserRow[] }>("/api/admin-users");
        if (!cancelled) setUsers(res.users);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Ошибка загрузки");
      } finally {
        if (!cancelled) setLoadingUsers(false);
      }
    })();
    return () => { cancelled = true; };
  }, [authorized]);

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
      setShowCreate(false);
      await load();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Ошибка создания");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string, username: string) {
    if (!window.confirm(`Удалить пользователя «${username}»?`)) return;
    try {
      await apiFetch(`/api/admin-users/${id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Ошибка удаления");
    }
  }

  async function handleChangePassword(id: string, username: string) {
    const password = window.prompt(`Новый пароль для «${username}»:`);
    if (!password) return;
    if (password.length < 3) {
      alert("Пароль должен быть не короче 3 символов");
      return;
    }
    try {
      await apiFetch(`/api/admin-users/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ password }),
      });
      alert("Пароль изменён");
    } catch (e) {
      alert(e instanceof Error ? e.message : "Ошибка");
    }
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
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Ошибка");
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

  return (
    <div className="p-6 space-y-6">
      <AdminTabNav counts={{ users: users?.length }} />

      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-ink">Пользователи</h1>
        <p className="text-sm text-ink-2 mt-0.5">
          Управление доступом к системе. Только Руководитель видит эту страницу.
        </p>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 text-sm select-none">⌕</span>
          <input
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
        <div className="flex items-center gap-1.5">
          {(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"] as UserRole[]).map((role) => {
            const colors = roleColor(role);
            return (
              <span
                key={role}
                className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium ${colors.pill}`}
              >
                {roleLabel(role)}
                {roleCounts[role] !== undefined && (
                  <span className="mono-num">{roleCounts[role]}</span>
                )}
              </span>
            );
          })}
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
                <input
                  type="text"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  disabled={creating}
                  placeholder="Минимум 3 символа"
                  className="w-full px-3 py-2 border border-border rounded-lg text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-accent/30"
                  required
                />
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
        <div className="border border-border rounded-lg overflow-hidden shadow-xs">
          <table className="w-full text-sm">
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
                const colors = roleColor(u.role);
                return (
                  <tr key={u.id} className="hover:bg-surface-muted transition-colors">
                    {/* Avatar + name */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-[30px] h-[30px] rounded flex items-center justify-center shrink-0 ${colors.bg}`}
                        >
                          <span className="font-mono text-[11px] font-bold text-white">
                            {getInitials(u.username)}
                          </span>
                        </div>
                        <div>
                          <div className="font-medium text-ink">{u.username}</div>
                          <div className="text-[11px] font-mono text-ink-3">{u.username}@local</div>
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
                        <span
                          className={`inline-block text-[11px] px-2 py-0.5 rounded-full font-medium ${colors.pill}`}
                        >
                          {roleLabel(u.role)}
                        </span>
                      )}
                    </td>

                    {/* Created */}
                    <td className="px-4 py-3 hidden md:table-cell">
                      <span className="mono-num text-xs text-ink-3">{formatDate(u.createdAt)}</span>
                    </td>

                    {/* Status */}
                    <td className="px-4 py-3 hidden lg:table-cell">
                      <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium bg-emerald-soft text-emerald border border-emerald-border">
                        ● активен
                      </span>
                    </td>

                    {/* Actions */}
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => handleChangePassword(u.id, u.username)}
                          className="text-xs text-ink-2 hover:text-ink underline transition-colors"
                        >
                          Пароль
                        </button>
                        <button
                          onClick={() => {
                            setChangingRoleId(u.id);
                            setPendingRole(u.role);
                          }}
                          className="text-xs text-ink-2 hover:text-ink underline transition-colors"
                        >
                          Роль
                        </button>
                        <button
                          onClick={() => handleDelete(u.id, u.username)}
                          className="text-xs text-rose hover:text-rose/80 underline transition-colors"
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
          <span>Всего: {users.length}</span>
          {(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"] as UserRole[]).map((role) =>
            roleCounts[role] ? (
              <span key={role}>
                {roleLabel(role)}: {roleCounts[role]}
              </span>
            ) : null
          )}
        </div>
      )}
    </div>
  );
}
