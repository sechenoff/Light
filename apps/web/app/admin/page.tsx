"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import Link from "next/link";
import { apiFetch } from "../../src/lib/api";
import { useCurrentUser } from "../../src/lib/auth";

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

// ── Tab: Прайслист ────────────────────────────────────────────────────────────

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
        <h2 className="text-base font-semibold text-slate-800">Прайслист для Telegram-бота</h2>
        <p className="text-sm text-slate-500 mt-1">
          Файл предлагается клиентам бота когда они не могут найти нужное оборудование.
          Поддерживаются PDF, Excel (.xlsx), Word (.docx) и другие форматы.
        </p>
      </div>

      {message && (
        <div
          className={`px-4 py-3 rounded-lg text-sm font-medium ${
            message.type === "ok"
              ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
              : "bg-red-50 text-red-700 border border-red-200"
          }`}
        >
          {message.text}
        </div>
      )}

      {meta === null ? (
        <div className="text-sm text-slate-400 py-4">Загрузка…</div>
      ) : meta.exists ? (
        <div className="flex items-center justify-between gap-4 p-4 bg-slate-50 rounded-xl border border-slate-200">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center flex-shrink-0">
              <svg className="w-5 h-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium text-slate-800 truncate">{meta.filename}</div>
              <div className="text-xs text-slate-500">
                {formatBytes(meta.size)} · Загружен {formatDate(meta.uploadedAt)}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <a
              href="/api/pricelist/file"
              className="px-3 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors"
            >
              Скачать
            </a>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-lg transition-colors disabled:opacity-50"
            >
              {deleting ? "Удаление…" : "Удалить"}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3 p-4 bg-amber-50 rounded-xl border border-amber-200">
          <svg className="w-5 h-5 text-amber-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-sm text-amber-700">
            Прайслист не загружен. Бот не сможет его отправить клиентам.
          </span>
        </div>
      )}

      <label
        className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium cursor-pointer transition-colors ${
          uploading
            ? "bg-slate-100 text-slate-400 cursor-not-allowed"
            : "bg-slate-800 hover:bg-slate-700 text-white"
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
          <h2 className="text-base font-semibold text-slate-800">Каталог техники</h2>
          <p className="text-sm text-slate-500 mt-1">
            Полный список оборудования в базе данных. Для редактирования перейдите в расширенный редактор.
          </p>
        </div>
        <Link
          href="/equipment/manage"
          className="shrink-0 inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium bg-slate-900 text-white hover:bg-slate-700 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          Редактор
        </Link>
      </div>

      {loading ? (
        <div className="py-8 text-center text-sm text-slate-400">Загрузка…</div>
      ) : error ? (
        <div className="p-4 rounded-xl border border-rose-200 bg-rose-50 text-sm text-rose-700">
          <div className="font-medium mb-1">Ошибка загрузки</div>
          <div>{error}</div>
          <button onClick={load} className="mt-2 text-xs underline">Повторить</button>
        </div>
      ) : rows.length === 0 ? (
        <div className="p-8 text-center rounded-xl border border-dashed border-slate-300">
          <div className="text-sm font-medium text-slate-600 mb-1">Каталог пуст</div>
          <p className="text-xs text-slate-400">
            Добавьте оборудование через вкладку{" "}
            <span className="font-medium text-slate-600">Импорт оборудования</span>{" "}
            или нажмите <span className="font-medium text-slate-600">Редактор</span>.
          </p>
        </div>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="text-2xl font-bold text-slate-900">{rows.length}</div>
              <div className="text-xs text-slate-500 mt-0.5">позиций в каталоге</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="text-2xl font-bold text-slate-900">{byCategory.length}</div>
              <div className="text-xs text-slate-500 mt-0.5">категорий</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="text-2xl font-bold text-slate-900">
                {rows.reduce((s, r) => s + r.totalQuantity, 0)}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">единиц всего</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <button
                onClick={load}
                className="text-xs text-slate-500 hover:text-slate-800 underline"
              >
                Обновить
              </button>
            </div>
          </div>

          {/* Category breakdown */}
          <div className="rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase tracking-wide">
              По категориям
            </div>
            <div className="divide-y divide-slate-100">
              {byCategory.map(([cat, count]) => (
                <div key={cat} className="flex items-center justify-between px-4 py-2.5">
                  <span className="text-sm text-slate-800">{cat}</span>
                  <span className="text-sm font-medium text-slate-600">{count} позиц.</span>
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
        <h2 className="text-base font-semibold text-slate-800">Импорт оборудования из Excel</h2>
        <p className="text-sm text-slate-500 mt-1">
          Загрузите .xlsx файл, сопоставьте колонки с полями каталога и запустите импорт.
          Существующие позиции обновляются по ключу{" "}
          <span className="font-mono text-xs bg-slate-100 px-1 rounded">
            категория + наименование + бренд + модель
          </span>
          .
        </p>
      </div>

      {/* Step 1: File pick */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
            Шаг 1 — Файл
          </span>
          {preview && (
            <button onClick={reset} className="text-xs text-slate-400 hover:text-slate-700 transition-colors">
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
            className="rounded-lg bg-slate-900 text-white px-4 py-2 text-sm hover:bg-slate-800 disabled:opacity-40 transition-colors"
            disabled={!file || loadingPreview}
            onClick={handlePreview}
          >
            {loadingPreview ? "Читаю…" : "Распознать колонки"}
          </button>
        </div>
      </div>

      {/* Step 2: Mapping + preview */}
      {preview && (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="px-4 py-3 bg-slate-50 border-b border-slate-200">
            <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
              Шаг 2 — Сопоставление колонок
            </span>
          </div>
          <div className="p-4 grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Mapping selects */}
            <div className="lg:col-span-7 space-y-2">
              {IMPORT_FIELD_KEYS.map((k) => (
                <div key={k} className="flex items-center gap-3">
                  <div className="w-44 text-xs text-slate-500 shrink-0">{k}</div>
                  <select
                    className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm bg-white"
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
              <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 overflow-hidden">
                <div className="px-3 py-2 border-b border-slate-200 text-xs font-semibold text-slate-600">
                  Предпросмотр (первые строки файла)
                </div>
                <div className="overflow-auto max-h-52">
                  <table className="min-w-[640px] w-full text-xs">
                    <thead className="bg-slate-100">
                      <tr>
                        {(preview.headers ?? []).slice(0, 8).map((h) => (
                          <th key={h} className="text-left px-3 py-2 border-b border-slate-200 font-medium text-slate-600">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {samplePreview.map((row, idx) => (
                        <tr key={idx} className="border-t border-slate-100">
                          {(preview.headers ?? []).slice(0, 8).map((h) => (
                            <td key={h} className="px-3 py-1.5 text-slate-700">
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
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
                  Шаг 3 — Запуск импорта
                </span>
                <p className="text-sm text-slate-500 mt-2 mb-4">
                  После нажатия новые позиции будут созданы, существующие — обновлены. Действие нельзя отменить.
                </p>
                <button
                  className="w-full rounded-lg bg-emerald-600 text-white px-4 py-3 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50 transition-colors"
                  onClick={handleCommit}
                  disabled={!preview}
                >
                  Импортировать в каталог
                </button>
              </div>

              {error && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 text-rose-700 p-4 text-sm">
                  <div className="font-semibold mb-1">Ошибка</div>
                  {error}
                </div>
              )}

              {commitResult && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 space-y-1">
                  <div className="font-semibold text-emerald-800 mb-2">Импорт завершён</div>
                  <div className="flex justify-between">
                    <span className="text-emerald-700">Создано позиций</span>
                    <span className="font-semibold">{commitResult.created}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-emerald-700">Обновлено позиций</span>
                    <span className="font-semibold">{commitResult.updated}</span>
                  </div>
                  {commitResult.unitsAdded > 0 && (
                    <div className="flex justify-between">
                      <span className="text-emerald-700">Добавлено единиц (serial)</span>
                      <span className="font-semibold">{commitResult.unitsAdded}</span>
                    </div>
                  )}
                  <div className="pt-2 border-t border-emerald-200 flex gap-2 flex-wrap">
                    <Link
                      href="/equipment"
                      className="inline-flex items-center gap-1 text-xs text-emerald-700 hover:text-emerald-900 underline"
                    >
                      Посмотреть каталог →
                    </Link>
                    <Link
                      href="/equipment/manage"
                      className="inline-flex items-center gap-1 text-xs text-emerald-700 hover:text-emerald-900 underline"
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

// ── Tab: Жаргон / Обучение ────────────────────────────────────────────────────

type SlangCandidate = {
  id: string;
  rawPhrase: string;
  normalizedPhrase: string;
  proposedEquipmentId: string | null;
  proposedEquipmentName: string | null;
  confidence: number;
  contextJson: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED";
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
};

type SlangAlias = {
  id: string;
  phraseNormalized: string;
  phraseOriginal: string;
  equipmentId: string;
  confidence: number;
  source: string;
  createdAt: string;
  usageCount: number;
  lastUsedAt: string;
  equipment: { name: string; category: string };
};

type DictionaryGroup = {
  equipment: { id: string; name: string; category: string };
  aliases: SlangAlias[];
  aliasCount: number;
};

function SlangLearningTab() {
  const [activeSection, setActiveSection] = useState<"pending" | "approved" | "dictionary">("pending");
  const [candidates, setCandidates] = useState<SlangCandidate[]>([]);
  const [dictionary, setDictionary] = useState<DictionaryGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionState, setActionState] = useState<Record<string, "approving" | "rejecting">>({});
  const [overrideEquipId, setOverrideEquipId] = useState<Record<string, string>>({});
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [dictSearch, setDictSearch] = useState("");

  async function loadCandidates(status: "PENDING" | "APPROVED" | "REJECTED") {
    setLoading(true);
    try {
      const data = await apiFetch<SlangCandidate[]>(`/api/admin/slang-learning?status=${status}`);
      setCandidates(data);
    } catch {
      setCandidates([]);
    } finally {
      setLoading(false);
    }
  }

  async function loadDictionary() {
    setLoading(true);
    try {
      const data = await apiFetch<DictionaryGroup[]>("/api/admin/slang-learning/dictionary");
      setDictionary(data);
    } catch {
      setDictionary([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (activeSection === "pending") loadCandidates("PENDING");
    else if (activeSection === "approved") loadCandidates("APPROVED");
    else loadDictionary();
  }, [activeSection]);

  async function handleApprove(c: SlangCandidate) {
    setActionState((s) => ({ ...s, [c.id]: "approving" }));
    try {
      await apiFetch(`/api/admin/slang-learning/${c.id}/approve`, {
        method: "POST",
        body: JSON.stringify({ reviewedBy: "admin", equipmentId: overrideEquipId[c.id] || c.proposedEquipmentId }),
      });
      setCandidates((prev) => prev.filter((x) => x.id !== c.id));
    } catch (err: any) {
      alert(err?.message ?? "Ошибка подтверждения");
    } finally {
      setActionState((s) => { const n = { ...s }; delete n[c.id]; return n; });
    }
  }

  async function handleReject(c: SlangCandidate) {
    setActionState((s) => ({ ...s, [c.id]: "rejecting" }));
    try {
      await apiFetch(`/api/admin/slang-learning/${c.id}/reject`, {
        method: "POST",
        body: JSON.stringify({ reviewedBy: "admin" }),
      });
      setCandidates((prev) => prev.filter((x) => x.id !== c.id));
    } catch (err: any) {
      alert(err?.message ?? "Ошибка отклонения");
    } finally {
      setActionState((s) => { const n = { ...s }; delete n[c.id]; return n; });
    }
  }

  async function handleDeleteAlias(id: string) {
    if (!confirm("Удалить этот псевдоним?")) return;
    try {
      await apiFetch(`/api/admin/slang-learning/aliases/${id}`, { method: "DELETE" });
      setDictionary((prev) =>
        prev
          .map((g) => {
            const remaining = g.aliases.filter((a) => a.id !== id);
            return { ...g, aliases: remaining, aliasCount: remaining.length };
          })
          .filter((g) => g.aliases.length > 0)
      );
    } catch (err: any) {
      alert(err?.message ?? "Ошибка удаления");
    }
  }

  async function handleExportDictionary() {
    try {
      const data = await apiFetch<unknown>("/api/admin/slang-learning/dictionary/export");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `slang-dictionary-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      alert(err?.message ?? "Ошибка экспорта");
    }
  }

  const filteredDictionary = dictionary.filter((g) => {
    if (!dictSearch.trim()) return true;
    const q = dictSearch.toLowerCase();
    return (
      g.equipment.name.toLowerCase().includes(q) ||
      g.aliases.some((a) => a.phraseOriginal.toLowerCase().includes(q))
    );
  });

  function sourceLabel(source: string) {
    if (source === "SEED") {
      return <span className="text-[10px] font-semibold bg-slate-100 text-slate-500 rounded px-1.5 py-0.5">Миграция</span>;
    }
    if (source === "AUTO_LEARNED") {
      return <span className="text-[10px] font-semibold bg-emerald-100 text-emerald-700 rounded px-1.5 py-0.5">Авто</span>;
    }
    if (source === "MANUAL_ADMIN") {
      return <span className="text-[10px] font-semibold bg-blue-100 text-blue-700 rounded px-1.5 py-0.5">Вручную</span>;
    }
    return <span className="text-[10px] text-slate-400">{source}</span>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-slate-800">Жаргон / Обучение AI</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Кандидаты поступают из двух источников: <span className="font-medium text-amber-700">AI-уточнение</span> — менеджер выбрал из предложенных AI вариантов; <span className="font-medium text-violet-700">Ручной ввод</span> — менеджер вручную сопоставил нераспознанную фразу с каталогом.
          Подтверждённые записи добавляются в словарь и повышают точность будущего распознавания.
        </p>
      </div>

      {/* Section tabs */}
      <div className="flex gap-1 border-b border-slate-200">
        {([
          ["pending", "На проверке"],
          ["approved", "Одобрено"],
          ["dictionary", "Словарь жаргона"],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setActiveSection(id)}
            className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
              activeSection === id
                ? "border-slate-700 text-slate-900"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading && <div className="py-6 text-center text-sm text-slate-400">Загрузка…</div>}

      {!loading && activeSection !== "dictionary" && (
        <>
          {candidates.length === 0 ? (
            <div className="py-8 text-center text-sm text-slate-400">
              {activeSection === "pending" ? "Нет кандидатов на проверку" : "История пуста"}
            </div>
          ) : (
            <div className="divide-y divide-slate-100 -mx-6">
              {candidates.map((c) => (
                <div key={c.id} className="px-6 py-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4">
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="font-medium text-slate-900 text-sm">«{c.rawPhrase}»</div>
                      {(() => {
                        let src: string | undefined;
                        try { src = c.contextJson ? JSON.parse(c.contextJson).source : undefined; } catch { /* */ }
                        if (src === "manual_unmatched_learning") {
                          return <span className="text-[10px] font-semibold bg-violet-100 text-violet-700 rounded px-1.5 py-0.5 uppercase tracking-wide">Ручной ввод</span>;
                        }
                        if (src === "booking_review") {
                          return <span className="text-[10px] font-semibold bg-amber-100 text-amber-700 rounded px-1.5 py-0.5 uppercase tracking-wide">AI-уточнение</span>;
                        }
                        if (src === "gaffer_review_table") {
                          return <span className="text-[10px] font-semibold bg-teal-100 text-teal-800 rounded px-1.5 py-0.5 uppercase tracking-wide">Таблица гаффера</span>;
                        }
                        return null;
                      })()}
                    </div>
                    <div className="text-xs text-slate-500">
                      Нормализовано: <code className="bg-slate-100 px-1 rounded">{c.normalizedPhrase}</code>
                    </div>
                    {c.proposedEquipmentName && (
                      <div className="text-xs text-slate-600">
                        Предложено: <span className="font-medium">{c.proposedEquipmentName}</span>
                        {" "}
                        <span className="text-slate-400">({Math.round(c.confidence * 100)}%)</span>
                      </div>
                    )}
                    {activeSection === "pending" && (
                      <div className="flex items-center gap-2 mt-1">
                        <label className="text-xs text-slate-500">ID позиции (если изменить):</label>
                        <input
                          type="text"
                          className="text-xs rounded border border-slate-200 px-2 py-0.5 w-44 bg-white"
                          placeholder={c.proposedEquipmentId ?? "не задан"}
                          value={overrideEquipId[c.id] ?? ""}
                          onChange={(e) => setOverrideEquipId((prev) => ({ ...prev, [c.id]: e.target.value }))}
                        />
                      </div>
                    )}
                    {c.reviewedAt && (
                      <div className="text-xs text-slate-400">
                        {c.status === "APPROVED" ? "Одобрено" : "Отклонено"} {new Date(c.reviewedAt).toLocaleString("ru-RU")} · {c.reviewedBy}
                      </div>
                    )}
                    <div className="text-xs text-slate-400">{new Date(c.createdAt).toLocaleString("ru-RU")}</div>
                  </div>
                  {activeSection === "pending" && (
                    <div className="flex gap-2 shrink-0">
                      <button
                        type="button"
                        className="rounded border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                        disabled={!!actionState[c.id] || !c.proposedEquipmentId}
                        onClick={() => handleApprove(c)}
                      >
                        {actionState[c.id] === "approving" ? "…" : "Подтвердить"}
                      </button>
                      <button
                        type="button"
                        className="rounded border border-rose-200 bg-rose-50 px-3 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                        disabled={!!actionState[c.id]}
                        onClick={() => handleReject(c)}
                      >
                        {actionState[c.id] === "rejecting" ? "…" : "Отклонить"}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {!loading && activeSection === "dictionary" && (
        <>
          <div className="flex items-center gap-2">
            <input
              type="text"
              className="flex-1 text-xs rounded border border-slate-200 px-3 py-1.5 bg-white placeholder-slate-400"
              placeholder="Поиск по оборудованию или фразе…"
              value={dictSearch}
              onChange={(e) => setDictSearch(e.target.value)}
            />
            <button
              type="button"
              onClick={handleExportDictionary}
              className="shrink-0 rounded border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              Экспорт JSON
            </button>
          </div>
          {filteredDictionary.length === 0 ? (
            <div className="py-8 text-center text-sm text-slate-400">Словарь пуст</div>
          ) : (
            <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden">
              {filteredDictionary.map((g) => {
                const isExpanded = !!expandedGroups[g.equipment.id];
                return (
                  <div key={g.equipment.id}>
                    <button
                      type="button"
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-slate-50 transition-colors"
                      onClick={() =>
                        setExpandedGroups((prev) => ({
                          ...prev,
                          [g.equipment.id]: !prev[g.equipment.id],
                        }))
                      }
                    >
                      <span className="text-slate-400 text-xs w-3">{isExpanded ? "▼" : "▶"}</span>
                      <span className="flex-1 text-sm font-medium text-slate-900">{g.equipment.name}</span>
                      <span className="text-xs text-slate-400">{g.equipment.category}</span>
                      <span className="ml-2 text-[10px] font-semibold bg-slate-100 text-slate-600 rounded-full px-2 py-0.5">
                        {g.aliasCount}
                      </span>
                    </button>
                    {isExpanded && (
                      <div className="border-t border-slate-100 overflow-auto">
                        <table className="w-full text-xs">
                          <thead className="bg-slate-50 text-slate-500">
                            <tr>
                              <th className="text-left px-4 py-1.5">Фраза</th>
                              <th className="text-left px-3 py-1.5">Источник</th>
                              <th className="px-3 py-1.5 text-center">Использований</th>
                              <th className="px-3 py-1.5 text-left">Дата</th>
                              <th className="px-3 py-1.5"></th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {g.aliases.map((a) => (
                              <tr key={a.id} className="hover:bg-slate-50">
                                <td className="px-4 py-1.5 font-medium text-slate-900">{a.phraseOriginal}</td>
                                <td className="px-3 py-1.5">{sourceLabel(a.source)}</td>
                                <td className="px-3 py-1.5 text-center text-slate-600">{a.usageCount}</td>
                                <td className="px-3 py-1.5 text-slate-400">
                                  {a.lastUsedAt ? new Date(a.lastUsedAt).toLocaleDateString("ru-RU") : "—"}
                                </td>
                                <td className="px-3 py-1.5">
                                  <button
                                    type="button"
                                    className="text-rose-400 hover:text-rose-600"
                                    title="Удалить псевдоним"
                                    onClick={() => handleDeleteAlias(a.id)}
                                  >
                                    ✕
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
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
      <h3 className="text-sm font-semibold text-slate-900">Кладовщики</h3>

      {/* Add worker form */}
      <form onSubmit={handleAdd} className="border border-slate-200 rounded-xl p-4 space-y-3 bg-slate-50">
        <p className="text-xs font-semibold text-slate-600 uppercase tracking-wider">Добавить кладовщика</p>
        <div className="flex gap-3 flex-wrap">
          <input
            type="text"
            placeholder="Имя"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="rounded border border-slate-300 px-3 py-2 text-sm bg-white flex-1 min-w-[140px]"
          />
          <input
            type="text"
            placeholder="PIN (4 цифры)"
            value={newPin}
            maxLength={4}
            onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ""))}
            className="rounded border border-slate-300 px-3 py-2 text-sm bg-white w-[120px]"
          />
          <button
            type="submit"
            disabled={addLoading}
            className="rounded bg-slate-900 text-white px-4 py-2 text-sm hover:bg-slate-800 disabled:opacity-50"
          >
            {addLoading ? "..." : "Добавить"}
          </button>
        </div>
        {addError && <p className="text-xs text-rose-600">{addError}</p>}
      </form>

      {/* Workers list */}
      {loading && <p className="text-sm text-slate-400">Загрузка...</p>}
      {error && <p className="text-sm text-rose-600">{error}</p>}

      {/* Desktop table */}
      {!loading && workers.length > 0 && (
        <div className="hidden md:block border border-slate-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs">
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
                <tr key={w.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium text-slate-900">{w.name}</td>
                  <td className="px-3 py-3">
                    {w.isActive ? (
                      <span className="inline-flex items-center rounded border px-2 py-0.5 text-xs bg-emerald-50 text-emerald-700 border-emerald-200">Активен</span>
                    ) : (
                      <span className="inline-flex items-center rounded border px-2 py-0.5 text-xs bg-slate-100 text-slate-500 border-slate-200">Отключён</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-slate-500 text-xs">
                    {w.lastLoginAt ? new Date(w.lastLoginAt).toLocaleString("ru-RU") : "—"}
                  </td>
                  <td className="px-3 py-3 text-slate-600">{w.failedAttempts}</td>
                  <td className="px-3 py-3 text-xs">
                    {w.lockedUntil ? (
                      <span className="text-rose-600">{new Date(w.lockedUntil).toLocaleString("ru-RU")}</span>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => handleToggleActive(w)}
                        className="text-xs rounded border border-slate-200 px-2 py-1 text-slate-600 hover:bg-slate-50"
                      >
                        {w.isActive ? "Отключить" : "Включить"}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setResetPinId(w.id); setResetPinValue(""); setResetPinError(null); }}
                        className="text-xs rounded border border-slate-200 px-2 py-1 text-slate-600 hover:bg-slate-50"
                      >
                        Сменить PIN
                      </button>
                      <button
                        type="button"
                        onClick={() => { setDeleteId(w.id); setDeleteError(null); }}
                        className="text-xs rounded border border-rose-200 px-2 py-1 text-rose-600 hover:bg-rose-50"
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
            <div key={w.id} className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium text-slate-900">{w.name}</span>
                {w.isActive ? (
                  <span className="inline-flex items-center rounded border px-2 py-0.5 text-xs bg-emerald-50 text-emerald-700 border-emerald-200">Активен</span>
                ) : (
                  <span className="inline-flex items-center rounded border px-2 py-0.5 text-xs bg-slate-100 text-slate-500 border-slate-200">Отключён</span>
                )}
              </div>
              <p className="text-xs text-slate-400 mb-1">
                Последний вход: {w.lastLoginAt ? new Date(w.lastLoginAt).toLocaleString("ru-RU") : "—"}
              </p>
              <p className="text-xs text-slate-400 mb-1">Неудачных попыток: {w.failedAttempts}</p>
              {w.lockedUntil && (
                <p className="text-xs text-rose-600 mb-1">Заблокирован до: {new Date(w.lockedUntil).toLocaleString("ru-RU")}</p>
              )}
              <div className="flex gap-2 flex-wrap mt-3">
                <button
                  type="button"
                  onClick={() => handleToggleActive(w)}
                  className="text-xs rounded border border-slate-200 px-2 py-1.5 text-slate-600 hover:bg-slate-50"
                >
                  {w.isActive ? "Отключить" : "Включить"}
                </button>
                <button
                  type="button"
                  onClick={() => { setResetPinId(w.id); setResetPinValue(""); setResetPinError(null); }}
                  className="text-xs rounded border border-slate-200 px-2 py-1.5 text-slate-600 hover:bg-slate-50"
                >
                  Сменить PIN
                </button>
                <button
                  type="button"
                  onClick={() => { setDeleteId(w.id); setDeleteError(null); }}
                  className="text-xs rounded border border-rose-200 px-2 py-1.5 text-rose-600 hover:bg-rose-50"
                >
                  Удалить
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && workers.length === 0 && !error && (
        <p className="text-sm text-slate-400 py-6 text-center border border-slate-200 rounded-xl">
          Кладовщики не добавлены
        </p>
      )}

      {/* Reset PIN modal */}
      {resetPinId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-xs bg-white rounded-2xl border border-slate-200 shadow-lg p-6">
            <h2 className="text-base font-semibold text-slate-900 mb-4">Сменить PIN</h2>
            <input
              type="text"
              placeholder="Новый PIN (4 цифры)"
              value={resetPinValue}
              maxLength={4}
              onChange={(e) => setResetPinValue(e.target.value.replace(/\D/g, ""))}
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm mb-3"
            />
            {resetPinError && <p className="text-xs text-rose-600 mb-3">{resetPinError}</p>}
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setResetPinId(null)}
                className="rounded border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => handleResetPin(resetPinId)}
                disabled={resetPinLoading}
                className="rounded bg-slate-900 text-white px-4 py-2 text-sm hover:bg-slate-800 disabled:opacity-50"
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
          <div className="w-full max-w-xs bg-white rounded-2xl border border-slate-200 shadow-lg p-6">
            <h2 className="text-base font-semibold text-slate-900 mb-2">Удалить кладовщика?</h2>
            <p className="text-sm text-slate-600 mb-4">
              {workers.find((w) => w.id === deleteId)?.name}
            </p>
            {deleteError && <p className="text-xs text-rose-600 mb-3">{deleteError}</p>}
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setDeleteId(null)}
                className="rounded border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => handleDelete(deleteId)}
                disabled={deleteLoading}
                className="rounded bg-rose-600 text-white px-4 py-2 text-sm hover:bg-rose-700 disabled:opacity-50"
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

// ── Barcodes tab ─────────────────────────────────────────────────────────────

type UnitRow = {
  id: string;
  barcode: string | null;
  barcodePayload: string | null;
  status: string;
  serialNumber: string | null;
  comment: string | null;
  createdAt: string;
  equipment: { id: string; name: string; category: string; brand: string | null; model: string | null };
};

function BarcodesTab() {
  const [units, setUnits] = useState<UnitRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);

  // Filters
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [hasBarcodeFilter, setHasBarcodeFilter] = useState<"" | "true" | "false">("");

  // Stats
  const [stats, setStats] = useState({ total: 0, withBarcode: 0, withoutBarcode: 0, issued: 0 });

  // Selection for batch actions
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Assign modal
  const [assignModal, setAssignModal] = useState<{ unitId: string; equipmentId: string } | null>(null);
  const [assignBarcode, setAssignBarcode] = useState("");
  const [assignLoading, setAssignLoading] = useState(false);
  const [assignError, setAssignError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  // Categories for filter dropdown
  const [categories, setCategories] = useState<string[]>([]);

  // Debounced search
  const searchTimeout = useRef<ReturnType<typeof setTimeout>>();
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(searchTimeout.current);
  }, [search]);

  // Fetch stats on mount
  useEffect(() => {
    async function fetchStats() {
      try {
        const [allRes, barcodeRes, noBarcodeRes, issuedRes] = await Promise.all([
          apiFetch<{ total: number }>("/api/equipment-units?limit=1"),
          apiFetch<{ total: number }>("/api/equipment-units?hasBarcode=true&limit=1"),
          apiFetch<{ total: number }>("/api/equipment-units?hasBarcode=false&limit=1"),
          apiFetch<{ total: number }>("/api/equipment-units?status=ISSUED&limit=1"),
        ]);
        setStats({
          total: allRes.total,
          withBarcode: barcodeRes.total,
          withoutBarcode: noBarcodeRes.total,
          issued: issuedRes.total,
        });
      } catch {}
    }
    fetchStats();
  }, []);

  // Fetch categories on mount
  useEffect(() => {
    async function fetchCategories() {
      try {
        const res = await apiFetch<{ equipments: any[] }>("/api/equipment");
        const cats = [...new Set(res.equipments.map((e: any) => e.category))].filter(Boolean).sort();
        setCategories(cats as string[]);
      } catch {}
    }
    fetchCategories();
  }, []);

  // Fetch units
  useEffect(() => {
    async function fetchUnits() {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        params.set("page", String(page));
        params.set("limit", "50");
        if (debouncedSearch) params.set("search", debouncedSearch);
        if (statusFilter) params.set("status", statusFilter);
        if (categoryFilter) params.set("category", categoryFilter);
        if (hasBarcodeFilter) params.set("hasBarcode", hasBarcodeFilter);

        const res = await apiFetch<{ units: UnitRow[]; total: number; totalPages: number }>(`/api/equipment-units?${params.toString()}`);
        setUnits(res.units);
        setTotal(res.total);
        setTotalPages(res.totalPages);
      } catch {}
      setLoading(false);
    }
    fetchUnits();
  }, [page, debouncedSearch, statusFilter, categoryFilter, hasBarcodeFilter, refreshKey]);

  // Reset page on filter change
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, statusFilter, categoryFilter, hasBarcodeFilter]);

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === units.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(units.map(u => u.id)));
    }
  }

  async function handlePrintLabels() {
    const ids = [...selected].filter(id => {
      const u = units.find(u => u.id === id);
      return u?.barcode && u?.barcodePayload;
    });
    if (ids.length === 0) return;

    try {
      const res = await fetch("/api/equipment-units/labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unitIds: ids }),
      });
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "labels.pdf";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert("Ошибка при генерации этикеток");
    }
  }

  async function handleAssign() {
    if (!assignModal || !assignBarcode.trim()) return;
    setAssignLoading(true);
    setAssignError("");
    try {
      await apiFetch(`/api/equipment/${assignModal.equipmentId}/units/${assignModal.unitId}/assign-barcode`, {
        method: "POST",
        body: JSON.stringify({ barcode: assignBarcode.trim() }),
      });
      setAssignModal(null);
      setAssignBarcode("");
      setRefreshKey(k => k + 1);
    } catch (err: any) {
      setAssignError(err?.message || "Ошибка привязки штрихкода");
    }
    setAssignLoading(false);
  }

  const STATUS_LABELS: Record<string, string> = {
    AVAILABLE: "Доступен",
    ISSUED: "Выдан",
    MAINTENANCE: "Обслуживание",
    RETIRED: "Списан",
    MISSING: "Утерян",
  };

  const STATUS_COLORS: Record<string, string> = {
    AVAILABLE: "bg-green-100 text-green-700",
    ISSUED: "bg-blue-100 text-blue-700",
    MAINTENANCE: "bg-amber-100 text-amber-700",
    RETIRED: "bg-slate-100 text-slate-500",
    MISSING: "bg-red-100 text-red-700",
  };

  return (
    <div>
      {/* Stats bar */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        <div className="bg-slate-50 rounded-lg p-3 text-center">
          <div className="text-lg font-semibold">{stats.total}</div>
          <div className="text-xs text-slate-500">Всего единиц</div>
        </div>
        <div className="bg-green-50 rounded-lg p-3 text-center">
          <div className="text-lg font-semibold text-green-700">{stats.withBarcode}</div>
          <div className="text-xs text-slate-500">Со штрихкодом</div>
        </div>
        <div className="bg-amber-50 rounded-lg p-3 text-center">
          <div className="text-lg font-semibold text-amber-700">{stats.withoutBarcode}</div>
          <div className="text-xs text-slate-500">Без штрихкода</div>
        </div>
        <div className="bg-blue-50 rounded-lg p-3 text-center">
          <div className="text-lg font-semibold text-blue-700">{stats.issued}</div>
          <div className="text-xs text-slate-500">Выдано</div>
        </div>
      </div>

      {/* Filters row */}
      <div className="flex gap-2 mb-4 flex-wrap">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Поиск по штрихкоду, серийному №, названию..."
          className="flex-1 min-w-[200px] px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-300"
        />
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="px-3 py-2 text-sm border border-slate-200 rounded-lg"
        >
          <option value="">Все статусы</option>
          <option value="AVAILABLE">Доступен</option>
          <option value="ISSUED">Выдан</option>
          <option value="MAINTENANCE">Обслуживание</option>
          <option value="RETIRED">Списан</option>
          <option value="MISSING">Утерян</option>
        </select>
        <select
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value)}
          className="px-3 py-2 text-sm border border-slate-200 rounded-lg"
        >
          <option value="">Все категории</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select
          value={hasBarcodeFilter}
          onChange={e => setHasBarcodeFilter(e.target.value as "" | "true" | "false")}
          className="px-3 py-2 text-sm border border-slate-200 rounded-lg"
        >
          <option value="">Штрихкод: все</option>
          <option value="true">Со штрихкодом</option>
          <option value="false">Без штрихкода</option>
        </select>
      </div>

      {/* Batch actions */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 mb-4 p-3 bg-slate-50 rounded-lg">
          <span className="text-sm text-slate-600">Выбрано: {selected.size}</span>
          <button
            onClick={handlePrintLabels}
            className="px-3 py-1.5 text-sm font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-700"
          >
            Печать этикеток
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="px-3 py-1.5 text-sm text-slate-500 hover:text-slate-700"
          >
            Снять выделение
          </button>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="text-center py-8 text-slate-400">Загрузка...</div>
      ) : units.length === 0 ? (
        <div className="text-center py-8 text-slate-400">Ничего не найдено</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200">
                <th className="py-2 px-2 text-left">
                  <input type="checkbox" onChange={toggleAll} checked={selected.size === units.length && units.length > 0} />
                </th>
                <th className="py-2 px-2 text-left text-slate-500 font-medium">Штрихкод</th>
                <th className="py-2 px-2 text-left text-slate-500 font-medium">Оборудование</th>
                <th className="py-2 px-2 text-left text-slate-500 font-medium">Категория</th>
                <th className="py-2 px-2 text-left text-slate-500 font-medium">Статус</th>
                <th className="py-2 px-2 text-left text-slate-500 font-medium">Серийный №</th>
                <th className="py-2 px-2 text-left text-slate-500 font-medium">Дата</th>
                <th className="py-2 px-2"></th>
              </tr>
            </thead>
            <tbody>
              {units.map(u => (
                <tr key={u.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="py-2 px-2">
                    <input type="checkbox" checked={selected.has(u.id)} onChange={() => toggleSelect(u.id)} />
                  </td>
                  <td className="py-2 px-2 font-mono text-xs">{u.barcode || <span className="text-slate-300">—</span>}</td>
                  <td className="py-2 px-2">
                    <Link href={`/equipment/${u.equipment.id}/units`} className="text-blue-600 hover:underline">
                      {u.equipment.name}
                    </Link>
                  </td>
                  <td className="py-2 px-2 text-slate-500">{u.equipment.category}</td>
                  <td className="py-2 px-2">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[u.status] || "bg-slate-100"}`}>
                      {STATUS_LABELS[u.status] || u.status}
                    </span>
                  </td>
                  <td className="py-2 px-2 text-slate-500 text-xs">{u.serialNumber || "—"}</td>
                  <td className="py-2 px-2 text-slate-400 text-xs">{formatDate(u.createdAt)}</td>
                  <td className="py-2 px-2">
                    {!u.barcode && (
                      <button
                        onClick={() => { setAssignModal({ unitId: u.id, equipmentId: u.equipment.id }); setAssignBarcode(""); setAssignError(""); }}
                        className="text-xs text-blue-600 hover:underline whitespace-nowrap"
                      >
                        Привязать
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <span className="text-sm text-slate-500">
            Показано {(page - 1) * 50 + 1}–{Math.min(page * 50, total)} из {total}
          </span>
          <div className="flex gap-1">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-3 py-1.5 text-sm border border-slate-200 rounded-lg disabled:opacity-30"
            >
              ←
            </button>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="px-3 py-1.5 text-sm border border-slate-200 rounded-lg disabled:opacity-30"
            >
              →
            </button>
          </div>
        </div>
      )}

      {/* Assign barcode modal */}
      {assignModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setAssignModal(null)}>
          <div className="bg-white rounded-xl p-6 w-full max-w-sm shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold mb-4">Привязать штрихкод</h3>
            <input
              type="text"
              value={assignBarcode}
              onChange={e => setAssignBarcode(e.target.value)}
              placeholder="Введите штрихкод..."
              className="w-full px-3 py-2 border border-slate-200 rounded-lg mb-3 focus:outline-none focus:ring-2 focus:ring-slate-300"
              autoFocus
            />
            {assignError && <p className="text-sm text-red-600 mb-3">{assignError}</p>}
            <div className="flex gap-2 justify-end">
              <button onClick={() => setAssignModal(null)} className="px-4 py-2 text-sm text-slate-500 hover:text-slate-700">
                Отмена
              </button>
              <button
                onClick={handleAssign}
                disabled={assignLoading || !assignBarcode.trim()}
                className="px-4 py-2 text-sm font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-700 disabled:opacity-50"
              >
                {assignLoading ? "..." : "Привязать"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tab: Аналитика цен ────────────────────────────────────────────────────────

type PricesStep = "empty" | "upload" | "mapping" | "review";
type PricesFilter = "changed" | "all" | "price" | "new" | "removed" | "qty" | "unmatched";

const PRICE_MAPPING_FIELDS = [
  { key: "name", label: "Наименование", required: true },
  { key: "category", label: "Категория", required: false },
  { key: "brand", label: "Бренд", required: false },
  { key: "model", label: "Модель", required: false },
  { key: "quantity", label: "Количество", required: false },
  { key: "rentalRatePerShift", label: "Цена (смена)", required: true },
  { key: "rentalRateTwoShifts", label: "Цена (2 смены)", required: false },
  { key: "rentalRatePerProject", label: "Цена (проект)", required: false },
] as const;

type PriceMappingKey = (typeof PRICE_MAPPING_FIELDS)[number]["key"];
type PriceMappingState = Partial<Record<PriceMappingKey, string>>;

type UploadPreview = {
  session: ImportSession;
  preview: {
    headers: string[];
    sampleRows: Record<string, unknown>[];
    suggestedMapping: Record<string, string>;
  };
};

type MapStats = {
  priceChanges: number;
  newItems: number;
  removedItems: number;
  qtyChanges: number;
  noChange: number;
};

const FILTER_OPTIONS: Array<{ id: PricesFilter; label: string; actionFilter?: string; queryParam?: string }> = [
  { id: "changed", label: "Изменённые", queryParam: "changed" },
  { id: "all", label: "Все" },
  { id: "price", label: "Цены", actionFilter: "PRICE_CHANGE" },
  { id: "new", label: "Новые", actionFilter: "NEW_ITEM" },
  { id: "removed", label: "Удалённые", actionFilter: "REMOVED_ITEM" },
  { id: "qty", label: "Количество", actionFilter: "QTY_CHANGE" },
  { id: "unmatched", label: "Не найдено", queryParam: "unmatched" },
];

function actionLabel(action: string): string {
  switch (action) {
    case "PRICE_CHANGE": return "Цена";
    case "NEW_ITEM": return "Новая";
    case "REMOVED_ITEM": return "Удалена";
    case "QTY_CHANGE": return "Кол-во";
    case "NO_CHANGE": return "Без изм.";
    default: return action;
  }
}

function rowBgClass(row: ImportSessionRow): string {
  const delta = row.priceDelta ? parseFloat(row.priceDelta) : null;
  if (row.action === "REMOVED_ITEM") return "bg-red-50";
  if (row.action === "NEW_ITEM") return "bg-green-50";
  if (delta !== null) {
    if (delta > 5) return "bg-red-50";
    if (delta < -5) return "bg-green-50";
    return "bg-yellow-50";
  }
  return "";
}

function confidenceBadge(conf: string | null) {
  if (!conf) return null;
  const v = parseFloat(conf);
  const cls =
    v >= 0.8
      ? "bg-green-100 text-green-800"
      : v >= 0.5
      ? "bg-yellow-100 text-yellow-800"
      : "bg-red-100 text-red-800";
  return (
    <span className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded ${cls}`}>
      {Math.round(v * 100)}%
    </span>
  );
}

function PricesTab() {
  const [step, setStep] = useState<PricesStep>("empty");
  const [sessions, setSessions] = useState<ImportSession[]>([]);
  const [activeSession, setActiveSession] = useState<ImportSession | null>(null);
  const [preview, setPreview] = useState<UploadPreview["preview"] | null>(null);
  const [mappingConfig, setMappingConfig] = useState<PriceMappingState>({});
  const [importType, setImportType] = useState<"OWN_PRICE_UPDATE" | "COMPETITOR_IMPORT">("OWN_PRICE_UPDATE");
  const [competitorName, setCompetitorName] = useState("");
  const [rows, setRows] = useState<ImportSessionRow[]>([]);
  const [rowsTotal, setRowsTotal] = useState(0);
  const [rowsPage, setRowsPage] = useState(1);
  const [rowsTotalPages, setRowsTotalPages] = useState(1);
  const [filter, setFilter] = useState<PricesFilter>("changed");
  const [stats, setStats] = useState<MapStats | null>(null);
  const [uploading, setUploading] = useState(false);
  const [mapping, setMapping] = useState(false);
  const [applying, setApplying] = useState(false);
  const [loadingRows, setLoadingRows] = useState(false);
  const [confirmBulk, setConfirmBulk] = useState<{ action: "ACCEPTED" | "REJECTED"; count: number } | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);
  const [applyResult, setApplyResult] = useState<{ applied: Record<string, number>; skipped: Array<{ id: string; reason: string }> } | null>(null);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const dropRef = useRef<HTMLInputElement>(null);

  // ── Load sessions on mount ─────────────────────────────────────────────────

  async function loadSessions() {
    try {
      const data = await apiFetch<{ sessions: ImportSession[] }>("/api/import-sessions");
      setSessions(data.sessions ?? []);
      // Auto-resume active OWN session that is in MAPPED/PENDING state
      const active = (data.sessions ?? []).find(
        (s) => s.type === "OWN_PRICE_UPDATE" && s.status === "REVIEW"
      );
      if (active) {
        handleOpenSession(active);
      }
    } catch {
      setSessions([]);
    }
  }

  useEffect(() => {
    loadSessions();
  }, []);

  // ── Load rows for review ───────────────────────────────────────────────────

  async function loadRows(sessionId: string, f: PricesFilter, page: number) {
    setLoadingRows(true);
    try {
      const opt = FILTER_OPTIONS.find((x) => x.id === f);
      const params = new URLSearchParams({ page: String(page), limit: "50" });
      if (opt?.actionFilter) params.set("action", opt.actionFilter);
      if (opt?.queryParam) params.set(opt.queryParam, "true");
      const data = await apiFetch<{ rows: ImportSessionRow[]; total: number; totalPages: number }>(
        `/api/import-sessions/${sessionId}/rows?${params.toString()}`
      );
      setRows(data.rows ?? []);
      setRowsTotal(data.total ?? 0);
      setRowsTotalPages(data.totalPages ?? 1);
      setRowsPage(page);
    } catch {
      setRows([]);
    } finally {
      setLoadingRows(false);
    }
  }

  // ── Upload ─────────────────────────────────────────────────────────────────

  async function handleUpload(file: File) {
    setUploading(true);
    setMessage(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await apiFetch<UploadPreview>("/api/import-sessions/upload", {
        method: "POST",
        body: form,
      });
      setActiveSession(res.session);
      setPreview(res.preview);
      const suggested = res.preview?.suggestedMapping ?? {};
      const next: PriceMappingState = {};
      for (const k of Object.keys(suggested)) {
        next[k as PriceMappingKey] = suggested[k];
      }
      setMappingConfig(next);
      setStep("mapping");
    } catch (e) {
      setMessage({ type: "err", text: e instanceof Error ? e.message : "Ошибка загрузки файла" });
    } finally {
      setUploading(false);
    }
  }

  // ── Start analysis (map) ───────────────────────────────────────────────────

  async function handleMap() {
    if (!activeSession) return;
    setMapping(true);
    setMessage(null);
    try {
      const columnMapping: Record<string, string> = {};
      for (const k of Object.keys(mappingConfig)) {
        const v = mappingConfig[k as PriceMappingKey];
        if (v) columnMapping[k] = v;
      }
      const res = await apiFetch<{ session: ImportSession; stats: MapStats }>(
        `/api/import-sessions/${activeSession.id}/map`,
        {
          method: "POST",
          body: JSON.stringify({
            type: importType,
            competitorName: importType === "COMPETITOR_IMPORT" ? competitorName || undefined : undefined,
            mapping: columnMapping,
          }),
        }
      );
      setActiveSession(res.session);
      setStats(res.stats);
      setStep("review");
      loadRows(res.session.id, "changed", 1);
    } catch (e) {
      setMessage({ type: "err", text: e instanceof Error ? e.message : "Ошибка анализа" });
    } finally {
      setMapping(false);
    }
  }

  // ── Toggle row status ──────────────────────────────────────────────────────

  async function handleRowToggle(row: ImportSessionRow) {
    if (!activeSession) return;
    const newStatus = row.status === "ACCEPTED" ? "REJECTED" : "ACCEPTED";
    try {
      await apiFetch(`/api/import-sessions/${activeSession.id}/rows/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: newStatus }),
      });
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, status: newStatus } : r)));
    } catch (e) {
      setMessage({ type: "err", text: e instanceof Error ? e.message : "Ошибка обновления строки" });
    }
  }

  // ── Bulk action ────────────────────────────────────────────────────────────

  async function handleBulkAction(action: "ACCEPTED" | "REJECTED") {
    if (!activeSession) return;
    setConfirmBulk(null);
    try {
      const opt = FILTER_OPTIONS.find((x) => x.id === filter);
      const filterObj = opt?.actionFilter ? { action: opt.actionFilter } : {};
      await apiFetch(`/api/import-sessions/${activeSession.id}/bulk-action`, {
        method: "POST",
        body: JSON.stringify({ action, filter: filterObj }),
      });
      loadRows(activeSession.id, filter, rowsPage);
      setMessage({ type: "ok", text: action === "ACCEPTED" ? "Все позиции приняты" : "Все позиции отклонены" });
    } catch (e) {
      setMessage({ type: "err", text: e instanceof Error ? e.message : "Ошибка массового действия" });
    }
  }

  // ── Apply ──────────────────────────────────────────────────────────────────

  async function handleApply() {
    if (!activeSession) return;
    setApplying(true);
    setConfirmApply(false);
    setMessage(null);
    try {
      const res = await apiFetch<{ applied: Record<string, number>; skipped: Array<{ id: string; reason: string }> }>(
        `/api/import-sessions/${activeSession.id}/apply`,
        { method: "POST" }
      );
      setApplyResult(res);
      setMessage({ type: "ok", text: "Изменения применены" });
      loadSessions();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Ошибка применения";
      if (msg.includes("409") || msg.toLowerCase().includes("применяются")) {
        setMessage({ type: "err", text: "Изменения уже применяются, подождите" });
      } else {
        setMessage({ type: "err", text: msg });
      }
    } finally {
      setApplying(false);
    }
  }

  // ── Export ─────────────────────────────────────────────────────────────────

  async function handleExport(sessionId: string) {
    try {
      const res = await fetch(`/api/import-sessions/${sessionId}/export`);
      if (!res.ok) throw new Error("Ошибка экспорта");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `import-session-${sessionId}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setMessage({ type: "err", text: e instanceof Error ? e.message : "Ошибка экспорта" });
    }
  }

  // ── Delete session ─────────────────────────────────────────────────────────

  async function handleDeleteSession(sessionId: string) {
    if (!confirm("Удалить сессию импорта?")) return;
    try {
      await apiFetch(`/api/import-sessions/${sessionId}`, { method: "DELETE" });
      if (activeSession?.id === sessionId) {
        setActiveSession(null);
        setStep("empty");
        setRows([]);
      }
      loadSessions();
    } catch (e) {
      setMessage({ type: "err", text: e instanceof Error ? e.message : "Ошибка удаления" });
    }
  }

  // ── Open existing session ──────────────────────────────────────────────────

  async function handleOpenSession(session: ImportSession) {
    setActiveSession(session);
    // Загружаем stats из API для подтверждения применения
    try {
      const data = await apiFetch<{ session: ImportSession; rows: ImportSessionRow[]; total: number }>(`/api/import-sessions/${session.id}/rows?limit=1&page=1`);
      // Fetch action distribution from rows endpoint with each action filter
      const actionCounts: MapStats = { priceChanges: 0, newItems: 0, removedItems: 0, qtyChanges: 0, noChange: 0 };
      const countPromises = [
        apiFetch<{ total: number }>(`/api/import-sessions/${session.id}/rows?action=PRICE_CHANGE&limit=1`).then(r => actionCounts.priceChanges = r.total),
        apiFetch<{ total: number }>(`/api/import-sessions/${session.id}/rows?action=NEW_ITEM&limit=1`).then(r => actionCounts.newItems = r.total),
        apiFetch<{ total: number }>(`/api/import-sessions/${session.id}/rows?action=REMOVED_ITEM&limit=1`).then(r => actionCounts.removedItems = r.total),
        apiFetch<{ total: number }>(`/api/import-sessions/${session.id}/rows?action=QTY_CHANGE&limit=1`).then(r => actionCounts.qtyChanges = r.total),
        apiFetch<{ total: number }>(`/api/import-sessions/${session.id}/rows?action=NO_CHANGE&limit=1`).then(r => actionCounts.noChange = r.total),
      ];
      await Promise.all(countPromises);
      setStats(actionCounts);
    } catch { /* stats загрузятся при следующем map, не критично */ }
    setStep("review");
    loadRows(session.id, "changed", 1);
  }

  // ── Drag & drop zone ───────────────────────────────────────────────────────

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) handleUpload(file);
  }

  const isOwnMode = (activeSession?.type ?? importType) === "OWN_PRICE_UPDATE";
  const acceptedCount = activeSession?.acceptedCount ?? rows.filter((r) => r.status === "ACCEPTED").length;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-800">Аналитика цен</h2>
          <p className="text-sm text-slate-500 mt-1">
            Загрузите прайс-лист для обновления цен или сравнения с конкурентом.
          </p>
        </div>
        {step !== "empty" && (
          <button
            onClick={() => { setStep("empty"); setActiveSession(null); setRows([]); setApplyResult(null); loadSessions(); }}
            className="shrink-0 text-xs text-slate-400 hover:text-slate-700 border border-slate-200 rounded-lg px-3 py-1.5 hover:bg-slate-50 transition-colors"
          >
            ← Назад
          </button>
        )}
      </div>

      {message && (
        <div className={`px-4 py-3 rounded-lg text-sm font-medium ${message.type === "ok" ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-red-50 text-red-700 border border-red-200"}`}>
          {message.text}
          <button onClick={() => setMessage(null)} className="ml-3 text-xs opacity-60 hover:opacity-100">✕</button>
        </div>
      )}

      {/* ── Empty / upload step ─────────────────────────────────────────────── */}
      {step === "empty" && (
        <div className="space-y-5">
          {/* Upload dropzone */}
          <div
            className="rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 hover:bg-slate-100 transition-colors cursor-pointer"
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => dropRef.current?.click()}
          >
            <div className="flex flex-col items-center py-10 px-6 text-center">
              <svg className="w-10 h-10 text-slate-400 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              <p className="text-sm font-medium text-slate-700">
                {uploading ? "Загрузка…" : "Перетащите файл или нажмите для выбора"}
              </p>
              <p className="text-xs text-slate-400 mt-1">Поддерживаются .xlsx, .xls</p>
            </div>
            <input
              ref={dropRef}
              type="file"
              className="hidden"
              accept=".xlsx,.xls"
              disabled={uploading}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f); }}
            />
          </div>

          {/* Past sessions */}
          {sessions.length > 0 && (
            <div className="rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase tracking-wide">
                Прошлые сессии
              </div>
              <div className="divide-y divide-slate-100">
                {sessions.map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-800 truncate">{s.fileName}</div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {formatDate(s.createdAt)} · {s.type === "COMPETITOR_IMPORT" ? `Конкурент: ${s.competitorName ?? "—"}` : "Обновление прайса"} · {s.status}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => handleOpenSession(s)}
                        className="px-3 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors"
                      >
                        Открыть
                      </button>
                      <button
                        onClick={() => handleExport(s.id)}
                        className="px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
                      >
                        Скачать XLSX
                      </button>
                      <button
                        onClick={() => handleDeleteSession(s.id)}
                        className="px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-lg transition-colors"
                      >
                        Удалить
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Mapping step ────────────────────────────────────────────────────── */}
      {step === "mapping" && preview && (
        <div className="space-y-5">
          {/* Type + competitor */}
          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="px-4 py-3 bg-slate-50 border-b border-slate-200">
              <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Шаг 1 — Тип импорта</span>
            </div>
            <div className="p-4 space-y-3">
              <div className="flex gap-3">
                {(["OWN_PRICE_UPDATE", "COMPETITOR_IMPORT"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setImportType(t)}
                    className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                      importType === t
                        ? "bg-slate-900 text-white border-slate-900"
                        : "bg-white text-slate-600 border-slate-300 hover:border-slate-500"
                    }`}
                  >
                    {t === "OWN_PRICE_UPDATE" ? "Обновление прайса" : "Сравнение с конкурентом"}
                  </button>
                ))}
              </div>
              {importType === "COMPETITOR_IMPORT" && (
                <div>
                  <label className="text-xs text-slate-500 mb-1 block">Название конкурента</label>
                  <input
                    type="text"
                    value={competitorName}
                    onChange={(e) => setCompetitorName(e.target.value)}
                    placeholder="Например: РентаЛайт"
                    className="w-full max-w-xs px-3 py-2 text-sm rounded-lg border border-slate-300 focus:outline-none focus:border-slate-500"
                  />
                </div>
              )}
            </div>
          </div>

          {/* Column mapping */}
          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="px-4 py-3 bg-slate-50 border-b border-slate-200">
              <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Шаг 2 — Сопоставление колонок</span>
            </div>
            <div className="p-4 grid grid-cols-1 lg:grid-cols-12 gap-6">
              <div className="lg:col-span-6 space-y-2">
                {PRICE_MAPPING_FIELDS.map((f) => (
                  <div key={f.key} className="flex items-center gap-3">
                    <div className="w-44 text-xs text-slate-500 shrink-0">
                      {f.label}
                      {f.required && <span className="text-red-500 ml-0.5">*</span>}
                    </div>
                    <select
                      className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm bg-white"
                      value={mappingConfig[f.key] ?? ""}
                      onChange={(e) =>
                        setMappingConfig((prev) => ({ ...prev, [f.key]: e.target.value || undefined }))
                      }
                    >
                      <option value="">(не используется)</option>
                      {preview.headers.map((h) => (
                        <option value={h} key={h}>{h}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>

              {/* Sample rows */}
              <div className="lg:col-span-6">
                <div className="rounded-lg border border-slate-200 bg-slate-50 overflow-hidden">
                  <div className="px-3 py-2 border-b border-slate-200 text-xs font-semibold text-slate-600">
                    Предпросмотр (первые строки)
                  </div>
                  <div className="overflow-auto max-h-48">
                    <table className="min-w-[400px] w-full text-xs">
                      <thead className="bg-slate-100">
                        <tr>
                          {preview.headers.slice(0, 6).map((h) => (
                            <th key={h} className="text-left px-3 py-2 border-b border-slate-200 font-medium text-slate-600">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.sampleRows.slice(0, 5).map((row, idx) => (
                          <tr key={idx} className="border-t border-slate-100">
                            {preview.headers.slice(0, 6).map((h) => (
                              <td key={h} className="px-3 py-1.5 text-slate-700">{String(row[h] ?? "")}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <button
            onClick={handleMap}
            disabled={mapping || !mappingConfig.name || !mappingConfig.rentalRatePerShift}
            className="inline-flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-medium bg-slate-900 text-white hover:bg-slate-700 disabled:opacity-50 transition-colors"
          >
            {mapping ? "Анализ…" : "Начать анализ"}
          </button>
        </div>
      )}

      {/* ── Review step ─────────────────────────────────────────────────────── */}
      {step === "review" && activeSession && (
        <div className="space-y-4">
          {/* Header info */}
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm font-medium text-slate-700">{activeSession.fileName}</span>
            <span className="text-xs text-slate-500">
              {activeSession.type === "COMPETITOR_IMPORT"
                ? `Конкурент: ${activeSession.competitorName ?? "—"}`
                : "Обновление прайса"}
            </span>
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${activeSession.status === "COMPLETED" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
              {activeSession.status}
            </span>
          </div>

          {/* Stats bar */}
          {stats && (
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              {[
                { label: "Изменены цены", value: stats.priceChanges, color: "text-amber-700" },
                { label: "Новые", value: stats.newItems, color: "text-emerald-700" },
                { label: "Удалены", value: stats.removedItems, color: "text-red-700" },
                { label: "Кол-во", value: stats.qtyChanges, color: "text-blue-700" },
                { label: "Без изм.", value: stats.noChange, color: "text-slate-500" },
              ].map(({ label, value, color }) => (
                <div key={label} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <div className={`text-xl font-bold ${color}`}>{value}</div>
                  <div className="text-xs text-slate-500 mt-0.5">{label}</div>
                </div>
              ))}
            </div>
          )}

          {/* Filter pills */}
          <div className="flex gap-1.5 flex-wrap">
            {FILTER_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                onClick={() => { setFilter(opt.id); if (activeSession) loadRows(activeSession.id, opt.id, 1); }}
                className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
                  filter === opt.id
                    ? "bg-slate-900 text-white border-slate-900"
                    : "bg-white text-slate-600 border-slate-300 hover:border-slate-500"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Bulk actions (OWN mode only) */}
          {isOwnMode && activeSession.status !== "COMPLETED" && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setConfirmBulk({ action: "ACCEPTED", count: rowsTotal })}
                className="px-3 py-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-lg border border-emerald-200 transition-colors"
              >
                Принять все
              </button>
              <button
                onClick={() => setConfirmBulk({ action: "REJECTED", count: rowsTotal })}
                className="px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 hover:bg-red-100 rounded-lg border border-red-200 transition-colors"
              >
                Отклонить все
              </button>
              <span className="text-xs text-slate-400">в текущем фильтре</span>
            </div>
          )}

          {/* Apply result */}
          {applyResult && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 space-y-1">
              <div className="font-semibold text-emerald-800 mb-2">Изменения применены</div>
              {Object.entries(applyResult.applied).map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <span className="text-emerald-700">{k}</span>
                  <span className="font-semibold">{v}</span>
                </div>
              ))}
              {applyResult.skipped.length > 0 && (
                <div className="mt-2 pt-2 border-t border-emerald-200">
                  <div className="text-amber-700 font-medium">Пропущено {applyResult.skipped.length} позиц.</div>
                  <ul className="mt-1 space-y-0.5">
                    {applyResult.skipped.map((s) => (
                      <li key={s.id} className="text-xs text-amber-600">{s.reason}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Table */}
          <div className="rounded-xl border border-slate-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="text-left px-3 py-2.5 font-semibold text-slate-600">Позиция</th>
                    <th className="text-left px-3 py-2.5 font-semibold text-slate-600">Категория</th>
                    {isOwnMode ? (
                      <>
                        <th className="text-right px-3 py-2.5 font-semibold text-slate-600">Текущая цена</th>
                        <th className="text-right px-3 py-2.5 font-semibold text-slate-600">Новая цена</th>
                        <th className="text-right px-3 py-2.5 font-semibold text-slate-600">Δ%</th>
                        <th className="text-right px-3 py-2.5 font-semibold text-slate-600">Кол-во</th>
                        <th className="text-left px-3 py-2.5 font-semibold text-slate-600">Действие</th>
                        {activeSession.status !== "COMPLETED" && (
                          <th className="px-3 py-2.5" />
                        )}
                      </>
                    ) : (
                      <>
                        <th className="text-right px-3 py-2.5 font-semibold text-slate-600">Наша цена</th>
                        <th className="text-right px-3 py-2.5 font-semibold text-slate-600">Конкурент</th>
                        <th className="text-right px-3 py-2.5 font-semibold text-slate-600">Δ%</th>
                        <th className="text-left px-3 py-2.5 font-semibold text-slate-600">Уверенность</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {loadingRows ? (
                    <tr>
                      <td colSpan={isOwnMode ? 8 : 6} className="py-8 text-center text-slate-400">Загрузка…</td>
                    </tr>
                  ) : rows.length === 0 ? (
                    <tr>
                      <td colSpan={isOwnMode ? 8 : 6} className="py-8 text-center text-slate-400">Нет позиций</td>
                    </tr>
                  ) : (
                    rows.map((row) => {
                      const bg = rowBgClass(row);
                      const delta = row.priceDelta ? parseFloat(row.priceDelta) : null;
                      const isRemovedWithBookings = row.action === "REMOVED_ITEM" && row.hasActiveBookings;
                      return (
                        <tr key={row.id} className={bg}>
                          <td className="px-3 py-2.5 text-slate-800 max-w-[200px]">
                            <div className="truncate">{row.sourceName}</div>
                            {!row.equipmentId && (
                              <span className="inline-block text-[10px] font-medium bg-slate-100 text-slate-500 rounded px-1.5 py-0.5 mt-0.5">Не найдено</span>
                            )}
                            {row.matchMethod?.includes(":FLAGGED") && (
                              <span className="inline-block text-[10px] font-medium bg-amber-100 text-amber-700 rounded px-1.5 py-0.5 mt-0.5">⚠️ Подозрительное значение</span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-slate-500">{row.sourceCategory ?? row.equipment?.category ?? "—"}</td>
                          {isOwnMode ? (
                            <>
                              <td className="px-3 py-2.5 text-right text-slate-700">{row.oldPrice ?? "—"}</td>
                              <td className="px-3 py-2.5 text-right font-medium text-slate-900">{row.sourcePrice ?? "—"}</td>
                              <td className={`px-3 py-2.5 text-right font-medium ${delta !== null ? (delta > 5 ? "text-red-700" : delta < -5 ? "text-green-700" : "text-amber-700") : "text-slate-400"}`}>
                                {delta !== null ? `${delta > 0 ? "+" : ""}${delta.toFixed(1)}%` : "—"}
                              </td>
                              <td className="px-3 py-2.5 text-right text-slate-600">
                                {row.sourceQty !== null ? row.sourceQty : "—"}
                              </td>
                              <td className="px-3 py-2.5">
                                <span className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                                  row.action === "NEW_ITEM" ? "bg-green-100 text-green-800"
                                  : row.action === "REMOVED_ITEM" ? "bg-red-100 text-red-800"
                                  : row.action === "PRICE_CHANGE" ? "bg-amber-100 text-amber-800"
                                  : row.action === "QTY_CHANGE" ? "bg-blue-100 text-blue-800"
                                  : "bg-slate-100 text-slate-600"
                                }`}>
                                  {actionLabel(row.action)}
                                </span>
                              </td>
                              {activeSession.status !== "COMPLETED" && (
                                <td className="px-3 py-2.5 text-right">
                                  {isRemovedWithBookings ? (
                                    <span
                                      title="Нельзя удалить (активные брони)"
                                      className="inline-block text-[10px] text-slate-400 cursor-not-allowed px-2 py-1 rounded border border-slate-200"
                                    >
                                      Заблокировано
                                    </span>
                                  ) : (
                                    <button
                                      onClick={() => handleRowToggle(row)}
                                      className={`text-[10px] font-medium px-2 py-1 rounded border transition-colors ${
                                        row.status === "ACCEPTED"
                                          ? "bg-emerald-100 text-emerald-800 border-emerald-200 hover:bg-emerald-200"
                                          : "bg-white text-slate-600 border-slate-300 hover:border-emerald-400"
                                      }`}
                                    >
                                      {row.status === "ACCEPTED" ? "Принято ✓" : "Принять"}
                                    </button>
                                  )}
                                </td>
                              )}
                            </>
                          ) : (
                            <>
                              <td className="px-3 py-2.5 text-right text-slate-700">{row.oldPrice ?? "—"}</td>
                              <td className="px-3 py-2.5 text-right font-medium text-slate-900">{row.sourcePrice ?? "—"}</td>
                              <td className={`px-3 py-2.5 text-right font-medium ${delta !== null ? (delta > 5 ? "text-red-700" : delta < -5 ? "text-green-700" : "text-amber-700") : "text-slate-400"}`}>
                                {delta !== null ? `${delta > 0 ? "+" : ""}${delta.toFixed(1)}%` : "—"}
                              </td>
                              <td className="px-3 py-2.5">{confidenceBadge(row.matchConfidence)}</td>
                            </>
                          )}
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {rowsTotalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-slate-200 bg-slate-50">
                <span className="text-xs text-slate-500">
                  Страница {rowsPage} из {rowsTotalPages} · {rowsTotal} позиций
                </span>
                <div className="flex gap-2">
                  <button
                    disabled={rowsPage <= 1}
                    onClick={() => { if (activeSession) loadRows(activeSession.id, filter, rowsPage - 1); }}
                    className="px-3 py-1.5 text-xs rounded-lg border border-slate-300 disabled:opacity-40 hover:bg-slate-100 transition-colors"
                  >
                    ← Назад
                  </button>
                  <button
                    disabled={rowsPage >= rowsTotalPages}
                    onClick={() => { if (activeSession) loadRows(activeSession.id, filter, rowsPage + 1); }}
                    className="px-3 py-1.5 text-xs rounded-lg border border-slate-300 disabled:opacity-40 hover:bg-slate-100 transition-colors"
                  >
                    Вперёд →
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Bottom actions */}
          <div className="flex items-center gap-3 flex-wrap pt-1">
            <button
              onClick={() => handleExport(activeSession.id)}
              className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-xl transition-colors"
            >
              Скачать XLSX
            </button>
            {isOwnMode && activeSession.status !== "COMPLETED" && (
              <button
                onClick={() => setConfirmApply(true)}
                disabled={applying}
                className="px-4 py-2 text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 rounded-xl transition-colors"
              >
                {applying ? "Применение…" : `Применить ${acceptedCount > 0 ? acceptedCount : ""} изменений`}
              </button>
            )}
            <button
              onClick={() => handleDeleteSession(activeSession.id)}
              className="px-4 py-2 text-sm font-medium text-red-600 bg-red-50 hover:bg-red-100 border border-red-200 rounded-xl transition-colors"
            >
              Удалить сессию
            </button>
          </div>
        </div>
      )}

      {/* ── Bulk confirm modal ───────────────────────────────────────────────── */}
      {confirmBulk && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm space-y-4">
            <h3 className="text-base font-semibold text-slate-900">
              {confirmBulk.action === "ACCEPTED" ? "Принять" : "Отклонить"} {confirmBulk.count} позиций?
            </h3>
            <p className="text-sm text-slate-500">
              Действие применится ко всем строкам в текущем фильтре.
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmBulk(null)} className="px-4 py-2 text-sm text-slate-500 hover:text-slate-700">
                Отмена
              </button>
              <button
                onClick={() => handleBulkAction(confirmBulk.action)}
                className={`px-4 py-2 text-sm font-medium rounded-lg text-white transition-colors ${
                  confirmBulk.action === "ACCEPTED" ? "bg-emerald-600 hover:bg-emerald-500" : "bg-red-600 hover:bg-red-500"
                }`}
              >
                Подтвердить
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Apply confirm modal ──────────────────────────────────────────────── */}
      {confirmApply && stats && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm space-y-4">
            <h3 className="text-base font-semibold text-slate-900">Применить изменения?</h3>
            <div className="space-y-2 text-sm">
              {([
                ["Изменены цены", stats.priceChanges],
                ["Новые позиции", stats.newItems],
                ["Удалены позиции", stats.removedItems],
                ["Изменено кол-во", stats.qtyChanges],
              ] as [string, number][]).map(([label, count]) => (
                count > 0 && (
                  <div key={label} className="flex justify-between">
                    <span className="text-slate-600">{label}</span>
                    <span className="font-semibold text-slate-900">{count}</span>
                  </div>
                )
              ))}
            </div>
            <p className="text-xs text-amber-600">Действие нельзя отменить.</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmApply(false)} className="px-4 py-2 text-sm text-slate-500 hover:text-slate-700">
                Отмена
              </button>
              <button
                onClick={handleApply}
                className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors"
              >
                Применить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Users tab (SUPER_ADMIN only) ──────────────────────────────────────────────

type UserRole = "SUPER_ADMIN" | "WAREHOUSE" | "TECHNICIAN";

type AdminUserRow = {
  id: string;
  username: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
};

/** Русское название роли */
function roleLabel(role: UserRole): string {
  switch (role) {
    case "SUPER_ADMIN": return "Руководитель";
    case "WAREHOUSE": return "Кладовщик";
    case "TECHNICIAN": return "Техник";
  }
}

function UsersTab() {
  const [users, setUsers] = useState<AdminUserRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Форма создания
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<UserRole>("WAREHOUSE");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Смена роли
  const [changingRoleId, setChangingRoleId] = useState<string | null>(null);
  const [pendingRole, setPendingRole] = useState<UserRole | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ users: AdminUserRow[] }>("/api/admin-users");
      setUsers(res.users);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка загрузки");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setCreating(true);
    try {
      await apiFetch("/api/admin-users", {
        method: "POST",
        body: JSON.stringify({ username: newUsername.trim(), password: newPassword, role: newRole }),
      });
      setNewUsername("");
      setNewPassword("");
      setNewRole("WAREHOUSE");
      await load();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Ошибка создания");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string, username: string) {
    if (!window.confirm(`Удалить пользователя «${username}»?`)) return;
    try {
      await apiFetch(`/api/admin-users/${id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Ошибка удаления");
    }
  }

  async function handleChangePassword(id: string, username: string) {
    const password = window.prompt(`Новый пароль для «${username}»:`);
    if (!password) return;
    if (password.length < 3) {
      alert("Пароль должен быть не короче 3 символов");
      return;
    }
    try {
      await apiFetch(`/api/admin-users/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ password }),
      });
      alert("Пароль изменён");
    } catch (e) {
      alert(e instanceof Error ? e.message : "Ошибка");
    }
  }

  async function applyRoleChange(id: string, current: UserRole, next: UserRole) {
    if (current === "SUPER_ADMIN" && next !== "SUPER_ADMIN") {
      if (!window.confirm(`Понизить Руководителя до роли «${roleLabel(next)}»? Пользователь потеряет доступ к финансам и управлению пользователями.`)) {
        setChangingRoleId(null);
        setPendingRole(null);
        return;
      }
    }
    try {
      await apiFetch(`/api/admin-users/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ role: next }),
      });
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setChangingRoleId(null);
      setPendingRole(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-ink mb-1">Пользователи CRM</h2>
        <p className="text-xs text-ink-3">
          Только Руководитель видит эту вкладку. Управление доступом к системе.
        </p>
      </div>

      {/* Create form */}
      <form onSubmit={handleCreate} className="bg-slate-50 rounded-lg p-4 border border-slate-200 space-y-3">
        <h3 className="text-sm font-medium text-slate-900">Добавить пользователя</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Логин</label>
            <input
              type="text"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              disabled={creating}
              placeholder="ivan"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Пароль</label>
            <input
              type="text"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={creating}
              placeholder="Минимум 3 символа"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Роль</label>
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as UserRole)}
              disabled={creating}
              className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-accent-bright bg-surface"
            >
              <option value="WAREHOUSE">Кладовщик</option>
              <option value="TECHNICIAN">Техник</option>
              <option value="SUPER_ADMIN">Руководитель</option>
            </select>
          </div>
        </div>
        {createError && (
          <div className="bg-rose-soft border border-rose-border text-rose text-xs rounded px-3 py-2">
            {createError}
          </div>
        )}
        <button
          type="submit"
          disabled={creating || !newUsername || !newPassword}
          className="bg-accent-bright hover:bg-accent text-white font-medium rounded-lg px-4 py-2 text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {creating ? "Создаём..." : "Создать пользователя"}
        </button>
      </form>

      {/* List */}
      <div>
        <h3 className="text-sm font-medium text-ink mb-2">Существующие пользователи</h3>
        {error && (
          <div className="bg-rose-soft border border-rose-border text-rose text-sm rounded-lg px-3 py-2 mb-3">
            {error}
          </div>
        )}
        {loading ? (
          <p className="text-sm text-ink-3">Загрузка…</p>
        ) : users && users.length > 0 ? (
          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-surface-subtle text-xs uppercase tracking-wider text-ink-3">
                <tr>
                  <th className="text-left px-3 py-2">Логин</th>
                  <th className="text-left px-3 py-2">Роль</th>
                  <th className="text-left px-3 py-2">Создан</th>
                  <th className="text-right px-3 py-2">Действия</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {users.map((u) => (
                  <tr key={u.id}>
                    <td className="px-3 py-2 font-medium text-ink">{u.username}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-block text-[10px] uppercase tracking-wider px-2 py-0.5 rounded ${
                          u.role === "SUPER_ADMIN"
                            ? "bg-indigo-soft text-indigo"
                            : u.role === "WAREHOUSE"
                            ? "bg-teal-soft text-teal"
                            : "bg-amber-soft text-amber"
                        }`}
                      >
                        {roleLabel(u.role)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-ink-3">{formatDate(u.createdAt)}</td>
                    <td className="px-3 py-2 text-right space-x-2">
                      <button
                        onClick={() => handleChangePassword(u.id, u.username)}
                        className="text-xs text-ink-2 hover:text-ink underline"
                      >
                        Пароль
                      </button>
                      {/* Dropdown для смены роли */}
                      {changingRoleId === u.id ? (
                        <span className="inline-flex items-center gap-1">
                          <select
                            value={pendingRole ?? u.role}
                            onChange={(e) => setPendingRole(e.target.value as UserRole)}
                            className="text-xs border border-border rounded px-1 py-0.5 bg-surface"
                            autoFocus
                          >
                            <option value="WAREHOUSE">Кладовщик</option>
                            <option value="TECHNICIAN">Техник</option>
                            <option value="SUPER_ADMIN">Руководитель</option>
                          </select>
                          <button
                            onClick={() => applyRoleChange(u.id, u.role, pendingRole ?? u.role)}
                            className="text-xs text-accent hover:underline"
                          >ОК</button>
                          <button
                            onClick={() => { setChangingRoleId(null); setPendingRole(null); }}
                            className="text-xs text-ink-3 hover:underline"
                          >✕</button>
                        </span>
                      ) : (
                        <button
                          onClick={() => { setChangingRoleId(u.id); setPendingRole(u.role); }}
                          className="text-xs text-ink-2 hover:text-ink underline"
                        >
                          Роль
                        </button>
                      )}
                      <button
                        onClick={() => handleDelete(u.id, u.username)}
                        className="text-xs text-rose hover:text-rose/80 underline"
                      >
                        Удалить
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-ink-3">Пользователей пока нет.</p>
        )}
      </div>
    </div>
  );
}

// ── Admin panel (authenticated) ───────────────────────────────────────────────

type AdminTab = "catalog" | "pricelist" | "import" | "slang" | "workers" | "barcodes" | "prices" | "users";

const ALL_TABS: Array<{ id: AdminTab; label: string; superAdminOnly?: boolean }> = [
  { id: "catalog", label: "Каталог техники" },
  { id: "pricelist", label: "Прайслист бота" },
  { id: "import", label: "Импорт оборудования" },
  { id: "slang", label: "Жаргон / Обучение" },
  { id: "workers", label: "Кладовщики" },
  { id: "barcodes", label: "Штрихкоды" },
  { id: "prices", label: "Аналитика цен" },
  { id: "users", label: "Пользователи", superAdminOnly: true },
];

function AdminPanel() {
  const { user } = useCurrentUser();
  const isSuperAdmin = user?.role === "SUPER_ADMIN";
  const tabs = ALL_TABS.filter((t) => !t.superAdminOnly || isSuperAdmin);

  const [tab, setTab] = useState<AdminTab>("catalog");

  // Если пользователь перестал быть супер-админом — переключаем с "users".
  useEffect(() => {
    if (tab === "users" && !isSuperAdmin) setTab("catalog");
  }, [tab, isSuperAdmin]);

  return (
    <div className="p-4 max-w-4xl">
      {/* Page header */}
      <div className="mb-6">
        <p className="eyebrow mb-0.5">Система</p>
        <h1 className="text-[17px] font-semibold tracking-tight text-ink">Администрирование</h1>
        <p className="text-sm text-ink-3 mt-0.5">Системные настройки и управление данными</p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 mb-5 border-b border-border overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 eyebrow border-b-2 -mb-px transition-colors whitespace-nowrap normal-case tracking-normal text-xs ${
              tab === t.id
                ? "border-accent-bright text-accent"
                : "border-transparent text-ink-3 hover:text-ink-2"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="bg-surface rounded-lg border border-border p-6 shadow-xs">
        {tab === "catalog" && <CatalogTab />}
        {tab === "pricelist" && <PricelistTab />}
        {tab === "import" && <ImportTab />}
        {tab === "slang" && <SlangLearningTab />}
        {tab === "workers" && <WorkersTab />}
        {tab === "barcodes" && <BarcodesTab />}
        {tab === "prices" && <PricesTab />}
        {tab === "users" && isSuperAdmin && <UsersTab />}
      </div>
    </div>
  );
}

// ── Entry point ───────────────────────────────────────────────────────────────
// Доступ защищён middleware.ts + сессией пользователя (SUPER_ADMIN).
// Выход — через кнопку «Выйти» в сайдбаре.

export default function AdminPage() {
  return <AdminPanel />;
}
