"use client";

import React, { useState, useEffect, useRef } from "react";
import { apiFetch } from "@/lib/api";

type PricelistMeta =
  | { exists: false }
  | { exists: true; filename: string; size: number; uploadedAt: string };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function PricelistTab() {
  const [meta, setMeta] = useState<PricelistMeta | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function loadMeta() {
    try {
      const data = await apiFetch<PricelistMeta>("/api/pricelist");
      setMeta(data);
    } catch {
      setMeta({ exists: false });
    }
  }

  useEffect(() => {
    loadMeta();
  }, []);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setMessage(null);
    try {
      const form = new FormData();
      form.append("file", file);
      await apiFetch("/api/pricelist", { method: "POST", body: form });
      setMessage({ type: "ok", text: `Файл «${file.name}» успешно загружен` });
      await loadMeta();
    } catch (err) {
      setMessage({
        type: "err",
        text: err instanceof Error ? err.message : "Ошибка загрузки",
      });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleDelete() {
    if (!confirm("Удалить прайслист?")) return;
    setDeleting(true);
    setMessage(null);
    try {
      await apiFetch("/api/pricelist", { method: "DELETE" });
      setMessage({ type: "ok", text: "Прайслист удалён" });
      await loadMeta();
    } catch (err) {
      setMessage({
        type: "err",
        text: err instanceof Error ? err.message : "Ошибка удаления",
      });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-ink">Прайслист для Telegram-бота</h2>
        <p className="text-sm text-ink-2 mt-1">
          Файл предлагается клиентам бота когда они не могут найти нужное оборудование.
          Поддерживаются PDF, Excel (.xlsx), Word (.docx) и другие форматы.
        </p>
      </div>

      {message && (
        <div
          className={`px-4 py-3 rounded-lg text-sm font-medium ${
            message.type === "ok"
              ? "bg-emerald-soft text-emerald border border-emerald-border"
              : "bg-rose-soft text-rose border border-rose-border"
          }`}
        >
          {message.text}
        </div>
      )}

      {meta === null ? (
        <div className="text-sm text-ink-3 py-4">Загрузка…</div>
      ) : meta.exists ? (
        <div className="flex items-center justify-between gap-4 p-4 bg-surface rounded-xl border border-border">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-lg bg-accent-soft flex items-center justify-center flex-shrink-0">
              <svg className="w-5 h-5 text-accent-bright" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium text-ink truncate">{meta.filename}</div>
              <div className="text-xs text-ink-2">
                {formatBytes(meta.size)} · Загружен {formatDate(meta.uploadedAt)}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <a
              href="/api/pricelist/file"
              className="px-3 py-1.5 text-xs font-medium text-accent-bright bg-accent-soft hover:bg-accent-soft rounded-lg transition-colors"
            >
              Скачать
            </a>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="px-3 py-1.5 text-xs font-medium text-rose bg-rose-soft hover:bg-rose-soft rounded-lg transition-colors disabled:opacity-50"
            >
              {deleting ? "Удаление…" : "Удалить"}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3 p-4 bg-amber-soft rounded-xl border border-amber-border">
          <svg className="w-5 h-5 text-amber flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-sm text-amber">
            Прайслист не загружен. Бот не сможет его отправить клиентам.
          </span>
        </div>
      )}

      <label
        className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium cursor-pointer transition-colors ${
          uploading
            ? "bg-surface-muted text-ink-3 cursor-not-allowed"
            : "bg-accent-bright hover:bg-accent text-white"
        }`}
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
        </svg>
        {uploading ? "Загрузка…" : meta?.exists ? "Заменить файл" : "Загрузить прайслист"}
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          accept=".pdf,.xlsx,.xls,.docx,.doc,.csv"
          disabled={uploading}
          onChange={handleUpload}
        />
      </label>
    </div>
  );
}
