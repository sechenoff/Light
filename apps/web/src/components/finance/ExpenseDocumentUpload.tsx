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
  /** Called when user explicitly clicks "Готово" after upload — parent closes modal */
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

// M4: Use MIME type tracked from upload moment (not URL heuristic).
// Falls back to extension parsing if mime is unknown.
function isPdfByMime(mime: string | null, url: string): boolean {
  if (mime === "application/pdf") return true;
  if (mime && mime.startsWith("image/")) return false;
  // Fallback: try extension from stored relative path
  const lower = url.toLowerCase();
  return lower.includes(".pdf");
}

// ── Upload progress bar ───────────────────────────────────────────────────────

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="w-full bg-surface-subtle rounded-full h-1.5 overflow-hidden">
      <div
        className="h-full bg-accent-bright transition-all duration-100"
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
  // M4: track MIME type from the file chosen at upload time
  const [currentMime, setCurrentMime] = useState<string | null>(null);

  function showError(message: string) {
    toast.error(message);
    onError?.(message);
  }

  // M5: Use XMLHttpRequest for real upload progress
  function handleFile(file: File) {
    if (file.size > MAX_FILE_SIZE) {
      showError("Файл превышает 5 МБ. Загрузите меньший файл.");
      return;
    }
    if (!isAllowedType(file)) {
      showError("Неподдерживаемый формат. Допустимы: JPEG, PNG, PDF.");
      return;
    }
    if (!expenseId) {
      showError("Сохраните расход сначала, затем загрузите документ.");
      return;
    }

    setUploading(true);
    setProgress(0);

    const formData = new FormData();
    formData.append("document", file);

    const xhr = new XMLHttpRequest();

    // M5: real progress events
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) {
        setProgress(Math.round((e.loaded / e.total) * 100));
      }
    });

    xhr.addEventListener("load", () => {
      setUploading(false);
      setProgress(0);

      if (xhr.status < 200 || xhr.status >= 300) {
        let msg = "Ошибка загрузки документа";
        try {
          const json = JSON.parse(xhr.responseText);
          if (typeof json?.message === "string") msg = json.message;
        } catch {
          // ignore
        }
        showError(msg);
        return;
      }

      let url = `/api/expenses/${expenseId}/document`;
      try {
        const data = JSON.parse(xhr.responseText);
        if (data?.documentUrl) url = data.documentUrl;
      } catch {
        // ignore
      }

      // M4: capture MIME from the file chosen, not from URL heuristic
      setCurrentMime(file.type);
      setCurrentDocUrl(url);
      toast.success("Документ загружен");
      // P2: do NOT call onUploaded here — user must click «Готово» to confirm
    });

    xhr.addEventListener("error", () => {
      setUploading(false);
      setProgress(0);
      showError("Ошибка загрузки. Проверьте соединение.");
    });

    xhr.open("POST", `/api/expenses/${expenseId}/document`);
    xhr.withCredentials = true;
    xhr.send(formData);
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
        setCurrentMime(null);
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
    const looksLikePdf = isPdfByMime(currentMime, currentDocUrl);
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
        {/* P2: action buttons — Заменить / Удалить */}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              // P2: "Заменить" clears preview and returns to upload zone
              setCurrentDocUrl(null);
              setCurrentMime(null);
            }}
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
          {/* P2: explicit «Готово» triggers onUploaded — parent closes modal */}
          <button
            type="button"
            onClick={() => onUploaded(currentDocUrl)}
            className="text-xs px-2.5 py-1 bg-accent text-white rounded hover:bg-accent-bright ml-auto"
          >
            Готово
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
