"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch } from "../../lib/api";
import { toast } from "../ToastProvider";
import type { Task } from "./groupTasks";

export interface TaskComment {
  id: string;
  taskId: string;
  authorId: string;
  body: string;
  createdAt: string;
  authorUser: { id: string; username: string } | null;
}

export interface ChecklistItem {
  id: string;
  taskId: string;
  text: string;
  done: boolean;
  position: number;
  completedAt: string | null;
  completedBy: string | null;
  createdAt: string;
}

export interface TaskDetail extends Task {
  comments: TaskComment[];
  checklist: ChecklistItem[];
}

const PANEL_POLL_MS = 8000;

export function useTaskDetail(taskId: string | null) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const inFlight = useRef<Set<string>>(new Set());
  const pollBlocked = useRef(false);

  const fetchTask = useCallback(async () => {
    if (!taskId) return;
    try {
      const { task: t } = await apiFetch<{ task: TaskDetail }>(`/api/tasks/${taskId}`);
      if (pollBlocked.current) return;
      setTask(t);
      setNotFound(false);
    } catch (err: any) {
      if (err?.status === 404) {
        setNotFound(true);
      }
    }
  }, [taskId]);

  // Initial load
  useEffect(() => {
    if (!taskId) {
      setTask(null);
      setNotFound(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setTask(null);
    apiFetch<{ task: TaskDetail }>(`/api/tasks/${taskId}`)
      .then((d) => { if (!cancelled) { setTask(d.task); setNotFound(false); } })
      .catch((err: any) => { if (!cancelled && err?.status === 404) setNotFound(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [taskId]);

  // Visibility-paused polling
  useEffect(() => {
    if (!taskId) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      timer = setInterval(() => { void fetchTask(); }, PANEL_POLL_MS);
    };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVis = () => {
      if (document.hidden) stop();
      else { void fetchTask(); start(); }
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVis);
    return () => { stop(); document.removeEventListener("visibilitychange", onVis); };
  }, [taskId, fetchTask]);

  // ── addComment (optimistic) ──
  const addComment = useCallback(async (body: string) => {
    const trimmed = body.trim();
    if (!trimmed || !taskId) return;
    pollBlocked.current = true;
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const optimistic: TaskComment = {
      id: tempId, taskId, authorId: "", body: trimmed,
      createdAt: new Date().toISOString(), authorUser: null,
    };
    setTask((t) => (t ? { ...t, comments: [...t.comments, optimistic] } : t));
    try {
      const { comment } = await apiFetch<{ comment: TaskComment }>(`/api/tasks/${taskId}/comments`, {
        method: "POST", body: JSON.stringify({ body: trimmed }),
      });
      setTask((t) => (t ? { ...t, comments: t.comments.map((c) => (c.id === tempId ? comment : c)) } : t));
    } catch (err: any) {
      setTask((t) => (t ? { ...t, comments: t.comments.filter((c) => c.id !== tempId) } : t));
      toast.error(err?.message ?? "Не удалось добавить комментарий");
    } finally {
      pollBlocked.current = false;
    }
  }, [taskId]);

  // ── deleteComment (optimistic) ──
  const deleteComment = useCallback(async (commentId: string) => {
    if (!taskId) return;
    pollBlocked.current = true;
    let snapshot: TaskComment[] | undefined;
    setTask((t) => {
      if (!t) return t;
      snapshot = t.comments;
      return { ...t, comments: t.comments.filter((c) => c.id !== commentId) };
    });
    try {
      await apiFetch(`/api/tasks/${taskId}/comments/${commentId}`, { method: "DELETE" });
    } catch (err: any) {
      setTask((t) => (t && snapshot ? { ...t, comments: snapshot } : t));
      toast.error(err?.message ?? "Не удалось удалить комментарий");
    } finally {
      pollBlocked.current = false;
    }
  }, [taskId]);

  // ── addChecklistItem (optimistic) ──
  const addChecklistItem = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !taskId) return;
    pollBlocked.current = true;
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setTask((t) => {
      if (!t) return t;
      const pos = t.checklist.length;
      const optimistic: ChecklistItem = {
        id: tempId, taskId, text: trimmed, done: false, position: pos,
        completedAt: null, completedBy: null, createdAt: new Date().toISOString(),
      };
      return { ...t, checklist: [...t.checklist, optimistic] };
    });
    try {
      const { item } = await apiFetch<{ item: ChecklistItem }>(`/api/tasks/${taskId}/checklist`, {
        method: "POST", body: JSON.stringify({ text: trimmed }),
      });
      setTask((t) => (t ? { ...t, checklist: t.checklist.map((i) => (i.id === tempId ? item : i)) } : t));
    } catch (err: any) {
      setTask((t) => (t ? { ...t, checklist: t.checklist.filter((i) => i.id !== tempId) } : t));
      toast.error(err?.message ?? "Не удалось добавить пункт");
    } finally {
      pollBlocked.current = false;
    }
  }, [taskId]);

  // ── toggleChecklistItem (optimistic) ──
  const toggleChecklistItem = useCallback(async (itemId: string, done: boolean) => {
    if (!taskId || inFlight.current.has(`cl-${itemId}`)) return;
    inFlight.current.add(`cl-${itemId}`);
    pollBlocked.current = true;
    let snapshot: ChecklistItem | undefined;
    setTask((t) => {
      if (!t) return t;
      snapshot = t.checklist.find((i) => i.id === itemId);
      return { ...t, checklist: t.checklist.map((i) => (i.id === itemId ? { ...i, done } : i)) };
    });
    try {
      const { item } = await apiFetch<{ item: ChecklistItem }>(`/api/tasks/${taskId}/checklist/${itemId}`, {
        method: "PATCH", body: JSON.stringify({ done }),
      });
      setTask((t) => (t ? { ...t, checklist: t.checklist.map((i) => (i.id === itemId ? item : i)) } : t));
    } catch (err: any) {
      setTask((t) => (t && snapshot ? { ...t, checklist: t.checklist.map((i) => (i.id === itemId ? snapshot! : i)) } : t));
      toast.error(err?.message ?? "Не удалось обновить пункт");
    } finally {
      inFlight.current.delete(`cl-${itemId}`);
      pollBlocked.current = false;
    }
  }, [taskId]);

  // ── deleteChecklistItem (optimistic) ──
  const deleteChecklistItem = useCallback(async (itemId: string) => {
    if (!taskId) return;
    pollBlocked.current = true;
    let snapshot: ChecklistItem[] | undefined;
    setTask((t) => {
      if (!t) return t;
      snapshot = t.checklist;
      return { ...t, checklist: t.checklist.filter((i) => i.id !== itemId) };
    });
    try {
      await apiFetch(`/api/tasks/${taskId}/checklist/${itemId}`, { method: "DELETE" });
    } catch (err: any) {
      setTask((t) => (t && snapshot ? { ...t, checklist: snapshot } : t));
      toast.error(err?.message ?? "Не удалось удалить пункт");
    } finally {
      pollBlocked.current = false;
    }
  }, [taskId]);

  return {
    task, loading, notFound,
    addComment, deleteComment,
    addChecklistItem, toggleChecklistItem, deleteChecklistItem,
    refetch: fetchTask,
  };
}
