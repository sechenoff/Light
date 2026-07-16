"use client";

import { Suspense, useCallback, useEffect, useState } from "react";

import { SectionHeader } from "../../src/components/SectionHeader";
import { StatusPill } from "../../src/components/StatusPill";
import { FeedbackComposer } from "../../src/components/feedback/FeedbackComposer";
import { FeedbackDetailPanel } from "../../src/components/feedback/FeedbackDetailPanel";
import { listFeedback } from "../../src/components/feedback/api";
import {
  STATUS_META,
  type FeedbackCategory,
  type FeedbackListItem,
  type FeedbackStatus,
} from "../../src/components/feedback/types";
import { useRequireRole } from "../../src/hooks/useRequireRole";

const STATUS_FILTERS: Array<{ value: FeedbackStatus | "ALL"; label: string }> = [
  { value: "ALL",         label: "Все" },
  { value: "NEW",         label: "Новые" },
  { value: "IN_PROGRESS", label: "В работе" },
  { value: "DONE",        label: "Сделано" },
  { value: "REJECTED",    label: "Отклонено" },
];

const CATEGORY_FILTERS: Array<{ value: FeedbackCategory | "ALL"; label: string }> = [
  { value: "ALL",     label: "Все типы" },
  { value: "BUG",     label: "Поломки" },
  { value: "IDEA",    label: "Идеи" },
  { value: "COMMENT", label: "Комментарии" },
];

export default function FeedbackPage() {
  const { authorized, loading } = useRequireRole(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"]);
  if (loading || !authorized) return null;
  return (
    <Suspense fallback={<div className="p-6 text-ink-3 text-sm">Загружаю…</div>}>
      <FeedbackPageInner />
    </Suspense>
  );
}

function FeedbackPageInner() {
  const [items, setItems] = useState<FeedbackListItem[]>([]);
  const [allItems, setAllItems] = useState<FeedbackListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [statusFilter, setStatusFilter] = useState<FeedbackStatus | "ALL">("ALL");
  const [categoryFilter, setCategoryFilter] = useState<FeedbackCategory | "ALL">("ALL");
  const [composerOpen, setComposerOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      // Полный список грузим параллельно — счётчики чипов считаются из него,
      // а не из отфильтрованной выборки.
      const [res, allRes] = await Promise.all([
        listFeedback({ status: statusFilter, category: categoryFilter, limit: 100 }),
        listFeedback({ status: "ALL", category: "ALL", limit: 100 }),
      ]);
      setItems(res.items);
      setAllItems(allRes.items);
    } catch {
      setItems([]);
      setAllItems([]);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, categoryFilter]);

  useEffect(() => { void load(); }, [load]);

  const counts = allItems.reduce<Record<FeedbackStatus, number>>(
    (acc, it) => { acc[it.status] = (acc[it.status] ?? 0) + 1; return acc; },
    { NEW: 0, IN_PROGRESS: 0, DONE: 0, REJECTED: 0 },
  );

  return (
    <div className="px-4 sm:px-6 py-6 max-w-6xl mx-auto">
      <SectionHeader
        eyebrow="Команда · улучшения"
        title="Обратная связь"
        actions={
          <button
            type="button"
            onClick={() => setComposerOpen(true)}
            className="h-10 px-4 rounded-md bg-accent-bright text-surface text-sm font-semibold hover:bg-accent transition-colors shadow-xs inline-flex items-center gap-2"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Новая заявка
          </button>
        }
      />

      <p className="text-sm text-ink-2 mt-2 max-w-2xl mb-6">
        Фиксируем баги, идеи и комментарии прямо из приложения. Плавающая кнопка{" "}
        <span className="font-semibold text-ink">«Сообщить»</span> в правом нижнем углу
        работает на любой странице — авто-захватывает URL и можно сразу приложить скриншот.
      </p>

      {/* Filter rows */}
      <div className="space-y-2 mb-5">
        <div className="flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((f) => {
            const active = statusFilter === f.value;
            const cnt = f.value === "ALL" ? allItems.length : (counts[f.value as FeedbackStatus] ?? 0);
            return (
              <button
                key={f.value}
                type="button"
                onClick={() => setStatusFilter(f.value)}
                className={`h-8 px-3 rounded-md text-xs font-semibold border transition-colors inline-flex items-center gap-1.5 ${
                  active
                    ? "bg-ink text-surface border-ink"
                    : "bg-surface text-ink-2 border-border hover:border-ink"
                }`}
              >
                {f.label}
                <span className="mono-num text-[10px] text-ink-3">{cnt}</span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {CATEGORY_FILTERS.map((f) => {
            const active = categoryFilter === f.value;
            return (
              <button
                key={f.value}
                type="button"
                onClick={() => setCategoryFilter(f.value)}
                className={`h-7 px-2.5 rounded-md text-[11px] font-semibold border transition-colors ${
                  active
                    ? "bg-accent-soft text-accent border-accent-border"
                    : "bg-surface text-ink-3 border-border hover:border-ink-2 hover:text-ink-2"
                }`}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* List */}
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-20 rounded-lg bg-surface-subtle animate-pulse" />
          ))}
        </div>
      ) : loadError ? (
        <div className="rounded-lg border border-rose-border bg-rose-soft px-6 py-16 text-center">
          <div className="text-sm font-semibold text-rose">Не удалось загрузить заявки</div>
          <div className="text-xs text-ink-3 mt-1 max-w-sm mx-auto">
            Проверьте соединение с интернетом и попробуйте ещё раз.
          </div>
          <button
            type="button"
            onClick={() => { void load(); }}
            className="mt-4 h-9 px-4 rounded-md border border-border bg-surface text-sm font-semibold text-ink hover:bg-surface-muted transition-colors"
          >
            Повторить
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-surface-muted px-6 py-16 text-center">
          <div className="text-sm font-semibold text-ink">Здесь пока пусто</div>
          <div className="text-xs text-ink-3 mt-1 max-w-sm mx-auto">
            Нажмите «Новая заявка» сверху или кнопку «Сообщить» в правом нижнем углу любой страницы.
          </div>
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <FeedbackListRow key={item.id} item={item} onOpen={() => setOpenId(item.id)} />
          ))}
        </ul>
      )}

      {/* Composer for "Новая заявка" button on this page */}
      <FeedbackComposer
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        onCreated={() => { void load(); }}
      />

      {/* Detail slide-over */}
      <FeedbackDetailPanel
        feedbackId={openId}
        onClose={() => setOpenId(null)}
        onChanged={() => { void load(); }}
      />
    </div>
  );
}

function CategoryIcon({ category }: { category: FeedbackCategory }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (category === "BUG") {
    return (
      <svg {...common}>
        <path d="m8 2 1.88 1.88M14.12 3.88 16 2" />
        <path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1" />
        <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6" />
        <path d="M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4" />
      </svg>
    );
  }
  if (category === "IDEA") {
    return (
      <svg {...common}>
        <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
        <path d="M9 18h6M10 22h4" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
    </svg>
  );
}

function FeedbackListRow({ item, onOpen }: { item: FeedbackListItem; onOpen: () => void }) {
  const status = STATUS_META[item.status];
  const dimmed = item.status === "DONE" || item.status === "REJECTED";

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={`w-full text-left rounded-lg border border-border bg-surface px-4 py-3 hover:border-ink-2 hover:shadow-xs transition-all ${dimmed ? "opacity-70" : ""}`}
      >
        <div className="flex items-start gap-3">
          <div className="text-ink-3 pt-0.5" aria-hidden>
            <CategoryIcon category={item.category} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="font-semibold text-ink text-sm truncate flex-1 min-w-0">{item.title}</span>
              <StatusPill variant={status.variant} label={status.label} />
            </div>
            <p className="text-xs text-ink-2 mt-1 line-clamp-2 leading-snug">{item.description}</p>
            <div className="text-[11px] text-ink-3 mt-2 flex items-center gap-2 flex-wrap">
              <span className="font-semibold">{item.createdByUser?.username ?? "—"}</span>
              <span aria-hidden>·</span>
              <span>{new Date(item.createdAt).toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
              {item.photoCount > 0 && (
                <>
                  <span aria-hidden>·</span>
                  <span className="inline-flex items-center gap-0.5">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <circle cx="9" cy="9" r="2" />
                      <path d="m21 15-5-5L5 21" />
                    </svg>
                    {item.photoCount}
                  </span>
                </>
              )}
              {item.commentCount > 0 && (
                <>
                  <span aria-hidden>·</span>
                  <span className="inline-flex items-center gap-0.5">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
                    </svg>
                    {item.commentCount}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </button>
    </li>
  );
}
