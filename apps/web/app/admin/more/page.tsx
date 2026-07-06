"use client";
import React, { useState, useEffect, useRef, useMemo } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { useRequireRole } from "@/hooks/useRequireRole";
import { AdminTabNav } from "@/components/admin/AdminTabNav";

// ── Types ─────────────────────────────────────────────────────────────────────

type PricelistMeta =
  | { exists: false }
  | { exists: true; filename: string; size: number; uploadedAt: string };

type PreviewResponse = {
  sheetName: string;
  headers: string[];
  sampleRows: Record<string, unknown>[];
  suggestedMapping: Record<string, string>;
};

type CommitResult = {
  created: number;
  updated: number;
  unitsAdded: number;
};

type ImportSession = {
  id: string; type: string; status: string; fileName: string; fileSize: number;
  totalRows: number; matchedRows: number; unmatchedRows: number;
  appliedCount: number; acceptedCount: number; rejectedCount: number;
  competitorName: string | null; columnMapping: string | null;
  expiresAt: string; createdAt: string; updatedAt: string;
};

type ImportSessionRow = {
  id: string; sourceName: string; sourceCategory: string | null;
  sourcePrice: string | null; sourcePrice2: string | null; sourcePriceProject: string | null;
  equipmentId: string | null; matchConfidence: string | null; matchMethod: string | null;
  action: string; oldPrice: string | null; oldPrice2: string | null; oldPriceProject: string | null;
  oldQty: number | null; sourceQty: number | null;
  priceDelta: string | null; status: string; hasActiveBookings: boolean;
  equipment: { id: string; name: string; category: string; rentalRatePerShift: string | null } | null;
};

const IMPORT_FIELD_KEYS = [
  "category",
  "name",
  "brand",
  "model",
  "quantity",
  "rentalRatePerShift",
  "comment",
  "serialNumber",
  "internalInventoryNumber",
] as const;

type MappingState = Partial<Record<(typeof IMPORT_FIELD_KEYS)[number], string>>;

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function PricelistTab() {
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

// ── Tab: Каталог техники ──────────────────────────────────────────────────────

type CatalogSummaryRow = {
  id: string;
  category: string;
  name: string;
  totalQuantity: number;
  rentalRatePerShift: string;
};

function CatalogTab() {
  const [rows, setRows] = useState<CatalogSummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{ equipments: CatalogSummaryRow[] }>("/api/equipment");
      setRows(data.equipments);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка загрузки каталога");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const byCategory = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of rows) {
      map.set(r.category, (map.get(r.category) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], "ru"));
  }, [rows]);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-ink">Каталог техники</h2>
          <p className="text-sm text-ink-2 mt-1">
            Полный список оборудования в базе данных. Для редактирования перейдите в расширенный редактор.
          </p>
        </div>
        <Link
          href="/equipment/manage"
          className="shrink-0 inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium bg-accent text-white hover:bg-accent transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          Редактор
        </Link>
      </div>

      {loading ? (
        <div className="py-8 text-center text-sm text-ink-3">Загрузка…</div>
      ) : error ? (
        <div className="p-4 rounded-xl border border-rose-border bg-rose-soft text-sm text-rose">
          <div className="font-medium mb-1">Ошибка загрузки</div>
          <div>{error}</div>
          <button onClick={load} className="mt-2 text-xs underline">Повторить</button>
        </div>
      ) : rows.length === 0 ? (
        <div className="p-8 text-center rounded-xl border border-dashed border-border">
          <div className="text-sm font-medium text-ink-2 mb-1">Каталог пуст</div>
          <p className="text-xs text-ink-3">
            Добавьте оборудование через вкладку{" "}
            <span className="font-medium text-ink-2">Импорт оборудования</span>{" "}
            или нажмите <span className="font-medium text-ink-2">Редактор</span>.
          </p>
        </div>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-xl border border-border bg-surface p-4">
              <div className="text-2xl font-bold text-ink">{rows.length}</div>
              <div className="text-xs text-ink-2 mt-0.5">позиций в каталоге</div>
            </div>
            <div className="rounded-xl border border-border bg-surface p-4">
              <div className="text-2xl font-bold text-ink">{byCategory.length}</div>
              <div className="text-xs text-ink-2 mt-0.5">категорий</div>
            </div>
            <div className="rounded-xl border border-border bg-surface p-4">
              <div className="text-2xl font-bold text-ink">
                {rows.reduce((s, r) => s + r.totalQuantity, 0)}
              </div>
              <div className="text-xs text-ink-2 mt-0.5">единиц всего</div>
            </div>
            <div className="rounded-xl border border-border bg-surface p-4">
              <button
                onClick={load}
                className="text-xs text-ink-2 hover:text-ink underline"
              >
                Обновить
              </button>
            </div>
          </div>

          {/* Category breakdown */}
          <div className="rounded-xl border border-border overflow-hidden">
            <div className="px-4 py-2.5 bg-surface border-b border-border text-xs font-semibold text-ink-2 uppercase tracking-wide">
              По категориям
            </div>
            <div className="divide-y divide-slate-100">
              {byCategory.map(([cat, count]) => (
                <div key={cat} className="flex items-center justify-between px-4 py-2.5">
                  <span className="text-sm text-ink">{cat}</span>
                  <span className="text-sm font-medium text-ink-2">{count} позиц.</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Tab: Импорт оборудования ──────────────────────────────────────────────────

function ImportTab() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [mapping, setMapping] = useState<MappingState>({});
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [commitResult, setCommitResult] = useState<CommitResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const headers = preview?.headers ?? [];
  const samplePreview = useMemo(() => preview?.sampleRows?.slice(0, 8) ?? [], [preview]);

  async function handlePreview() {
    if (!file) return;
    setLoadingPreview(true);
    setError(null);
    setCommitResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await apiFetch<PreviewResponse>("/api/equipment/import/preview", {
        method: "POST",
        body: form,
      });
      setPreview(res);
      const suggested = res.suggestedMapping ?? {};
      setMapping((prev) => {
        const next: MappingState = { ...prev };
        for (const k of Object.keys(suggested)) {
          next[k as keyof MappingState] = suggested[k];
        }
        return next;
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ошибка предпросмотра");
    } finally {
      setLoadingPreview(false);
    }
  }

  async function handleCommit() {
    if (!file || !preview) return;
    setError(null);
    setCommitResult(null);
    const mappingPayload: Record<string, string> = {};
    for (const key of IMPORT_FIELD_KEYS) {
      const v = mapping[key];
      if (v && v.trim()) mappingPayload[key] = v;
    }
    const form = new FormData();
    form.append("file", file);
    form.append("mapping", JSON.stringify(mappingPayload));
    try {
      const res = await apiFetch<CommitResult>("/api/equipment/import/commit", {
        method: "POST",
        body: form,
      });
      setCommitResult(res);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ошибка импорта");
    }
  }

  function reset() {
    setFile(null);
    setPreview(null);
    setMapping({});
    setCommitResult(null);
    setError(null);
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-ink">Импорт оборудования из Excel</h2>
        <p className="text-sm text-ink-2 mt-1">
          Загрузите .xlsx файл, сопоставьте колонки с полями каталога и запустите импорт.
          Существующие позиции обновляются по ключу{" "}
          <span className="font-mono text-xs bg-surface-muted px-1 rounded">
            категория + наименование + бренд + модель
          </span>
          .
        </p>
      </div>

      {/* Step 1: File pick */}
      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        <div className="px-4 py-3 bg-surface border-b border-border flex items-center justify-between">
          <span className="text-xs font-semibold text-ink-2 uppercase tracking-wide">
            Шаг 1 — Файл
          </span>
          {preview && (
            <button onClick={reset} className="text-xs text-ink-3 hover:text-ink-2 transition-colors">
              Сбросить
            </button>
          )}
        </div>
        <div className="p-4 flex items-center gap-4 flex-wrap">
          <input
            type="file"
            accept=".xlsx,.xls"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              setPreview(null);
              setCommitResult(null);
              setError(null);
            }}
          />
          <button
            className="rounded-lg bg-accent text-white px-4 py-2 text-sm hover:bg-accent-bright disabled:opacity-40 transition-colors"
            disabled={!file || loadingPreview}
            onClick={handlePreview}
          >
            {loadingPreview ? "Читаю…" : "Распознать колонки"}
          </button>
        </div>
      </div>

      {/* Step 2: Mapping + preview */}
      {preview && (
        <div className="rounded-xl border border-border bg-surface overflow-hidden">
          <div className="px-4 py-3 bg-surface border-b border-border">
            <span className="text-xs font-semibold text-ink-2 uppercase tracking-wide">
              Шаг 2 — Сопоставление колонок
            </span>
          </div>
          <div className="p-4 grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Mapping selects */}
            <div className="lg:col-span-7 space-y-2">
              {IMPORT_FIELD_KEYS.map((k) => (
                <div key={k} className="flex items-center gap-3">
                  <div className="w-44 text-xs text-ink-2 shrink-0">{k}</div>
                  <select
                    className="flex-1 rounded-lg border border-border px-3 py-1.5 text-sm bg-white"
                    value={mapping[k] ?? ""}
                    onChange={(e) =>
                      setMapping((prev) => ({ ...prev, [k]: e.target.value || undefined }))
                    }
                  >
                    <option value="">(не используется)</option>
                    {headers.map((h) => (
                      <option value={h} key={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>
              ))}

              {/* Sample rows */}
              <div className="mt-4 rounded-lg border border-border bg-surface overflow-hidden">
                <div className="px-3 py-2 border-b border-border text-xs font-semibold text-ink-2">
                  Предпросмотр (первые строки файла)
                </div>
                <div className="overflow-auto max-h-52">
                  <table className="min-w-[640px] w-full text-xs">
                    <thead className="bg-surface-muted">
                      <tr>
                        {(preview.headers ?? []).slice(0, 8).map((h) => (
                          <th key={h} className="text-left px-3 py-2 border-b border-border font-medium text-ink-2">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {samplePreview.map((row, idx) => (
                        <tr key={idx} className="border-t border-border">
                          {(preview.headers ?? []).slice(0, 8).map((h) => (
                            <td key={h} className="px-3 py-1.5 text-ink-2">
                              {String(row[h] ?? "")}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            {/* Step 3: Commit */}
            <div className="lg:col-span-5 space-y-4">
              <div className="rounded-xl border border-border bg-surface p-4">
                <span className="text-xs font-semibold text-ink-2 uppercase tracking-wide">
                  Шаг 3 — Запуск импорта
                </span>
                <p className="text-sm text-ink-2 mt-2 mb-4">
                  После нажатия новые позиции будут созданы, существующие — обновлены. Действие нельзя отменить.
                </p>
                <button
                  className="w-full rounded-lg bg-emerald text-white px-4 py-3 text-sm font-medium hover:bg-emerald-soft0 disabled:opacity-50 transition-colors"
                  onClick={handleCommit}
                  disabled={!preview}
                >
                  Импортировать в каталог
                </button>
              </div>

              {error && (
                <div className="rounded-lg border border-rose-border bg-rose-soft text-rose p-4 text-sm">
                  <div className="font-semibold mb-1">Ошибка</div>
                  {error}
                </div>
              )}

              {commitResult && (
                <div className="rounded-lg border border-emerald-border bg-emerald-soft p-4 text-sm text-emerald space-y-1">
                  <div className="font-semibold text-emerald mb-2">Импорт завершён</div>
                  <div className="flex justify-between">
                    <span className="text-emerald">Создано позиций</span>
                    <span className="font-semibold">{commitResult.created}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-emerald">Обновлено позиций</span>
                    <span className="font-semibold">{commitResult.updated}</span>
                  </div>
                  {commitResult.unitsAdded > 0 && (
                    <div className="flex justify-between">
                      <span className="text-emerald">Добавлено единиц (serial)</span>
                      <span className="font-semibold">{commitResult.unitsAdded}</span>
                    </div>
                  )}
                  <div className="pt-2 border-t border-emerald-border flex gap-2 flex-wrap">
                    <Link
                      href="/equipment"
                      className="inline-flex items-center gap-1 text-xs text-emerald hover:text-emerald underline"
                    >
                      Посмотреть каталог →
                    </Link>
                    <Link
                      href="/equipment/manage"
                      className="inline-flex items-center gap-1 text-xs text-emerald hover:text-emerald underline"
                    >
                      Редактор →
                    </Link>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Workers tab ───────────────────────────────────────────────────────────────

type Worker = {
  id: string;
  name: string;
  isActive: boolean;
  lastLoginAt: string | null;
  failedAttempts: number;
  lockedUntil: string | null;
  createdAt: string;
};

function WorkersTab() {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add worker form
  const [newName, setNewName] = useState("");
  const [newPin, setNewPin] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [addLoading, setAddLoading] = useState(false);

  // PIN reset
  const [resetPinId, setResetPinId] = useState<string | null>(null);
  const [resetPinValue, setResetPinValue] = useState("");
  const [resetPinError, setResetPinError] = useState<string | null>(null);
  const [resetPinLoading, setResetPinLoading] = useState(false);

  // Delete confirm
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function loadWorkers() {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{ workers: Worker[] }>("/api/warehouse/workers");
      setWorkers(data.workers);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка загрузки");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadWorkers();
  }, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim() || newPin.length !== 4) {
      setAddError("Введите имя и 4-значный PIN");
      return;
    }
    setAddLoading(true);
    setAddError(null);
    try {
      await apiFetch("/api/warehouse/workers", {
        method: "POST",
        body: JSON.stringify({ name: newName.trim(), pin: newPin }),
      });
      setNewName("");
      setNewPin("");
      await loadWorkers();
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "Ошибка добавления");
    } finally {
      setAddLoading(false);
    }
  }

  async function handleToggleActive(worker: Worker) {
    try {
      await apiFetch(`/api/warehouse/workers/${worker.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !worker.isActive }),
      });
      await loadWorkers();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка обновления");
    }
  }

  async function handleResetPin(id: string) {
    if (resetPinValue.length !== 4) {
      setResetPinError("PIN должен быть 4-значным");
      return;
    }
    setResetPinLoading(true);
    setResetPinError(null);
    try {
      await apiFetch(`/api/warehouse/workers/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ pin: resetPinValue }),
      });
      setResetPinId(null);
      setResetPinValue("");
      await loadWorkers();
    } catch (e) {
      setResetPinError(e instanceof Error ? e.message : "Ошибка смены PIN");
    } finally {
      setResetPinLoading(false);
    }
  }

  async function handleDelete(id: string) {
    setDeleteLoading(true);
    setDeleteError(null);
    try {
      await apiFetch(`/api/warehouse/workers/${id}`, { method: "DELETE" });
      setDeleteId(null);
      await loadWorkers();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Ошибка удаления");
    } finally {
      setDeleteLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <h3 className="text-sm font-semibold text-ink">Кладовщики</h3>

      {/* Add worker form */}
      <form onSubmit={handleAdd} className="border border-border rounded-xl p-4 space-y-3 bg-surface">
        <p className="text-xs font-semibold text-ink-2 uppercase tracking-wider">Добавить кладовщика</p>
        <div className="flex gap-3 flex-wrap">
          <input
            type="text"
            placeholder="Имя"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="rounded border border-border px-3 py-2 text-sm bg-surface flex-1 min-w-[140px]"
          />
          <input
            type="text"
            placeholder="PIN (4 цифры)"
            value={newPin}
            maxLength={4}
            onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ""))}
            className="rounded border border-border px-3 py-2 text-sm bg-surface w-[120px]"
          />
          <button
            type="submit"
            disabled={addLoading}
            className="rounded bg-accent text-white px-4 py-2 text-sm hover:bg-accent-bright disabled:opacity-50"
          >
            {addLoading ? "..." : "Добавить"}
          </button>
        </div>
        {addError && <p className="text-xs text-rose">{addError}</p>}
      </form>

      {/* Workers list */}
      {loading && <p className="text-sm text-ink-3">Загрузка...</p>}
      {error && <p className="text-sm text-rose">{error}</p>}

      {/* Desktop table */}
      {!loading && workers.length > 0 && (
        <div className="hidden md:block border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface text-ink-2 text-xs">
              <tr>
                <th className="text-left px-4 py-3">Имя</th>
                <th className="text-left px-3 py-3">Статус</th>
                <th className="text-left px-3 py-3">Последний вход</th>
                <th className="text-left px-3 py-3">Попытки</th>
                <th className="text-left px-3 py-3">Блокировка</th>
                <th className="px-3 py-3 text-right">Действия</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {workers.map((w) => (
                <tr key={w.id} className="hover:bg-surface">
                  <td className="px-4 py-3 font-medium text-ink">{w.name}</td>
                  <td className="px-3 py-3">
                    {w.isActive ? (
                      <span className="inline-flex items-center rounded border px-2 py-0.5 text-xs bg-emerald-soft text-emerald border-emerald-border">Активен</span>
                    ) : (
                      <span className="inline-flex items-center rounded border px-2 py-0.5 text-xs bg-surface-muted text-ink-2 border-border">Отключён</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-ink-2 text-xs">
                    {w.lastLoginAt ? new Date(w.lastLoginAt).toLocaleString("ru-RU") : "—"}
                  </td>
                  <td className="px-3 py-3 text-ink-2">{w.failedAttempts}</td>
                  <td className="px-3 py-3 text-xs">
                    {w.lockedUntil ? (
                      <span className="text-rose">{new Date(w.lockedUntil).toLocaleString("ru-RU")}</span>
                    ) : (
                      <span className="text-ink-3">—</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => handleToggleActive(w)}
                        className="text-xs rounded border border-border px-2 py-1 text-ink-2 hover:bg-surface"
                      >
                        {w.isActive ? "Отключить" : "Включить"}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setResetPinId(w.id); setResetPinValue(""); setResetPinError(null); }}
                        className="text-xs rounded border border-border px-2 py-1 text-ink-2 hover:bg-surface"
                      >
                        Сменить PIN
                      </button>
                      <button
                        type="button"
                        onClick={() => { setDeleteId(w.id); setDeleteError(null); }}
                        className="text-xs rounded border border-rose-border px-2 py-1 text-rose hover:bg-rose-soft"
                      >
                        Удалить
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Mobile cards */}
      {!loading && workers.length > 0 && (
        <div className="md:hidden space-y-3">
          {workers.map((w) => (
            <div key={w.id} className="rounded-xl border border-border bg-surface p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium text-ink">{w.name}</span>
                {w.isActive ? (
                  <span className="inline-flex items-center rounded border px-2 py-0.5 text-xs bg-emerald-soft text-emerald border-emerald-border">Активен</span>
                ) : (
                  <span className="inline-flex items-center rounded border px-2 py-0.5 text-xs bg-surface-muted text-ink-2 border-border">Отключён</span>
                )}
              </div>
              <p className="text-xs text-ink-3 mb-1">
                Последний вход: {w.lastLoginAt ? new Date(w.lastLoginAt).toLocaleString("ru-RU") : "—"}
              </p>
              <p className="text-xs text-ink-3 mb-1">Неудачных попыток: {w.failedAttempts}</p>
              {w.lockedUntil && (
                <p className="text-xs text-rose mb-1">Заблокирован до: {new Date(w.lockedUntil).toLocaleString("ru-RU")}</p>
              )}
              <div className="flex gap-2 flex-wrap mt-3">
                <button
                  type="button"
                  onClick={() => handleToggleActive(w)}
                  className="text-xs rounded border border-border px-2 py-1.5 text-ink-2 hover:bg-surface"
                >
                  {w.isActive ? "Отключить" : "Включить"}
                </button>
                <button
                  type="button"
                  onClick={() => { setResetPinId(w.id); setResetPinValue(""); setResetPinError(null); }}
                  className="text-xs rounded border border-border px-2 py-1.5 text-ink-2 hover:bg-surface"
                >
                  Сменить PIN
                </button>
                <button
                  type="button"
                  onClick={() => { setDeleteId(w.id); setDeleteError(null); }}
                  className="text-xs rounded border border-rose-border px-2 py-1.5 text-rose hover:bg-rose-soft"
                >
                  Удалить
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && workers.length === 0 && !error && (
        <p className="text-sm text-ink-3 py-6 text-center border border-border rounded-xl">
          Кладовщики не добавлены
        </p>
      )}

      {/* Reset PIN modal */}
      {resetPinId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-xs bg-surface rounded-2xl border border-border shadow-lg p-6">
            <h2 className="text-base font-semibold text-ink mb-4">Сменить PIN</h2>
            <input
              type="text"
              placeholder="Новый PIN (4 цифры)"
              value={resetPinValue}
              maxLength={4}
              onChange={(e) => setResetPinValue(e.target.value.replace(/\D/g, ""))}
              className="w-full rounded border border-border px-3 py-2 text-sm mb-3"
            />
            {resetPinError && <p className="text-xs text-rose mb-3">{resetPinError}</p>}
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setResetPinId(null)}
                className="rounded border border-border px-4 py-2 text-sm text-ink-2 hover:bg-surface"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => handleResetPin(resetPinId)}
                disabled={resetPinLoading}
                className="rounded bg-accent text-white px-4 py-2 text-sm hover:bg-accent-bright disabled:opacity-50"
              >
                {resetPinLoading ? "..." : "Сохранить"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-xs bg-surface rounded-2xl border border-border shadow-lg p-6">
            <h2 className="text-base font-semibold text-ink mb-2">Удалить кладовщика?</h2>
            <p className="text-sm text-ink-2 mb-4">
              {workers.find((w) => w.id === deleteId)?.name}
            </p>
            {deleteError && <p className="text-xs text-rose mb-3">{deleteError}</p>}
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setDeleteId(null)}
                className="rounded border border-border px-4 py-2 text-sm text-ink-2 hover:bg-surface"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => handleDelete(deleteId)}
                disabled={deleteLoading}
                className="rounded bg-rose text-white px-4 py-2 text-sm hover:bg-rose/90 disabled:opacity-50"
              >
                {deleteLoading ? "..." : "Удалить"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

type MoreTab = "catalog" | "pricelist" | "import" | "workers";

const TABS: Array<{ id: MoreTab; label: string }> = [
  { id: "workers", label: "Кладовщики" },
  { id: "catalog", label: "Каталог" },
  { id: "pricelist", label: "Прайслист бота" },
  { id: "import", label: "Импорт оборудования" },
];

export default function AdminMorePage() {
  useRequireRole(["SUPER_ADMIN"]);
  const [tab, setTab] = useState<MoreTab>("workers");

  return (
    <div className="p-4 md:p-6 max-w-5xl">
      <AdminTabNav />
      <div className="mt-4 mb-5">
        <h1 className="text-xl font-semibold tracking-tight text-ink">Дополнительно</h1>
        <p className="text-sm text-ink-2 mt-1">Инструменты: кладовщики, каталог, прайслист, импорт.</p>
      </div>

      {/* Inner tabs */}
      <div className="flex gap-1 mb-5 border-b border-border overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3.5 py-2 text-sm border-b-2 -mb-px transition-colors whitespace-nowrap ${
              tab === t.id ? "border-ink text-ink font-medium" : "border-transparent text-ink-2 hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="bg-surface rounded-lg border border-border p-6 shadow-xs">
        {tab === "workers" && <WorkersTab />}
        {tab === "catalog" && <CatalogTab />}
        {tab === "pricelist" && <PricelistTab />}
        {tab === "import" && <ImportTab />}
      </div>
    </div>
  );
}
