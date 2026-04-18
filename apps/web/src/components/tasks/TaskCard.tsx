"use client";

import { useState, useRef, useEffect, useMemo } from "react";
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
  if (dueStr < todayStr) return "alert";
  if (dueStr === todayStr) return "info";
  // within 3 days
  const diffMs = new Date(dueDate).getTime() - new Date(`${todayStr}T00:00:00+03:00`).getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  if (diffDays <= 3) return "warn";
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
  isOverdue?: boolean;
}

export function TaskCard({
  task,
  onComplete,
  onReopen,
  onUpdate,
  onDelete,
  onOpenEdit,
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

  const cardClasses = [
    "grid grid-cols-[28px_1fr_auto_auto_auto] gap-4 items-center py-3.5 px-5 border-b border-border bg-surface",
    "hover:bg-surface-muted transition-colors group",
    task.urgent && !isDone ? "border-l-4 border-rose" : "",
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
              ? "bg-teal border-teal text-white"
              : "bg-surface border-border-strong hover:border-teal"
          }`}
        >
          {isDone && (
            <svg width="12" height="10" viewBox="0 0 12 10" fill="none" aria-hidden>
              <path d="M1 5l3.5 3.5L11 1" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          )}
        </button>
      </span>

      {/* Заголовок + мета */}
      <div className="min-w-0">
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
            onClick={() => !isDone && setEditingTitle(true)}
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
      </div>

      {/* Исполнитель */}
      <TaskAssigneePill user={assignee} />

      {/* Дата */}
      <span>
        {task.dueDate ? (
          <StatusPill
            variant={pillVariant}
            label={formatDueDate(task.dueDate)}
          />
        ) : null}
      </span>

      {/* Overflow меню */}
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Действия с задачей"
          className="text-ink-3 hover:text-ink transition-colors opacity-0 group-hover:opacity-100 text-base leading-none px-0.5"
        >
          ⋯
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-6 z-50 bg-surface border border-border rounded-lg shadow-sm min-w-[200px] py-1 text-sm">
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
