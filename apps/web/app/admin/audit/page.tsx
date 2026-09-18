"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { apiFetch } from "../../../src/lib/api";
import { AdminShell } from "../../../src/components/admin/AdminShell";
import { ACTION_LABELS, ENTITY_LABELS, ENTITY_TYPE_OPTIONS, entityHref } from "../../../src/lib/auditLabels";

// ── Types ─────────────────────────────────────────────────────────────────────

type AuditUser = { id: string; username: string; role: string };

type AdminUserOption = { id: string; username: string; role: string };

type AuditEntry = {
  id: string;
  userId: string;
  user: AuditUser | null;
  action: string;
  entityType: string;
  entityId: string;
  before: string | null;
  after: string | null;
  createdAt: string;
};

type AuditResponse = {
  items: AuditEntry[];
  nextCursor: string | null;
};

// ── JSON diff renderer ────────────────────────────────────────────────────────

function JsonDiff({ label, value, colorClass }: { label: string; value: string | null; colorClass: string }) {
  const pretty = useMemo(() => {
    if (!value) return value;
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }, [value]);
  if (!pretty) return null;
  return (
    <div className={`rounded p-2 ${colorClass}`}>
      <p className="text-[10px] font-semibold uppercase tracking-wider mb-1 opacity-70">{label}</p>
      <pre className="text-xs whitespace-pre-wrap break-words font-mono leading-relaxed max-h-64 overflow-y-auto">{pretty}</pre>
    </div>
  );
}

// ── Row ───────────────────────────────────────────────────────────────────────

function AuditRow({ entry }: { entry: AuditEntry }) {
  const [expanded, setExpanded] = useState(false);
  const hasDiff = !!(entry.before || entry.after);

  const ts = new Date(entry.createdAt).toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  return (
    <>
      <tr className="border-b border-border hover:bg-surface-muted">
        <td className="py-2 px-3 text-xs mono-num text-ink-3 whitespace-nowrap">{ts}</td>
        <td className="py-2 px-3 text-xs text-ink-2">{entry.user?.username ?? entry.userId}</td>
        <td className="py-2 px-3 text-xs font-medium text-ink" title={entry.action}>
          {ACTION_LABELS[entry.action] ?? <span className="font-mono">{entry.action}</span>}
        </td>
        <td className="py-2 px-3 text-xs text-ink-2" title={entry.entityType}>
          {ENTITY_LABELS[entry.entityType] ?? <span className="font-mono">{entry.entityType}</span>}
        </td>
        <td className="py-2 px-3 text-xs mono-num">
          {(() => {
            const href = entityHref(entry.entityType, entry.entityId);
            const short = `${entry.entityId.slice(0, 8)}…`;
            return href ? (
              <Link href={href} className="text-accent-bright hover:underline" title="Открыть карточку">
                {short}
              </Link>
            ) : (
              <span className="text-ink-3">{short}</span>
            );
          })()}
        </td>
        <td className="py-2 px-3">
          {hasDiff && (
            <button
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="text-xs text-accent-bright hover:underline py-2 px-2 -my-1"
            >
              {expanded ? "Скрыть" : "Показать"}
            </button>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-surface-muted border-b border-border">
          <td colSpan={6} className="px-4 py-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <JsonDiff label="До" value={entry.before} colorClass="bg-rose-soft text-rose" />
              <JsonDiff label="После" value={entry.after} colorClass="bg-emerald-soft text-emerald" />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AuditPage() {
  const { authorized, loading: authLoading } = useRequireRole(["SUPER_ADMIN"]);

  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters — draft-состояние инпутов; запрос уходит только по «Применить» (+Enter).
  const [entityType, setEntityType] = useState("");
  const [userId, setUserId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // Фильтр по действию — клиентский (по загруженным записям): сервер /api/audit
  // фильтрует по entityType/userId/датам, action сужается уже на странице.
  const [actionFilter, setActionFilter] = useState("");

  // Применённый снапшот фильтров — единственный источник для запроса.
  const [applied, setApplied] = useState({ entityType: "", userId: "", from: "", to: "" });

  // Клиентская валидация диапазона дат: «С» позже «По» — подсветка + блок «Применить».
  const rangeInvalid = Boolean(from && to && new Date(from) > new Date(to));

  // Список пользователей для селекта «Сотрудник» (вместо ручного ввода cuid).
  const [adminUsers, setAdminUsers] = useState<AdminUserOption[]>([]);

  const buildQuery = useCallback(() => {
    const params = new URLSearchParams();
    if (applied.entityType) params.set("entityType", applied.entityType);
    if (applied.userId)     params.set("userId", applied.userId);
    if (applied.from)       params.set("from", new Date(applied.from).toISOString());
    if (applied.to)         params.set("to", new Date(applied.to).toISOString());
    params.set("limit", "50");
    return params.toString();
  }, [applied]);

  // AbortController: новый запрос отменяет предыдущий in-flight (нет гонки ответов).
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (cursor?: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setFetching(true);
    setError(null);
    try {
      const q = buildQuery();
      const url = `/api/audit?${q}${cursor ? `&cursor=${cursor}` : ""}`;
      const data = await apiFetch<AuditResponse>(url, { signal: controller.signal });
      if (cursor) {
        setEntries((prev) => [...prev, ...data.items]);
      } else {
        setEntries(data.items);
      }
      setNextCursor(data.nextCursor);
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") return; // заменён более новым запросом
      setError(e instanceof Error ? e.message : "Ошибка загрузки");
    } finally {
      if (abortRef.current === controller) setFetching(false);
    }
  }, [buildQuery]);

  const applyFilters = useCallback(() => {
    if (rangeInvalid) return;
    // Новый объект даже при тех же значениях — «Применить» всегда перезапрашивает.
    setApplied({ entityType, userId, from, to });
  }, [entityType, userId, from, to, rangeInvalid]);

  useEffect(() => {
    if (!authorized) return;
    load();
    return () => abortRef.current?.abort();
  }, [authorized, load]);

  useEffect(() => {
    if (!authorized) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch<{ users: AdminUserOption[] }>("/api/admin-users");
        if (!cancelled) setAdminUsers(res.users);
      } catch {
        // не критично — останется пустой селект «Все»
      }
    })();
    return () => { cancelled = true; };
  }, [authorized]);

  // Опции селекта «Действие»: словарь ACTION_LABELS + действия из загруженных
  // записей, которых в словаре нет (показываются сырым кодом). Сортировка по-русски.
  const actionOptions = useMemo(() => {
    const merged = new Map<string, string>(Object.entries(ACTION_LABELS));
    for (const e of entries) {
      if (!merged.has(e.action)) merged.set(e.action, e.action);
    }
    return Array.from(merged.entries()).sort((a, b) => a[1].localeCompare(b[1], "ru"));
  }, [entries]);

  const visibleEntries = useMemo(() => {
    if (!actionFilter) return entries;
    return entries.filter((e) => e.action === actionFilter);
  }, [entries, actionFilter]);

  if (authLoading) {
    return (
      <div className="p-6 text-sm text-ink-3">Проверка доступа…</div>
    );
  }

  if (!authorized) return null;

  return (
    <AdminShell>
      <div className="space-y-4">

      <div>
        <p className="eyebrow">Журнал</p>
        <h1 className="text-lg font-semibold text-ink mt-0.5">Аудит действий</h1>
      </div>

      {/* Filters — запрос уходит только по «Применить» / Enter */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          applyFilters();
        }}
        className="bg-surface border border-border rounded-lg p-4 shadow-xs"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
          <div>
            <label className="eyebrow block mb-1">Тип объекта</label>
            <select
              value={entityType}
              onChange={(e) => setEntityType(e.target.value)}
              className="w-full border border-border rounded px-3 py-1.5 text-sm text-ink bg-surface focus:outline-none focus:border-accent-bright"
            >
              <option value="">Все</option>
              {ENTITY_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="eyebrow block mb-1">Сотрудник</label>
            <select
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              className="w-full border border-border rounded px-3 py-1.5 text-sm text-ink bg-surface focus:outline-none focus:border-accent-bright"
            >
              <option value="">Все</option>
              {adminUsers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.id === "_system_" ? "система" : u.username}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="eyebrow block mb-1">Действие</label>
            <select
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              className="w-full border border-border rounded px-3 py-1.5 text-sm text-ink bg-surface focus:outline-none focus:border-accent-bright"
            >
              <option value="">Все</option>
              {actionOptions.map(([code, label]) => (
                <option key={code} value={code}>{label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="eyebrow block mb-1">С</label>
            <input
              type="datetime-local"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              aria-invalid={rangeInvalid}
              className={`w-full border rounded px-3 py-1.5 text-sm text-ink bg-surface focus:outline-none ${rangeInvalid ? "border-rose-border focus:border-rose" : "border-border focus:border-accent-bright"}`}
            />
          </div>
          <div>
            <label className="eyebrow block mb-1">По</label>
            <input
              type="datetime-local"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              aria-invalid={rangeInvalid}
              className={`w-full border rounded px-3 py-1.5 text-sm text-ink bg-surface focus:outline-none ${rangeInvalid ? "border-rose-border focus:border-rose" : "border-border focus:border-accent-bright"}`}
            />
          </div>
        </div>
        {rangeInvalid && (
          <p className="mt-2 text-xs text-rose">Дата «С» позже даты «По» — исправьте диапазон.</p>
        )}
        <button
          type="submit"
          disabled={fetching || rangeInvalid}
          className="mt-3 px-4 py-1.5 bg-accent-bright text-surface text-sm rounded hover:bg-accent transition-colors disabled:opacity-60"
        >
          {fetching ? "Загрузка…" : "Применить"}
        </button>
      </form>

      {/* Error */}
      {error && (
        <div className="bg-rose-soft border border-rose-border text-rose text-sm rounded-lg p-3">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="bg-surface border border-border rounded-lg shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-surface-muted border-b border-border">
              <tr>
                <th scope="col" className="py-2 px-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Время</th>
                <th scope="col" className="py-2 px-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Пользователь</th>
                <th scope="col" className="py-2 px-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Действие</th>
                <th scope="col" className="py-2 px-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Объект</th>
                <th scope="col" className="py-2 px-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">ID</th>
                <th scope="col" className="py-2 px-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Изменения</th>
              </tr>
            </thead>
            <tbody>
              {fetching && visibleEntries.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-sm text-ink-3">
                    <span className="inline-block animate-pulse">Загрузка…</span>
                  </td>
                </tr>
              )}
              {visibleEntries.length === 0 && !fetching && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-sm text-ink-3">
                    {entries.length > 0 && actionFilter
                      ? "Среди загруженных записей нет такого действия — попробуйте «Загрузить ещё»"
                      : "Записей нет"}
                  </td>
                </tr>
              )}
              {visibleEntries.map((entry) => (
                <AuditRow key={entry.id} entry={entry} />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Load more */}
      {nextCursor && (
        <button
          onClick={() => load(nextCursor)}
          disabled={fetching}
          className="w-full py-2 text-sm text-accent-bright hover:underline disabled:opacity-60"
        >
          {fetching ? "Загрузка…" : "Загрузить ещё"}
        </button>
      )}
      </div>
    </AdminShell>
  );
}
