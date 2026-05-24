"use client";

import { useEffect, useRef, useState } from "react";

import { toast } from "../ToastProvider";
import { createFeedback, uploadFeedbackPhotos } from "./api";
import { CATEGORY_META, type FeedbackCategory } from "./types";

interface FeedbackComposerProps {
  open: boolean;
  onClose: () => void;
  onCreated?: (id: string) => void;
  /** Pre-fill category (e.g. when opened from a context button) */
  defaultCategory?: FeedbackCategory;
}

const CATEGORIES: FeedbackCategory[] = ["BUG", "IDEA", "COMMENT"];

const MAX_FILES = 6;
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/png"];

export function FeedbackComposer({ open, onClose, onCreated, defaultCategory }: FeedbackComposerProps) {
  const [category, setCategory] = useState<FeedbackCategory>(defaultCategory ?? "BUG");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);

  // Auto-captured context (only meaningful on the client)
  const [pageUrl, setPageUrl] = useState("");
  const [viewport, setViewport] = useState("");

  // Reset + capture context on open
  useEffect(() => {
    if (!open) return;
    setCategory(defaultCategory ?? "BUG");
    setTitle("");
    setDescription("");
    setFiles([]);
    if (typeof window !== "undefined") {
      setPageUrl(window.location.href);
      setViewport(`${window.innerWidth}×${window.innerHeight}`);
    }
    // Focus title shortly after slide-in
    const t = setTimeout(() => titleRef.current?.focus(), 180);
    return () => clearTimeout(t);
  }, [open, defaultCategory]);

  // Esc to close + lock scroll
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  function handleFilesPicked(picked: FileList | null) {
    if (!picked) return;
    const incoming = Array.from(picked).filter((f) => {
      if (!ALLOWED_TYPES.includes(f.type)) {
        toast.error(`«${f.name}» — только JPEG/PNG`);
        return false;
      }
      if (f.size > MAX_FILE_SIZE) {
        toast.error(`«${f.name}» — больше 5 МБ`);
        return false;
      }
      return true;
    });
    setFiles((prev) => {
      const merged = [...prev, ...incoming];
      if (merged.length > MAX_FILES) {
        toast.info(`Максимум ${MAX_FILES} файлов`);
        return merged.slice(0, MAX_FILES);
      }
      return merged;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const t = title.trim();
    const d = description.trim();
    if (t.length < 3) { toast.error("Слишком короткий заголовок"); return; }
    if (d.length < 3) { toast.error("Опишите подробнее"); return; }

    setSubmitting(true);
    try {
      const created = await createFeedback({
        category,
        title: t,
        description: d,
        pageUrl: pageUrl || null,
        viewport: viewport || null,
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
      });
      if (files.length > 0) {
        try {
          await uploadFeedbackPhotos(created.id, files);
        } catch (err) {
          // Заявка уже создана — фото можно прикрепить позже
          toast.error(err instanceof Error ? err.message : "Не удалось загрузить фото");
        }
      }
      toast.success("Спасибо! Заявка отправлена");
      onCreated?.(created.id);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось отправить");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex justify-end">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Закрыть форму обратной связи"
        onClick={onClose}
        className="absolute inset-0 bg-ink/40 backdrop-blur-sm"
      />

      {/* Panel */}
      <form
        onSubmit={handleSubmit}
        className="relative h-full w-full sm:max-w-md bg-surface shadow-xl flex flex-col animate-slidein"
      >
        {/* Header */}
        <header className="px-5 py-4 border-b border-border flex items-center justify-between shrink-0">
          <div>
            <div className="eyebrow">Новая заявка</div>
            <div className="text-base font-semibold text-ink mt-0.5">Сообщить об улучшении</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="h-9 w-9 rounded-md hover:bg-surface-subtle flex items-center justify-center text-ink-2"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        {/* Body (scrollable) */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Category */}
          <div>
            <div className="eyebrow mb-2">Тип</div>
            <div className="grid grid-cols-3 gap-1.5">
              {CATEGORIES.map((c) => {
                const meta = CATEGORY_META[c];
                const active = category === c;
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCategory(c)}
                    className={`h-auto py-2.5 px-2 rounded-md border text-left transition-colors ${
                      active
                        ? "bg-accent-soft border-accent-border text-accent"
                        : "bg-surface border-border text-ink-2 hover:border-ink hover:bg-surface-subtle"
                    }`}
                  >
                    <div className="text-lg leading-none" aria-hidden>{meta.emoji}</div>
                    <div className="text-xs font-semibold mt-1 leading-tight">{meta.label}</div>
                  </button>
                );
              })}
            </div>
            <div className="text-xs text-ink-3 mt-1.5 italic">
              {CATEGORY_META[category].description}
            </div>
          </div>

          {/* Title */}
          <div>
            <label className="eyebrow block mb-1.5" htmlFor="fb-title">Заголовок</label>
            <input
              id="fb-title"
              ref={titleRef}
              type="text"
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Коротко: что произошло или что предложить"
              className="w-full h-10 px-3 rounded-md border border-border bg-surface text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-bright/30 focus:border-accent-bright"
            />
          </div>

          {/* Description */}
          <div>
            <label className="eyebrow block mb-1.5" htmlFor="fb-desc">Описание</label>
            <textarea
              id="fb-desc"
              maxLength={4000}
              rows={6}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Что случилось? Шаги для воспроизведения. Что ожидалось. Любой контекст."
              className="w-full px-3 py-2 rounded-md border border-border bg-surface text-sm text-ink resize-y min-h-[120px] focus:outline-none focus:ring-2 focus:ring-accent-bright/30 focus:border-accent-bright"
            />
            <div className="text-[10px] text-ink-3 mono-num mt-1">{description.length} / 4000</div>
          </div>

          {/* Photos */}
          <div>
            <div className="flex items-baseline justify-between mb-1.5">
              <div className="eyebrow">Скриншоты / фото</div>
              <div className="text-[10px] text-ink-3 mono-num">{files.length} / {MAX_FILES}</div>
            </div>
            <div className="flex gap-2 flex-wrap">
              {files.map((f, idx) => (
                <FilePreview
                  key={`${f.name}-${idx}`}
                  file={f}
                  onRemove={() => setFiles((prev) => prev.filter((_, i) => i !== idx))}
                />
              ))}
              {files.length < MAX_FILES && (
                <button
                  type="button"
                  onClick={() => filesInputRef.current?.click()}
                  className="h-16 w-16 rounded-md border border-dashed border-border bg-surface-subtle hover:bg-surface-muted hover:border-ink-2 flex items-center justify-center text-ink-3 hover:text-ink-2 transition-colors"
                  aria-label="Добавить фото"
                  title="JPEG / PNG до 5 МБ"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
              )}
            </div>
            <input
              ref={filesInputRef}
              type="file"
              multiple
              accept="image/jpeg,image/png"
              className="hidden"
              onChange={(e) => { handleFilesPicked(e.target.files); e.target.value = ""; }}
            />
            <div className="text-[10px] text-ink-3 mt-1.5">JPEG / PNG, до 5 МБ каждый.</div>
          </div>

          {/* Context (auto-captured, read-only) */}
          {(pageUrl || viewport) && (
            <details className="text-xs text-ink-3">
              <summary className="cursor-pointer hover:text-ink-2 select-none py-1">
                Авто-захваченный контекст
              </summary>
              <dl className="mt-2 space-y-1 pl-3 border-l-2 border-border">
                {pageUrl && (
                  <div>
                    <dt className="font-semibold text-ink-2">Страница</dt>
                    <dd className="break-all mono-num text-[10px]">{pageUrl}</dd>
                  </div>
                )}
                {viewport && (
                  <div>
                    <dt className="font-semibold text-ink-2">Окно</dt>
                    <dd className="mono-num">{viewport}</dd>
                  </div>
                )}
              </dl>
            </details>
          )}
        </div>

        {/* Footer */}
        <footer className="border-t border-border px-5 py-3 flex gap-2 shrink-0 bg-surface">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 h-10 rounded-md border border-border text-sm font-semibold text-ink-2 hover:bg-surface-subtle"
            disabled={submitting}
          >
            Отмена
          </button>
          <button
            type="submit"
            disabled={submitting || title.trim().length < 3 || description.trim().length < 3}
            className="flex-1 h-10 rounded-md bg-accent-bright text-surface text-sm font-semibold hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? "Отправляю…" : "Отправить"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function FilePreview({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url, setUrl] = useState<string>("");
  useEffect(() => {
    const objUrl = URL.createObjectURL(file);
    setUrl(objUrl);
    return () => URL.revokeObjectURL(objUrl);
  }, [file]);
  return (
    <div className="relative h-16 w-16 rounded-md overflow-hidden border border-border bg-surface-subtle">
      {url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={file.name} className="h-full w-full object-cover" />
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Удалить ${file.name}`}
        className="absolute top-0.5 right-0.5 h-5 w-5 rounded-full bg-ink/70 text-surface text-xs leading-none flex items-center justify-center hover:bg-ink"
      >
        ×
      </button>
    </div>
  );
}
