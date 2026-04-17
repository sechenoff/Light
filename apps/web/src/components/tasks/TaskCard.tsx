"use client";

import { useState, useRef, useEffect } from "react";
import { StatusPill } from "../StatusPill";
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

function initials(username: string | null | undefined): string {
  if (!username) return "?";
  return username.charAt(0).toUpperCase();
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
  const now = new Date();

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

  const cardClasses = [
    "flex items-center gap-3 px-4 py-3 border-b border-border bg-surface",
    "hover:bg-surface-muted transition-colors group",
    task.urgent ? "border-l-4 border-rose" : "",
    isOverdue ? "bg-rose-soft/40" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cardClasses}>
      {/* Чекбокс */}
      <input
        type="checkbox"
        checked={isDone}
        onChange={handleCheckbox}
        aria-label="Отметить выполненным"
        className="shrink-0 w-4 h-4 rounded-sm accent-teal cursor-pointer"
      />

      {/* Заголовок */}
      <div className="flex-1 min-w-0">
        {editingTitle ? (
          <input
            ref={inputRef}
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={handleTitleSave}
            onKeyDown={handleTitleKeyDown}
            className="w-full text-sm text-ink bg-surface-muted rounded px-1 py-0.5 border border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
        ) : (
          <span
            onClick={() => !isDone && setEditingTitle(true)}
            className={`text-sm cursor-text select-none ${
              isDone ? "line-through text-ink-3 opacity-60" : "text-ink"
            }`}
          >
            {task.title}
          </span>
        )}
      </div>

      {/* Правый блок: аватар + дата + срочность + меню */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Аватар исполнителя */}
        {assignee && (
          <span
            title={assignee.username}
            className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-accent-soft text-accent text-xs font-semibold cursor-default"
          >
            {initials(assignee.username)}
          </span>
        )}

        {/* Дата */}
        {task.dueDate ? (
          <StatusPill
            variant={pillVariant}
            label={formatDueDate(task.dueDate)}
          />
        ) : null}

        {/* Срочность */}
        <button
          onClick={() => onUpdate(task.id, { urgent: !task.urgent })}
          aria-label={task.urgent ? "Снять срочность" : "Пометить срочным"}
          className={`text-sm transition-colors ${
            task.urgent
              ? "text-rose"
              : "text-ink-3 opacity-0 group-hover:opacity-100"
          }`}
        >
          !
        </button>

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
            <div className="absolute right-0 top-6 z-50 bg-surface border border-border rounded-lg shadow-sm min-w-[180px] py-1 text-sm">
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
    </div>
  );
}
