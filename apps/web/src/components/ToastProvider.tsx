"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

// ── Types ─────────────────────────────────────────────────────────────────────

type ToastKind = "error" | "success" | "info";

type Toast = { id: string; kind: ToastKind; msg: string };

// ── Singleton event bus ───────────────────────────────────────────────────────

const listeners: Set<(t: Toast) => void> = new Set();

function push(kind: ToastKind, msg: string): void {
  const id = Math.random().toString(36).slice(2);
  const t: Toast = { id, kind, msg };
  listeners.forEach((fn) => fn(t));
}

export const toast = {
  error: (msg: string) => push("error", msg),
  success: (msg: string) => push("success", msg),
  info: (msg: string) => push("info", msg),
};

// ── Styles ────────────────────────────────────────────────────────────────────

const KIND_STYLES: Record<ToastKind, { stripe: string; icon: string }> = {
  error:   { stripe: "border-l-rose",    icon: "✕" },
  success: { stripe: "border-l-emerald", icon: "✓" },
  info:    { stripe: "border-l-accent-bright", icon: "ℹ" },
};

const KIND_ICON_COLOR: Record<ToastKind, string> = {
  error:   "text-rose",
  success: "text-emerald",
  info:    "text-accent-bright",
};

// ── ToastItem ─────────────────────────────────────────────────────────────────

function ToastItem({ t, onDismiss }: { t: Toast; onDismiss: (id: string) => void }) {
  const { stripe } = KIND_STYLES[t.kind];
  const iconColor = KIND_ICON_COLOR[t.kind];

  return (
    <div
      className={`flex items-start gap-3 bg-white border border-border rounded-lg shadow-sm px-4 py-3 min-w-[260px] max-w-[360px] border-l-4 ${stripe}`}
      role="alert"
    >
      <span className={`shrink-0 font-semibold text-sm ${iconColor}`}>
        {KIND_STYLES[t.kind].icon}
      </span>
      <span className="text-sm text-ink flex-1">{t.msg}</span>
      <button
        onClick={() => onDismiss(t.id)}
        className="shrink-0 text-ink-3 hover:text-ink transition-colors text-xs leading-none"
        aria-label="Закрыть"
      >
        ✕
      </button>
    </div>
  );
}

// ── ToastProvider ─────────────────────────────────────────────────────────────

export function ToastProvider() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  useEffect(() => {
    const handler = (t: Toast) => {
      setToasts((prev) => [...prev, t]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== t.id));
      }, 4000);
    };
    listeners.add(handler);
    return () => { listeners.delete(handler); };
  }, []);

  const dismiss = (id: string) => {
    setToasts((prev) => prev.filter((x) => x.id !== id));
  };

  if (!mounted) return null;

  return createPortal(
    <div className="fixed bottom-6 right-6 flex flex-col gap-2 z-[100]" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} t={t} onDismiss={dismiss} />
      ))}
    </div>,
    document.body,
  );
}
