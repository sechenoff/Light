"use client";

import { useRef, useState } from "react";
import { toast } from "../ToastProvider";

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const ALLOWED_TYPES = ["image/jpeg", "image/png", "application/pdf"];
const ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".pdf"];

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExpenseDocumentUploadProps {
  /** null when creating a new expense (upload happens after save) */
  expenseId: string | null;
  existingDocumentUrl: string | null;
  onUploaded: (documentUrl: string) => void;
  onError?: (message: string) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isAllowedType(file: File): boolean {
  if (ALLOWED_TYPES.includes(file.type)) return true;
  // Fallback: check extension
  const name = file.name.toLowerCase();
  return ALLOWED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function isPdf(url: string): boolean {
  return url.toLowerCase().includes("pdf") || url.toLowerCase().endsWith("/document");
}

// ── Upload progress bar ───────────────────────────────────────────────────────

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="w-full bg-surface-subtle rounded-full h-1.5 overflow-hidden">
      <div
        className="h-full bg-accent-bright transition-all duration-300"
        style={{ width: `${value}%` }}
      />
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ExpenseDocumentUpload({
  expenseId,
  existingDocumentUrl,
  onUploaded,
  onError,
}: ExpenseDocumentUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentDocUrl, setCurrentDocUrl] = useState<string | null>(existingDocumentUrl);

  function showError(message: string) {
    toast.error(message);
    onError?.(message);
  }

  async function handleFile(file: File) {
    if (file.size > MAX_FILE_SIZE) {
      showError("Файл превышает 5 МБ. Загрузите меньший файл.");
      return;
    }
    if (!isAllowedType(file)) {
      showError("Неподдерживаемый формат. Допустимы: JPEG, PNG, PDF.");
      return;
    }
    if (!expenseId) {
      // Deferred upload: store file for parent to handle after save
      showError("Сохраните расход сначала, затем загрузите документ.");
      return;
    }

    setUploading(true);
    setProgress(10);

    try {
      const formData = new FormData();
      formData.append("document", file);

      // Simulate progress increments
      const progressInterval = setInterval(() => {
        setProgress((p) => Math.min(p + 20, 85));
      }, 200);

      const res = await fetch(`/api/expenses/${expenseId}/document`, {
        method: "POST",
        body: formData,
        credentials: "include",
      });

      clearInterval(progressInterval);
      setProgress(100);

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let msg = "Ошибка загрузки документа";
        try {
          const json = JSON.parse(text);
          if (typeof json?.message === "string") msg = json.message;
        } catch {
          // ignore
        }
        showError(msg);
        return;
      }

      const data = await res.json();
      const url: string = data.documentUrl ?? `/api/expenses/${expenseId}/document`;
      setCurrentDocUrl(url);
      onUploaded(url);
      toast.success("Документ загружен");
    } catch {
      showError("Ошибка загрузки. Проверьте соединение.");
    } finally {
      setUploading(false);
      setProgress(0);
    }
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    // Reset input so same file can be re-uploaded
    e.target.value = "";
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  async function handleDelete() {
    if (!expenseId || !currentDocUrl) return;
    if (!confirm("Удалить прикреплённый документ?")) return;
    try {
      const res = await fetch(`/api/expenses/${expenseId}/document`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) {
        setCurrentDocUrl(null);
        onUploaded("");
        toast.success("Документ удалён");
      } else {
        toast.error("Не удалось удалить документ");
      }
    } catch {
      toast.error("Ошибка удаления");
    }
  }

  // ── Render existing document preview ───────────────────────────────────────

  if (currentDocUrl) {
    const looksLikePdf = isPdf(currentDocUrl);
    return (
      <div className="border border-border rounded-[6px] p-3 bg-surface-subtle space-y-2">
        <p className="eyebrow text-ink-3">Документ</p>
        <div className="flex items-center gap-3">
          {looksLikePdf ? (
            <span className="text-3xl" aria-hidden>📄</span>
          ) : (
            <span className="text-3xl" aria-hidden>🖼️</span>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-medium text-ink">Прикреплён документ</p>
            <a
              href={currentDocUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11.5px] text-accent hover:underline"
              aria-label="Скачать документ"
            >
              Скачать
            </a>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="text-xs px-2.5 py-1 border border-border rounded hover:bg-surface bg-surface-subtle text-ink-2"
            aria-label="Заменить документ"
          >
            Заменить
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={uploading}
            className="text-xs px-2.5 py-1 border border-rose-border rounded hover:bg-rose-soft text-rose bg-surface"
            aria-label="Удалить документ"
          >
            Удалить
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".jpg,.jpeg,.png,.pdf"
          className="sr-only"
          onChange={handleInputChange}
          aria-label="Выбрать новый файл для замены"
        />
      </div>
    );
  }

  // ── Render upload zone ──────────────────────────────────────────────────────

  return (
    <div className="space-y-2">
      <p className="eyebrow text-ink-3">Документ</p>
      <div
        className={`border-2 border-dashed rounded-[6px] p-4 text-center transition-colors ${
          uploading ? "border-accent bg-accent-soft" : "border-border hover:border-accent-border bg-surface-subtle"
        }`}
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
      >
        <p className="text-[13px] text-ink-2 mb-2">
          {uploading ? "Загрузка…" : "Перетащите файл или нажмите кнопку"}
        </p>
        <p className="text-[11px] text-ink-3 mb-3">JPEG, PNG или PDF · не более 5 МБ</p>
        {uploading ? (
          <ProgressBar value={progress} />
        ) : (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="text-xs px-3 py-1.5 rounded border border-border bg-surface hover:bg-surface-subtle text-ink-2"
            aria-label="Выбрать файл"
          >
            Выбрать файл
          </button>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".jpg,.jpeg,.png,.pdf"
        className="sr-only"
        onChange={handleInputChange}
        aria-label="Файл документа расхода"
      />
    </div>
  );
}
