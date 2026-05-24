"use client";

import { useCallback, useEffect, useState } from "react";

import { useCurrentUser } from "../../hooks/useCurrentUser";
import { StatusPill } from "../StatusPill";
import { toast } from "../ToastProvider";
import {
  addFeedbackComment,
  changeStatus,
  deleteFeedback,
  fetchFeedbackDetail,
} from "./api";
import {
  CATEGORY_META,
  STATUS_META,
  type FeedbackDetail,
  type FeedbackStatus,
} from "./types";

interface FeedbackDetailPanelProps {
  feedbackId: string | null;
  onClose: () => void;
  onChanged?: () => void;
}

const STATUS_FLOW: FeedbackStatus[] = ["NEW", "IN_PROGRESS", "DONE", "REJECTED"];

export function FeedbackDetailPanel({ feedbackId, onClose, onChanged }: FeedbackDetailPanelProps) {
  const { user } = useCurrentUser();
  const [detail, setDetail] = useState<FeedbackDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [submittingComment, setSubmittingComment] = useState(false);
  const [changingStatus, setChangingStatus] = useState(false);
  const [previewPhoto, setPreviewPhoto] = useState<string | null>(null);

  const isSuperAdmin = user?.role === "SUPER_ADMIN";

  const load = useCallback(async () => {
    if (!feedbackId) return;
    setLoading(true);
    try {
      const d = await fetchFeedbackDetail(feedbackId);
      setDetail(d);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось загрузить заявку");
      onClose();
    } finally {
      setLoading(false);
    }
  }, [feedbackId, onClose]);

  useEffect(() => {
    if (feedbackId) {
      setDetail(null);
      setCommentText("");
      void load();
    }
  }, [feedbackId, load]);

  // Esc to close
  useEffect(() => {
    if (!feedbackId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [feedbackId, onClose]);

  async function handleAddComment(e: React.FormEvent) {
    e.preventDefault();
    if (!detail || !commentText.trim() || submittingComment) return;
    setSubmittingComment(true);
    try {
      await addFeedbackComment(detail.id, commentText.trim());
      setCommentText("");
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось отправить");
    } finally {
      setSubmittingComment(false);
    }
  }

  async function handleStatusChange(next: FeedbackStatus) {
    if (!detail || changingStatus) return;
    setChangingStatus(true);
    try {
      await changeStatus(detail.id, next);
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось сменить статус");
    } finally {
      setChangingStatus(false);
    }
  }

  async function handleDelete() {
    if (!detail) return;
    if (!confirm("Удалить заявку и все комментарии?")) return;
    try {
      await deleteFeedback(detail.id);
      toast.success("Заявка удалена");
      onChanged?.();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось удалить");
    }
  }

  if (!feedbackId) return null;

  const meta = detail ? CATEGORY_META[detail.category] : null;
  const status = detail ? STATUS_META[detail.status] : null;
  const canDelete = !!(detail && (isSuperAdmin || user?.userId === detail.createdBy));

  return (
    <div className="fixed inset-0 z-[90] flex justify-end">
      <button
        type="button"
        aria-label="Закрыть"
        onClick={onClose}
        className="absolute inset-0 bg-ink/40 backdrop-blur-sm"
      />

      <section className="relative h-full w-full sm:max-w-xl bg-surface shadow-xl flex flex-col animate-slidein">
        {/* Header */}
        <header className="px-5 py-4 border-b border-border flex items-start justify-between gap-3 shrink-0">
          <div className="min-w-0 flex-1">
            {detail && meta ? (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-lg" aria-hidden>{meta.emoji}</span>
                  <span className="eyebrow">{meta.label}</span>
                  {status && <StatusPill variant={status.variant} label={status.label} />}
                </div>
                <h2 className="text-base font-semibold text-ink mt-1.5 leading-snug">{detail.title}</h2>
              </>
            ) : (
              <div className="h-12 w-3/4 bg-surface-subtle rounded animate-pulse" />
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="h-9 w-9 rounded-md hover:bg-surface-subtle flex items-center justify-center text-ink-2 shrink-0"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {loading && !detail && (
            <div className="space-y-3">
              <div className="h-4 bg-surface-subtle rounded animate-pulse w-2/3" />
              <div className="h-24 bg-surface-subtle rounded animate-pulse" />
            </div>
          )}

          {detail && (
            <>
              {/* Meta line */}
              <div className="text-xs text-ink-3 flex items-center gap-2 flex-wrap">
                <span>{detail.createdByUser?.username ?? "—"}</span>
                <span aria-hidden>·</span>
                <span>{new Date(detail.createdAt).toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                {detail.pageUrl && (
                  <>
                    <span aria-hidden>·</span>
                    <a href={detail.pageUrl} target="_blank" rel="noreferrer" className="underline hover:text-ink-2 truncate max-w-[200px]" title={detail.pageUrl}>
                      {new URL(detail.pageUrl).pathname}
                    </a>
                  </>
                )}
              </div>

              {/* Description */}
              <p className="text-sm text-ink whitespace-pre-wrap leading-relaxed">{detail.description}</p>

              {/* Photos */}
              {detail.photos.length > 0 && (
                <div>
                  <div className="eyebrow mb-2">Прикрепления ({detail.photos.length})</div>
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                    {detail.photos.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setPreviewPhoto(p.url)}
                        className="aspect-square rounded-md overflow-hidden border border-border bg-surface-subtle hover:border-ink-2"
                        aria-label="Открыть фото"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={p.url} alt="" className="h-full w-full object-cover" loading="lazy" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Status changer (SA only) */}
              {isSuperAdmin && (
                <div className="border-t border-border pt-4">
                  <div className="eyebrow mb-2">Статус</div>
                  <div className="flex gap-1.5 flex-wrap">
                    {STATUS_FLOW.map((s) => {
                      const active = detail.status === s;
                      const m = STATUS_META[s];
                      return (
                        <button
                          key={s}
                          type="button"
                          onClick={() => handleStatusChange(s)}
                          disabled={changingStatus || active}
                          className={`h-8 px-3 rounded-md text-xs font-semibold border transition-colors ${
                            active
                              ? "bg-ink text-surface border-ink cursor-default"
                              : "bg-surface text-ink-2 border-border hover:border-ink hover:bg-surface-subtle disabled:opacity-50"
                          }`}
                        >
                          {m.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Comments */}
              <div className="border-t border-border pt-4">
                <div className="eyebrow mb-2">Обсуждение ({detail.comments.length})</div>
                {detail.comments.length === 0 ? (
                  <div className="text-xs text-ink-3 italic mb-3">Комментариев пока нет.</div>
                ) : (
                  <ul className="space-y-3 mb-3">
                    {detail.comments.map((c) => (
                      <li key={c.id} className="text-sm">
                        <div className="text-xs text-ink-3 mb-0.5">
                          <span className="font-semibold text-ink-2">{c.authorUser?.username ?? "—"}</span>
                          <span aria-hidden> · </span>
                          {new Date(c.createdAt).toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                        </div>
                        <div className="text-ink whitespace-pre-wrap">{c.body}</div>
                      </li>
                    ))}
                  </ul>
                )}
                <form onSubmit={handleAddComment} className="flex gap-2">
                  <textarea
                    rows={2}
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                        e.preventDefault();
                        void handleAddComment(e as unknown as React.FormEvent);
                      }
                    }}
                    placeholder="Написать комментарий… (⌘/Ctrl+Enter)"
                    className="flex-1 px-3 py-2 rounded-md border border-border bg-surface text-sm resize-y min-h-[44px] focus:outline-none focus:ring-2 focus:ring-accent-bright/30"
                  />
                  <button
                    type="submit"
                    disabled={!commentText.trim() || submittingComment}
                    className="self-end h-10 px-3 rounded-md bg-accent-bright text-surface text-sm font-semibold hover:bg-accent disabled:opacity-50"
                  >
                    Отпр.
                  </button>
                </form>
              </div>

              {/* Footer actions */}
              {canDelete && (
                <div className="border-t border-border pt-4">
                  <button
                    type="button"
                    onClick={handleDelete}
                    className="text-xs text-rose hover:underline"
                  >
                    Удалить заявку
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* Photo preview lightbox */}
      {previewPhoto && (
        <button
          type="button"
          onClick={() => setPreviewPhoto(null)}
          className="fixed inset-0 z-[110] bg-ink/85 flex items-center justify-center p-4"
          aria-label="Закрыть просмотр"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewPhoto} alt="" className="max-h-full max-w-full object-contain rounded-md shadow-2xl" />
        </button>
      )}
    </div>
  );
}
