"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import { toast } from "../ToastProvider";

type Tone = "polite" | "friendly" | "firm";

interface ReminderResult {
  subject: string;
  body: string;
  generatedBy: "gemini" | "fallback";
}

export interface AIReminderModalProps {
  open: boolean;
  onClose: () => void;
  clientId: string;
  clientName: string;
  totalOutstanding: string;
  onReminded?: () => void;
  clientEmail?: string | null;
}

const TONE_LABELS: Record<Tone, string> = {
  polite: "Вежливо",
  friendly: "Дружелюбно",
  firm: "Жёстко",
};

export function AIReminderModal({
  open,
  onClose,
  clientId,
  clientName,
  totalOutstanding,
  onReminded,
  clientEmail,
}: AIReminderModalProps) {
  const [tone, setTone] = useState<Tone>("polite");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ReminderResult | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [marking, setMarking] = useState(false);
  const fetchedToneRef = useRef<Tone | null>(null);

  // Fetch reminder when modal opens or tone changes
  useEffect(() => {
    if (!open) return;
    // Avoid re-fetch if same tone already fetched
    if (fetchedToneRef.current === tone && result !== null) return;

    let cancelled = false;
    setLoading(true);
    setResult(null);

    apiFetch<ReminderResult>(`/api/finance/debts/${clientId}/draft-reminder`, {
      method: "POST",
      body: JSON.stringify({ tone }),
    })
      .then((data) => {
        if (cancelled) return;
        fetchedToneRef.current = tone;
        setResult(data);
        setSubject(data.subject);
        setBody(data.body);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoading(false);
        toast.error(err?.message ?? "Ошибка генерации напоминания");
      });

    return () => { cancelled = true; };
  }, [open, clientId, tone]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset when modal closes
  useEffect(() => {
    if (!open) {
      setResult(null);
      setSubject("");
      setBody("");
      setTone("polite");
      fetchedToneRef.current = null;
    }
  }, [open]);

  function handleToneChange(newTone: Tone) {
    setTone(newTone);
    fetchedToneRef.current = null; // force re-fetch
    setResult(null);
  }

  async function handleCopy() {
    const text = `${subject}\n\n${body}`;
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Скопировано");
    } catch {
      toast.error("Не удалось скопировать");
    }
  }

  async function handleMarkReminded() {
    setMarking(true);
    try {
      await apiFetch(`/api/finance/debts/${clientId}/mark-reminded`, {
        method: "POST",
      });
      onReminded?.();
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Ошибка";
      toast.error(msg);
    } finally {
      setMarking(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") onClose();
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      aria-label="Напоминание об оплате"
    >
      <div className="bg-surface border border-border rounded-xl shadow-lg w-full max-w-lg max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-start justify-between px-5 pt-5 pb-4 border-b border-border">
          <div>
            <p className="eyebrow text-ink-3">ИИ-ПОМОЩНИК</p>
            <h2 className="text-[17px] font-semibold text-ink mt-0.5">
              Напоминание для {clientName}
            </h2>
            <p className="text-[12px] text-ink-2 mt-0.5">{totalOutstanding}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="w-8 h-8 rounded border border-border flex items-center justify-center text-ink-2 hover:bg-surface-subtle text-lg leading-none"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Loading */}
          {loading && (
            <div className="flex flex-col items-center py-10 gap-3" role="status">
              <div className="w-7 h-7 border-2 border-accent-bright border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-ink-2">Готовлю напоминание…</p>
            </div>
          )}

          {/* Result */}
          {!loading && result && (
            <>
              {/* Tone switcher */}
              <div>
                <p className="text-[11px] text-ink-3 eyebrow mb-2">Тон</p>
                <div className="flex border border-border rounded-lg overflow-hidden">
                  {(["polite", "friendly", "firm"] as Tone[]).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => handleToneChange(t)}
                      className={`flex-1 px-3 py-2 text-[12px] font-medium transition-colors ${
                        tone === t
                          ? "bg-accent-bright text-white"
                          : "bg-surface-subtle text-ink-2 hover:bg-surface border-l border-border first:border-l-0"
                      }`}
                    >
                      {TONE_LABELS[t]}
                    </button>
                  ))}
                </div>
              </div>

              {/* AI badge */}
              <div className="flex items-center gap-2">
                {result.generatedBy === "gemini" ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-accent-soft text-accent-bright text-[11px] font-medium rounded-full border border-accent-border">
                    ✨ Сгенерировано Gemini
                  </span>
                ) : (
                  <span className="text-[11px] text-ink-3">
                    Использован шаблон (Gemini недоступен)
                  </span>
                )}
              </div>

              {/* Subject */}
              <div>
                <label className="block text-[11px] text-ink-3 eyebrow mb-1.5">Тема</label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="w-full border border-border rounded-lg px-3 py-2 text-[13px] bg-surface focus:outline-none focus:border-accent-bright"
                />
              </div>

              {/* Body */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[11px] text-ink-3 eyebrow">Текст</label>
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="text-[11px] text-accent-bright hover:underline"
                  >
                    📋 Копировать всё
                  </button>
                </div>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={10}
                  className="w-full border border-border rounded-lg px-3 py-2 text-[13px] bg-surface focus:outline-none focus:border-accent-bright resize-none font-mono"
                />
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        {!loading && result && (
          <div className="px-5 pb-5 pt-0 flex flex-wrap gap-2 justify-between items-center">
            {/* Send options */}
            <div className="flex gap-2 flex-wrap">
              <button
                type="button"
                onClick={handleCopy}
                className="px-3.5 py-2 text-[12px] border border-border rounded-lg bg-surface hover:bg-surface-subtle"
              >
                📋 Скопировать
              </button>
              <a
                href={
                  clientEmail
                    ? `mailto:${clientEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
                    : "#"
                }
                onClick={!clientEmail ? (e) => e.preventDefault() : undefined}
                title={!clientEmail ? "Email не указан" : undefined}
                className={`px-3.5 py-2 text-[12px] border border-border rounded-lg inline-flex items-center ${
                  clientEmail
                    ? "bg-surface hover:bg-surface-subtle"
                    : "bg-surface-subtle text-ink-3 cursor-not-allowed opacity-60"
                }`}
              >
                ✉️ Email
              </a>
              <button
                type="button"
                disabled
                title="В разработке"
                className="px-3.5 py-2 text-[12px] border border-border rounded-lg bg-surface-subtle text-ink-3 cursor-not-allowed opacity-60"
              >
                💬 Telegram
              </button>
            </div>

            {/* Mark reminded */}
            <button
              type="button"
              onClick={handleMarkReminded}
              disabled={marking}
              className="px-4 py-2 text-[12px] font-medium bg-accent-bright text-white rounded-lg hover:opacity-90 disabled:opacity-60"
            >
              {marking ? "…" : "✅ Отметить как отправлено"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
