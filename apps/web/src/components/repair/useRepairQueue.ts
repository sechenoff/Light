"use client";

/**
 * Данные раздела «Мастерская»: очередь, сводка и архив.
 *
 * Разделение очереди и архива — серверное (`?active=true|false`). Раньше
 * страница тянула всё одним запросом и фильтровала на клиенте: закрытый ремонт
 * попадал и в список, и в архив (виден дважды), а курсор игнорировался — при
 * росте архива старые карточки молча исчезали. Теперь очередь листается до
 * конца, архив — по кнопке «Показать ещё» на серверном курсоре.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiFetch } from "../../lib/api";
import {
  comparatorFor,
  matchesFilter,
  repairGroup,
  type QueueFilter,
  type RepairListItem,
  type RepairListResponse,
  type RepairSort,
  type RepairStats,
} from "./types";

/** Размер страницы очереди. Больше 200 сервер не отдаёт (Zod max). */
const QUEUE_PAGE = 200;
/** Предохранитель от бесконечного листания, если курсор вдруг перестанет двигаться. */
const QUEUE_MAX_PAGES = 5;
const ARCHIVE_PAGE = 20;

export interface EtaPatch {
  /** ISO либо «YYYY-MM-DD»; null — снять срок. */
  expectedReadyAt?: string | null;
  partsNote?: string | null;
}

export interface RepairQueue {
  loading: boolean;
  error: string | null;
  /** Активные ремонты (без закрытых и списанных), отсортированные выбранным порядком. */
  visible: RepairListItem[];
  groups: { hot: RepairListItem[]; warm: RepairListItem[]; calm: RepairListItem[] };
  /** Все активные до фильтра — для счётчиков пилюль и сирены. */
  active: RepairListItem[];
  stats: RepairStats | null;

  filter: QueueFilter;
  setFilter: (f: QueueFilter) => void;
  sort: RepairSort;
  setSort: (s: RepairSort) => void;

  reload: () => void;
  takeRepair: (id: string) => Promise<void>;
  setEta: (id: string, patch: EtaPatch) => Promise<void>;
  approveExpense: (id: string) => Promise<void>;

  archive: {
    items: RepairListItem[];
    loading: boolean;
    hasMore: boolean;
    loadMore: () => void;
  };
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function useRepairQueue(options: {
  enabled: boolean;
  currentUserId: string | undefined;
}): RepairQueue {
  const { enabled, currentUserId } = options;

  const [active, setActive] = useState<RepairListItem[]>([]);
  const [stats, setStats] = useState<RepairStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [filter, setFilter] = useState<QueueFilter>("all");
  const [sort, setSort] = useState<RepairSort>("risk");

  const [archiveItems, setArchiveItems] = useState<RepairListItem[]>([]);
  const [archiveCursor, setArchiveCursor] = useState<string | null>(null);
  const [archiveStarted, setArchiveStarted] = useState(false);
  const [archiveLoading, setArchiveLoading] = useState(false);
  /** Курсор в ref: loadMore не должен пересоздаваться на каждой странице. */
  const archiveCursorRef = useRef<string | null>(null);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  // ── Очередь + сводка ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    async function loadQueue(): Promise<RepairListItem[]> {
      const acc: RepairListItem[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < QUEUE_MAX_PAGES; page += 1) {
        const qs = new URLSearchParams({ active: "true", limit: String(QUEUE_PAGE) });
        if (cursor) qs.set("cursor", cursor);
        const data: RepairListResponse = await apiFetch<RepairListResponse>(
          `/api/repairs?${qs.toString()}`,
        );
        acc.push(...data.repairs);
        cursor = data.nextCursor;
        if (!cursor) break;
      }
      return acc;
    }

    setLoading(true);
    setError(null);

    Promise.all([
      loadQueue().then((rows) => {
        if (!cancelled) setActive(rows);
      }),
      // Сводку видят все три роли; денежные поля сервер обнуляет сам.
      apiFetch<RepairStats>("/api/dashboard/repair-stats")
        .then((data) => {
          if (!cancelled) setStats(data);
        })
        .catch(() => {
          if (!cancelled) setStats(null);
        }),
    ])
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err, "Не удалось загрузить ремонты"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, reloadToken]);

  // Перезагрузка страницы сбрасывает уже пролистанный архив: иначе после
  // закрытия ремонта он приехал бы вторым экземпляром поверх старых страниц.
  useEffect(() => {
    setArchiveItems([]);
    setArchiveCursor(null);
    archiveCursorRef.current = null;
    setArchiveStarted(false);
  }, [reloadToken]);

  const loadArchivePage = useCallback(async () => {
    setArchiveLoading(true);
    try {
      const qs = new URLSearchParams({ active: "false", limit: String(ARCHIVE_PAGE) });
      const cursor = archiveCursorRef.current;
      if (cursor) qs.set("cursor", cursor);
      const data = await apiFetch<RepairListResponse>(`/api/repairs?${qs.toString()}`);
      setArchiveItems((prev) => [...prev, ...data.repairs]);
      archiveCursorRef.current = data.nextCursor;
      setArchiveCursor(data.nextCursor);
      setArchiveStarted(true);
    } catch (err) {
      setError(errorMessage(err, "Не удалось загрузить архив"));
    } finally {
      setArchiveLoading(false);
    }
  }, []);

  const loadMoreArchive = useCallback(() => {
    if (archiveLoading) return;
    if (archiveStarted && archiveCursorRef.current === null) return;
    void loadArchivePage();
  }, [archiveLoading, archiveStarted, loadArchivePage]);

  // ── Действия ───────────────────────────────────────────────────────────────

  const takeRepair = useCallback(
    async (id: string) => {
      await apiFetch(`/api/repairs/${id}/take`, { method: "POST" });
      reload();
    },
    [reload],
  );

  const setEta = useCallback(async (id: string, patch: EtaPatch) => {
    // Сервер возвращает карточку с ПЕРЕСЧИТАННЫМ риском: «срывает бронь»
    // превращается в «успеваем, запас 4 дня» ровно в этот момент, поэтому
    // подменяем строку ответом, а не гасим её локальной догадкой.
    const { repair } = await apiFetch<{ repair: RepairListItem }>(`/api/repairs/${id}/eta`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    setActive((prev) => prev.map((r) => (r.id === id ? repair : r)));
  }, []);

  const approveExpense = useCallback(async (id: string) => {
    await apiFetch(`/api/expenses/${id}/approve`, { method: "POST" });
    const fresh = await apiFetch<RepairStats>("/api/dashboard/repair-stats");
    setStats(fresh);
  }, []);

  // ── Производные ────────────────────────────────────────────────────────────

  const visible = useMemo(() => {
    const rows = active.filter((r) => matchesFilter(r, filter, currentUserId));
    return [...rows].sort(comparatorFor(sort));
  }, [active, filter, currentUserId, sort]);

  const groups = useMemo(() => {
    const hot: RepairListItem[] = [];
    const warm: RepairListItem[] = [];
    const calm: RepairListItem[] = [];
    for (const r of visible) {
      const g = repairGroup(r);
      if (g === "hot") hot.push(r);
      else if (g === "warm") warm.push(r);
      else calm.push(r);
    }
    return { hot, warm, calm };
  }, [visible]);

  return {
    loading,
    error,
    visible,
    groups,
    active,
    stats,
    filter,
    setFilter,
    sort,
    setSort,
    reload,
    takeRepair,
    setEta,
    approveExpense,
    archive: {
      items: archiveItems,
      loading: archiveLoading,
      hasMore: !archiveStarted || archiveCursor !== null,
      loadMore: loadMoreArchive,
    },
  };
}
