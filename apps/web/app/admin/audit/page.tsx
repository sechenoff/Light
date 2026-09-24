"use client";

import { Suspense, useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { apiFetch } from "../../../src/lib/api";
import { AdminShell } from "../../../src/components/admin/AdminShell";
import {
  ACTION_LABELS,
  ENTITY_TYPE_OPTIONS,
} from "../../../src/lib/auditLabels";
import { AuditEntryCard } from "../../../src/components/audit/AuditEntryCard";
import { SectionHeader } from "../../../src/components/SectionHeader";
import type { AuditRecord } from "../../../src/lib/auditFormat";

type Filters = {
  entityType: string;
  entityId: string;
  userId: string;
  action: string;
  from: string;
  to: string;
};
const EMPTY: Filters = {
  entityType: "",
  entityId: "",
  userId: "",
  action: "",
  from: "",
  to: "",
};
const fieldClass =
  "h-10 w-full min-w-0 rounded border border-border px-3 py-2 text-sm text-ink bg-surface focus:outline-none focus:border-accent-bright";

function AuditContent() {
  const { authorized, loading: authLoading } = useRequireRole(["SUPER_ADMIN"]);
  const searchParams = useSearchParams();
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [entries, setEntries] = useState<AuditRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<Array<{ id: string; username: string }>>(
    [],
  );
  const abortRef = useRef<AbortController | null>(null);
  const invalid = Boolean(draft.from && draft.to && draft.from > draft.to);
  useEffect(() => {
    const next = {
      ...EMPTY,
      userId: searchParams.get("userId") ?? "",
      entityType: searchParams.get("entityType") ?? "",
      entityId: searchParams.get("entityId") ?? "",
    };
    setDraft(next);
    setApplied(next);
  }, [searchParams]);

  const load = useCallback(
    async (cursor?: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setFetching(true);
      setError(null);
      if (!cursor) {
        setEntries([]);
        setNextCursor(null);
      }
      const params = new URLSearchParams({ limit: "50" });
      for (const [key, value] of Object.entries(applied))
        if (value) {
          // Ввод и вывод журнала всегда в МСК, независимо от настроек устройства.
          params.set(
            key,
            key === "from" || key === "to"
              ? new Date(
                  `${value}:${key === "to" ? "59.999" : "00"}+03:00`,
                ).toISOString()
              : value,
          );
        }
      if (cursor) params.set("cursor", cursor);
      try {
        const data = await apiFetch<{
          items: AuditRecord[];
          nextCursor: string | null;
        }>(`/api/audit?${params}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setEntries((prev) => (cursor ? [...prev, ...data.items] : data.items));
        setNextCursor(data.nextCursor);
      } catch (e) {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error ? e.message : "Не удалось загрузить журнал",
          );
      } finally {
        if (abortRef.current === controller) setFetching(false);
      }
    },
    [applied],
  );
  useEffect(() => {
    if (authorized) void load();
    return () => abortRef.current?.abort();
  }, [authorized, load]);
  useEffect(() => {
    if (!authorized) return;
    const controller = new AbortController();
    apiFetch<{ users: Array<{ id: string; username: string }> }>(
      "/api/admin-users",
      { signal: controller.signal },
    )
      .then((data) => {
        if (!controller.signal.aborted) setUsers(data.users);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [authorized]);
  const set = (key: keyof Filters, value: string) =>
    setDraft((prev) => ({
      ...prev,
      [key]: value,
      ...(key === "entityType" ? { entityId: "" } : {}),
    }));
  if (authLoading)
    return <p className="p-6 text-sm text-ink-3">Проверка доступа…</p>;
  if (!authorized) return null;
  const targetName = entries.find(
    (e) => e.entityType === "AdminUser",
  )?.entityLabel;
  return (
    <AdminShell>
      <div className="space-y-4 min-w-0">
        <div>
          <SectionHeader eyebrow="Администрирование" title="Журнал изменений" />
          <p className="text-sm text-ink-2 mt-1">
            Кто внёс изменения, когда и что изменилось. Время — московское.
          </p>
        </div>
        {applied.entityId && (
          <div className="rounded-lg border border-border bg-surface-muted p-3 text-sm flex flex-wrap gap-3 items-center">
            <span>
              Изменения{" "}
              {applied.entityType === "AdminUser"
                ? `аккаунта${targetName ? ` «${targetName}»` : ""}`
                : "выбранной записи"}
            </span>
            <Link
              href="/admin/audit"
              className="text-accent-bright hover:underline"
            >
              Весь журнал
            </Link>
          </div>
        )}
        <form
          className="rounded-lg border border-border bg-surface p-3 sm:p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!invalid) setApplied({ ...draft });
          }}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            <label className="min-w-0 text-xs text-ink-2 space-y-1 block">
              Раздел
              <select
                className={fieldClass}
                value={draft.entityType}
                onChange={(e) => set("entityType", e.target.value)}
              >
                <option value="">Все разделы</option>
                {ENTITY_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-0 text-xs text-ink-2 space-y-1 block">
              Кто изменил
              <select
                className={fieldClass}
                value={draft.userId}
                onChange={(e) => set("userId", e.target.value)}
              >
                <option value="">Все аккаунты</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.id === "_system_" ? "Система" : u.username}
                  </option>
                ))}
              </select>
            </label>
            {/* Во всю строку до xl: иначе «С даты» и «По дату» разъезжаются по разным строкам. */}
            <label className="min-w-0 text-xs text-ink-2 space-y-1 block sm:col-span-2 xl:col-span-1">
              Действие
              <select
                className={fieldClass}
                value={draft.action}
                onChange={(e) => set("action", e.target.value)}
              >
                <option value="">Все действия</option>
                {Object.entries(ACTION_LABELS)
                  .sort((a, b) => a[1].localeCompare(b[1], "ru"))
                  .map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
              </select>
            </label>
            <label className="min-w-0 text-xs text-ink-2 space-y-1 block">
              С даты и времени (МСК)
              <input
                type="datetime-local"
                className={fieldClass}
                value={draft.from}
                onChange={(e) => set("from", e.target.value)}
                aria-invalid={invalid}
              />
            </label>
            <label className="min-w-0 text-xs text-ink-2 space-y-1 block">
              По дату и время (МСК)
              <input
                type="datetime-local"
                className={fieldClass}
                value={draft.to}
                onChange={(e) => set("to", e.target.value)}
                aria-invalid={invalid}
              />
            </label>
          </div>
          {invalid && (
            <p role="alert" className="text-sm text-rose mt-2">
              Начало периода позже окончания.
            </p>
          )}
          <div className="flex flex-wrap gap-2 mt-3">
            <button
              type="submit"
              disabled={fetching || invalid}
              className="min-h-10 rounded bg-accent-bright text-surface px-4 py-2 text-sm disabled:opacity-50"
            >
              Применить
            </button>
            <button
              type="button"
              className="min-h-10 rounded border border-border px-4 py-2 text-sm text-ink-2"
              onClick={() => {
                setDraft(EMPTY);
                setApplied({ ...EMPTY });
              }}
            >
              Сбросить фильтры
            </button>
            <button
              type="button"
              disabled={fetching}
              onClick={() => void load()}
              className="min-h-10 rounded border border-border px-4 py-2 text-sm text-accent-bright disabled:opacity-50"
            >
              Обновить
            </button>
          </div>
        </form>
        {error && (
          <p
            role="alert"
            className="rounded-lg bg-rose-soft border border-rose-border p-3 text-sm text-rose"
          >
            {error}
          </p>
        )}
        <div aria-busy={fetching} className="space-y-3">
          {entries.map((entry) => (
            <AuditEntryCard key={entry.id} entry={entry} />
          ))}
          {!fetching && !error && entries.length === 0 && (
            <p className="rounded-lg border border-border p-6 text-center text-sm text-ink-3">
              За выбранный период изменений не найдено.
            </p>
          )}
          {fetching && (
            <p role="status" className="text-sm text-ink-3 p-3">
              Загрузка журнала…
            </p>
          )}
        </div>
        {nextCursor && (
          <button
            disabled={fetching}
            onClick={() => void load(nextCursor)}
            className="w-full min-h-11 rounded border border-border text-sm text-accent-bright disabled:opacity-50"
          >
            Загрузить ещё
          </button>
        )}
      </div>
    </AdminShell>
  );
}
export default function AuditPage() {
  return (
    <Suspense fallback={<p className="p-6 text-sm">Загрузка журнала…</p>}>
      <AuditContent />
    </Suspense>
  );
}
