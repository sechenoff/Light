"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import Link from "next/link";
import { StatusPill } from "../StatusPill";
import { TaskAssigneePill } from "./TaskAssigneePill";
import type { Task } from "./groupTasks";
import { toMoscowDateString } from "../../lib/moscowDate";

// ── Хелперы ───────────────────────────────────────────────────────────────────

function formatDueDate(dueDate: string): string {
  try {
    const d = new Date(dueDate);
    return d.toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "short",
      timeZone: "Europe/Moscow",
    });
  } catch {
    return dueDate;
  }
}

function formatCreatedAt(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "numeric",
      timeZone: "Europe/Moscow",
    });
  } catch {
    return iso;
  }
}

function dueDateVariant(
  dueDate: string | null,
  now: Date,
): "none" | "info" | "warn" | "alert" {
  if (!dueDate) return "none";
  const todayStr = toMoscowDateString(now);
  const dueStr = toMoscowDateString(new Date(dueDate));
  // Семантика по срочности (синхронно с заголовками групп в TaskGroupList):
  // просрочено → alert (rose), сегодня → warn (amber), дальше → спокойный info.
  // Раньше было инвертировано: «сегодня» красили в info, а задачу через 2-3 дня
  // в amber — сегодняшний дедлайн визуально терялся.
  if (dueStr < todayStr) return "alert";
  if (dueStr === todayStr) return "warn";
  return "info";
}

// ── TaskCard ──────────────────────────────────────────────────────────────────

export interface TaskCardProps {
  task: Task;
  onComplete: (id: string) => void;
  onReopen: (id: string) => void;
  onUpdate: (id: string, patch: Partial<Pick<Task, "title" | "urgent">>) => void;
  onDelete: (id: string) => void;
  onOpenEdit?: (task: Task) => void;
  onOpenDetail?: (id: string) => void;
  isOverdue?: boolean;
}

export function TaskCard({
  task,
  onComplete,
  onReopen,
  onUpdate,
  onDelete,
  onOpenEdit,
  onOpenDetail,
  isOverdue = false,
}: TaskCardProps) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // "now" фиксируем на время жизни компонента
  const now = useMemo(() => new Date(), []);

  // Sync draft when task changes externally
  useEffect(() => {
    if (!editingTitle) setTitleDraft(task.title);
  }, [task.title, editingTitle]);

  // Focus input when entering edit
  useEffect(() => {
    if (editingTitle) inputRef.current?.focus();
  }, [editingTitle]);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [menuOpen]);

  function handleCheckbox() {
    if (task.status === "DONE") {
      onReopen(task.id);
    } else {
      onComplete(task.id);
    }
  }

  function handleTitleSave() {
    setEditingTitle(false);
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== task.title) {
      onUpdate(task.id, { title: trimmed });
    } else {
      setTitleDraft(task.title);
    }
  }

  function handleTitleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleTitleSave();
    if (e.key === "Escape") {
      setTitleDraft(task.title);
      setEditingTitle(false);
    }
  }

  const isDone = task.status === "DONE";
  const pillVariant = dueDateVariant(task.dueDate, now);
  const assignee = task.assignedToUser;
  const creator = task.createdByUser;

  // Разделители между строками рисует divide-y родителя (TaskGroupList) — своей
  // нижней границы у строки нет, иначе под первой задачей группы линия двойная.
  // На телефоне три колонки: исполнитель, срок и «⋯» уходят во вторую строку.
  const cardClasses = [
    "relative grid grid-cols-[22px_minmax(0,1fr)_32px] gap-x-3 gap-y-1.5 items-center py-3 px-4 bg-surface",
    "sm:grid-cols-[28px_minmax(0,1fr)_auto_minmax(88px,auto)_32px] sm:gap-4 sm:py-3.5 sm:px-5",
    "hover:bg-surface-muted transition-colors group",
    // Полоса срочности — поверх левого паддинга: не сдвигает контент и не
    // перекрашивается divide-border, как это было с border-l-4.
    task.urgent && !isDone ? "before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-rose" : "",
    isOverdue && !isDone ? "bg-rose-soft/40" : "",
    isDone ? "opacity-55" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cardClasses}>
      {/* Чекбокс — 22px, border-2, checked=teal */}
      <span className="flex items-center justify-center">
        <button
          role="checkbox"
          aria-checked={isDone}
          onClick={handleCheckbox}
          aria-label="Отметить выполненным"
          className={`w-[22px] h-[22px] rounded-[6px] border-2 flex items-center justify-center shrink-0 transition-colors cursor-pointer ${
            isDone
              ? "bg-teal border-teal text-surface"
              : "bg-surface border-border-strong hover:border-teal"
          }`}
        >
          {isDone && (
            <svg width="12" height="10" viewBox="0 0 12 10" fill="none" aria-hidden>
              <path d="M1 5l3.5 3.5L11 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          )}
        </button>
      </span>

      {/* Заголовок + мета */}
      <div
        className={`min-w-0 ${onOpenDetail ? "cursor-pointer" : ""}`}
        data-testid={`task-card-body-${task.id}`}
        onClick={(e) => {
          if (editingTitle) return;
          if ((e.target as HTMLElement).closest("button,input,a")) return;
          onOpenDetail?.(task.id);
        }}
      >
        {editingTitle ? (
          <input
            ref={inputRef}
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={handleTitleSave}
            onKeyDown={handleTitleKeyDown}
            className="w-full text-[15px] text-ink bg-surface-muted rounded px-1 py-0.5 border border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
        ) : (
          <p
            onClick={(e) => {
              if (!isDone) {
                e.stopPropagation();
                setEditingTitle(true);
              }
            }}
            className={`text-[15px] font-medium leading-snug cursor-text select-none ${
              isDone ? "line-through text-ink-3" : "text-ink"
            }`}
          >
            {task.urgent && !isDone && (
              <span className="text-rose font-bold mr-2">!</span>
            )}
            {task.title?.trim() ? task.title : (
              <span className="italic text-ink-3">Без названия</span>
            )}
          </p>
        )}
        {/* Описание — если есть */}
        {task.description?.trim() && !editingTitle && (
          <p
            className={`text-[13px] mt-0.5 leading-snug whitespace-pre-wrap ${
              isDone ? "line-through text-ink-3" : "text-ink-2"
            }`}
          >
            {task.description}
          </p>
        )}
        {/* Мета: поставил + дата создания */}
        {creator && (
          <p className="text-xs text-ink-3 mt-0.5">
            поставил <b className="text-ink-2 font-medium">{creator.username}</b>
            {" · "}
            {formatCreatedAt(task.createdAt)}
          </p>
        )}
        {/* Чип связанной брони */}
        {task.relatedBooking && (
          <div className="mt-1">
            <Link
              href={`/bookings/${task.relatedBooking.id}`}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 rounded-md border border-accent-border bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent-bright hover:underline max-w-full"
            >
              <span aria-hidden>📋</span>
              <span className="truncate">
                {task.relatedBooking.projectName} · {task.relatedBooking.clientName}
              </span>
            </Link>
          </div>
        )}
        {/* Чипы: комментарии + чеклист */}
        {((task.commentCount ?? 0) > 0 || (task.checklistSummary?.total ?? 0) > 0) && (
          <div className="flex items-center gap-2 mt-1">
            {(task.commentCount ?? 0) > 0 && (
              <span className="text-[11px] text-ink-3">💬 {task.commentCount}</span>
            )}
            {(task.checklistSummary?.total ?? 0) > 0 && (
              <span className="text-[11px] text-ink-3">
                ☑ {task.checklistSummary!.done}/{task.checklistSummary!.total}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Исполнитель + срок: на телефоне одной строкой под названием, на sm+
          display:contents возвращает их в собственные колонки сетки */}
      <div className="col-start-2 flex flex-wrap items-center gap-2 sm:contents">
        <TaskAssigneePill user={assignee} />

        {/* Дата */}
        <span className="sm:justify-self-end">
          {task.dueDate ? (
            <StatusPill
              variant={pillVariant}
              label={formatDueDate(task.dueDate)}
            />
          ) : task.urgent && !isDone ? null : (
            // Срочная задача без срока стоит в «Сегодня» (groupTasks) — плашка «без даты» там противоречила бы группе.
            <span className="hidden sm:inline-flex items-center rounded border border-dashed border-border px-2 py-0.5 font-mono text-xs text-ink-3 whitespace-nowrap">
              без даты
            </span>
          )}
        </span>
      </div>

      {/* Overflow меню */}
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Действия с задачей"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-3 hover:text-ink transition-colors text-base leading-none [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-visible:opacity-100"
        >
          ⋯
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-full mt-1 z-50 bg-surface border border-border rounded-lg shadow-sm min-w-[200px] py-1 text-sm">
            {onOpenEdit && (
              <button
                onClick={() => {
                  setMenuOpen(false);
                  onOpenEdit(task);
                }}
                className="w-full text-left px-4 py-2 hover:bg-surface-muted text-ink transition-colors"
              >
                Редактировать детали
              </button>
            )}
            <button
              onClick={() => {
                setMenuOpen(false);
                onUpdate(task.id, { urgent: !task.urgent });
              }}
              aria-label={task.urgent ? "Снять срочность" : "Пометить срочным"}
              className="w-full text-left px-4 py-2 hover:bg-surface-muted text-ink transition-colors"
            >
              {task.urgent ? "Снять срочность" : "Пометить срочным"}
            </button>
            <button
              onClick={() => {
                setMenuOpen(false);
                onDelete(task.id);
              }}
              className="w-full text-left px-4 py-2 hover:bg-rose-soft text-rose transition-colors"
            >
              Удалить
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
