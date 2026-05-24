"use client";

import { Suspense, useCallback, useEffect, useState } from "react";

import { SectionHeader } from "../../src/components/SectionHeader";
import { StatusPill } from "../../src/components/StatusPill";
import { FeedbackComposer } from "../../src/components/feedback/FeedbackComposer";
import { FeedbackDetailPanel } from "../../src/components/feedback/FeedbackDetailPanel";
import { listFeedback } from "../../src/components/feedback/api";
import {
  CATEGORY_META,
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
  { value: "BUG",     label: "🐛 Поломки" },
  { value: "IDEA",    label: "💡 Идеи" },
  { value: "COMMENT", label: "💬 Комментарии" },
];

export default function FeedbackPage() {
  const ready = useRequireRole(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"]);
  if (!ready) return null;
  return (
    <Suspense fallback={<div className="p-6 text-ink-3 text-sm">Загружаю…</div>}>
      <FeedbackPageInner />
    </Suspense>
  );
}

function FeedbackPageInner() {
  const [items, setItems] = useState<FeedbackListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<FeedbackStatus | "ALL">("ALL");
  const [categoryFilter, setCategoryFilter] = useState<FeedbackCategory | "ALL">("ALL");
  const [composerOpen, setComposerOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listFeedback({ status: statusFilter, category: categoryFilter, limit: 100 });
      setItems(res.items);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, categoryFilter]);

  useEffect(() => { void load(); }, [load]);

  const counts = items.reduce<Record<FeedbackStatus, number>>(
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
            const cnt = f.value === "ALL" ? items.length : (counts[f.value as FeedbackStatus] ?? 0);
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
                <span className={`mono-num text-[10px] ${active ? "text-ink-3" : "text-ink-3"}`}>{cnt}</span>
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

function FeedbackListRow({ item, onOpen }: { item: FeedbackListItem; onOpen: () => void }) {
  const meta = CATEGORY_META[item.category];
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
          <div className="text-xl leading-none pt-0.5" aria-hidden>{meta.emoji}</div>
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
                    💬 {item.commentCount}
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
