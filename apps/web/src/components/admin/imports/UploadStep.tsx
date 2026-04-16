"use client";

import { useRef, useState } from "react";

type ImportMode = "own" | "competitor";

type Props = {
  onUpload: (file: File, type: "OWN_PRICE_UPDATE" | "COMPETITOR_IMPORT", competitorName?: string) => void;
  loading: boolean;
};

export function UploadStep({ onUpload, loading }: Props) {
  const [mode, setMode] = useState<ImportMode>("own");
  const [competitorName, setCompetitorName] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = (file: File) => {
    setError(null);
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (!ext || !["xlsx", "xls"].includes(ext)) {
      setError("Поддерживаются только файлы .xlsx и .xls");
      return;
    }
    if (mode === "competitor" && !competitorName.trim()) {
      setError("Укажите название конкурента перед загрузкой");
      return;
    }
    onUpload(
      file,
      mode === "own" ? "OWN_PRICE_UPDATE" : "COMPETITOR_IMPORT",
      mode === "competitor" ? competitorName.trim() : undefined
    );
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    // reset so same file can be re-selected
    e.target.value = "";
  };

  return (
    <div className="mx-auto max-w-xl">
      {/* Режим */}
      <div className="mb-6">
        <div className="eyebrow mb-3">Тип импорта</div>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => { setMode("own"); setError(null); }}
            disabled={loading}
            className={`flex-1 rounded-lg border px-4 py-3 text-sm font-medium transition-colors ${
              mode === "own"
                ? "border-accent bg-accent-soft text-accent"
                : "border-border bg-surface text-ink-2 hover:bg-surface-2"
            }`}
          >
            📦 Обновить каталог
          </button>
          <button
            type="button"
            onClick={() => { setMode("competitor"); setError(null); }}
            disabled={loading}
            className={`flex-1 rounded-lg border px-4 py-3 text-sm font-medium transition-colors ${
              mode === "competitor"
                ? "border-accent bg-accent-soft text-accent"
                : "border-border bg-surface text-ink-2 hover:bg-surface-2"
            }`}
          >
            📊 Сравнить с конкурентом
          </button>
        </div>
      </div>

      {/* Название конкурента */}
      {mode === "competitor" && (
        <div className="mb-6">
          <label htmlFor="competitor-name" className="mb-1.5 block text-sm text-ink-2">
            Название конкурента <span className="text-rose">*</span>
          </label>
          <input
            id="competitor-name"
            type="text"
            value={competitorName}
            onChange={(e) => { setCompetitorName(e.target.value); setError(null); }}
            disabled={loading}
            placeholder="Например: СветоБаза"
            className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-ink-1 focus:border-accent focus:outline-none disabled:opacity-60"
          />
        </div>
      )}

      {/* Зона загрузки */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        onClick={() => !loading && inputRef.current?.click()}
        className={`cursor-pointer rounded-lg border-2 border-dashed px-6 py-12 text-center transition-colors ${
          dragActive
            ? "border-accent bg-accent-soft"
            : "border-border bg-surface hover:border-accent hover:bg-accent-soft/50"
        } ${loading ? "pointer-events-none opacity-60" : ""}`}
      >
        <div className="mb-2 text-3xl">📂</div>
        <div className="mb-1 text-sm font-medium text-ink-1">
          {dragActive ? "Отпустите файл" : "Перетащите файл или нажмите для выбора"}
        </div>
        <div className="text-xs text-ink-3">Поддерживаются .xlsx, .xls</div>
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls"
          onChange={handleInputChange}
          className="hidden"
        />
      </div>

      {error && (
        <p className="mt-3 text-sm text-rose">{error}</p>
      )}
    </div>
  );
}
