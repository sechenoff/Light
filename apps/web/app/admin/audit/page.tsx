"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { apiFetch } from "../../../src/lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────

type AuditUser = { id: string; username: string; role: string };

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
      <pre className="text-xs whitespace-pre-wrap break-all font-mono leading-relaxed">{pretty}</pre>
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
        <td className="py-2 px-3 text-xs font-medium text-ink">{entry.action}</td>
        <td className="py-2 px-3 text-xs text-ink-2">{entry.entityType}</td>
        <td className="py-2 px-3 text-xs mono-num text-ink-3">{entry.entityId.slice(0, 8)}…</td>
        <td className="py-2 px-3">
          {hasDiff && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="text-xs text-accent-bright hover:underline"
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

  // Filters
  const [entityType, setEntityType] = useState("");
  const [userId, setUserId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const buildQuery = useCallback(() => {
    const params = new URLSearchParams();
    if (entityType) params.set("entityType", entityType);
    if (userId)     params.set("userId", userId);
    if (from)       params.set("from", new Date(from).toISOString());
    if (to)         params.set("to", new Date(to).toISOString());
    params.set("limit", "50");
    return params.toString();
  }, [entityType, userId, from, to]);

  const load = useCallback(async (cursor?: string) => {
    setFetching(true);
    setError(null);
    try {
      const q = buildQuery();
      const url = `/api/audit?${q}${cursor ? `&cursor=${cursor}` : ""}`;
      const data = await apiFetch<AuditResponse>(url);
      if (cursor) {
        setEntries((prev) => [...prev, ...data.items]);
      } else {
        setEntries(data.items);
      }
      setNextCursor(data.nextCursor);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ошибка загрузки");
    } finally {
      setFetching(false);
    }
  }, [buildQuery]);

  useEffect(() => {
    if (!authorized) return;
    load();
  }, [authorized, load]);

  if (authLoading) {
    return (
      <div className="p-6 text-sm text-ink-3">Проверка доступа…</div>
    );
  }

  if (!authorized) return null;

  return (
    <div className="p-6 space-y-4">
      <div>
        <p className="eyebrow">Журнал</p>
        <h1 className="text-lg font-semibold text-ink mt-0.5">Аудит действий</h1>
      </div>

      {/* Filters */}
      <div className="bg-surface border border-border rounded-lg p-4 shadow-xs">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="eyebrow block mb-1">Тип объекта</label>
            <input
              type="text"
              value={entityType}
              onChange={(e) => setEntityType(e.target.value)}
              placeholder="Booking, Payment…"
              className="w-full border border-border rounded px-3 py-1.5 text-sm text-ink bg-surface placeholder-ink-3 focus:outline-none focus:border-accent-bright"
            />
          </div>
          <div>
            <label className="eyebrow block mb-1">User ID</label>
            <input
              type="text"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="cuid…"
              className="w-full border border-border rounded px-3 py-1.5 text-sm text-ink bg-surface placeholder-ink-3 focus:outline-none focus:border-accent-bright"
            />
          </div>
          <div>
            <label className="eyebrow block mb-1">С</label>
            <input
              type="datetime-local"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="w-full border border-border rounded px-3 py-1.5 text-sm text-ink bg-surface focus:outline-none focus:border-accent-bright"
            />
          </div>
          <div>
            <label className="eyebrow block mb-1">По</label>
            <input
              type="datetime-local"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-full border border-border rounded px-3 py-1.5 text-sm text-ink bg-surface focus:outline-none focus:border-accent-bright"
            />
          </div>
        </div>
        <button
          onClick={() => load()}
          disabled={fetching}
          className="mt-3 px-4 py-1.5 bg-accent-bright text-white text-sm rounded hover:bg-accent transition-colors disabled:opacity-60"
        >
          {fetching ? "Загрузка…" : "Применить"}
        </button>
      </div>

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
                <th className="py-2 px-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Время</th>
                <th className="py-2 px-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Пользователь</th>
                <th className="py-2 px-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Действие</th>
                <th className="py-2 px-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Объект</th>
                <th className="py-2 px-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">ID</th>
                <th className="py-2 px-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Изменения</th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 && !fetching && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-sm text-ink-3">
                    Записей нет
                  </td>
                </tr>
              )}
              {entries.map((entry) => (
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
  );
}
