"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import Link from "next/link";
import { apiFetch } from "../../src/lib/api";

// ── Auth ──────────────────────────────────────────────────────────────────────

const ADMIN_SESSION_KEY = "admin_auth";
const ADMIN_PASSWORD = "4020909Bear";

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

// ── Login screen ──────────────────────────────────────────────────────────────

function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [pwd, setPwd] = useState("");
  const [error, setError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pwd === ADMIN_PASSWORD) {
      sessionStorage.setItem(ADMIN_SESSION_KEY, "1");
      onSuccess();
    } else {
      setError(true);
      setPwd("");
      setTimeout(() => setError(false), 2000);
    }
  }

  return (
    <div className="flex items-center justify-center py-20 px-4">
      <div className="w-full max-w-sm">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          {/* Header band */}
          <div className="bg-slate-900 px-8 py-7 flex flex-col items-center">
            <div className="w-12 h-12 rounded-xl bg-white/10 flex items-center justify-center mb-4">
              <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75}
                  d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
            </div>
            <h1 className="text-lg font-semibold text-white">Admin Panel</h1>
            <p className="text-sm text-slate-400 mt-1">Введите пароль для доступа</p>
          </div>

          <form onSubmit={handleSubmit} className="px-8 py-7 space-y-4">
            <input
              ref={inputRef}
              type="password"
              value={pwd}
              onChange={(e) => {
                setPwd(e.target.value);
                setError(false);
              }}
              placeholder="Пароль"
              autoComplete="current-password"
              className={`w-full px-4 py-3 rounded-xl border text-sm outline-none transition-colors ${
                error
                  ? "border-red-300 bg-red-50 text-red-700 placeholder-red-300"
                  : "border-slate-300 bg-white text-slate-800 placeholder-slate-400 focus:border-slate-500"
              }`}
            />
            {error && (
              <p className="text-xs text-red-600 text-center -mt-2">Неверный пароль</p>
            )}
            <button
              type="submit"
              className="w-full bg-slate-900 hover:bg-slate-700 text-white font-medium text-sm py-3 rounded-xl transition-colors"
            >
              Войти
            </button>
          </form>
        </div>
      </div>
    </div>
  );
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
        const res = await apiFetch<{ equipment: any[] }>("/api/equipment");
        const cats = [...new Set(res.equipment.map((e: any) => e.category))].filter(Boolean).sort();
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
  }, [page, debouncedSearch, statusFilter, categoryFilter, hasBarcodeFilter]);

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
      // Refresh
      setPage(p => p);
      // Trigger re-fetch by toggling a dummy
      setDebouncedSearch(prev => prev + " ");
      setTimeout(() => setDebouncedSearch(prev => prev.trim()), 50);
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

// ── Admin panel (authenticated) ───────────────────────────────────────────────

type AdminTab = "catalog" | "pricelist" | "import" | "slang" | "workers" | "barcodes";

const TABS: Array<{ id: AdminTab; label: string }> = [
  { id: "catalog", label: "Каталог техники" },
  { id: "pricelist", label: "Прайслист бота" },
  { id: "import", label: "Импорт оборудования" },
  { id: "slang", label: "Жаргон / Обучение" },
  { id: "workers", label: "Кладовщики" },
  { id: "barcodes", label: "Штрихкоды" },
];

function AdminPanel({ onLogout }: { onLogout: () => void }) {
  const [tab, setTab] = useState<AdminTab>("catalog");

  return (
    <div className="p-4 max-w-4xl">
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Admin Panel</h1>
          <p className="text-sm text-slate-500 mt-0.5">Системные настройки и управление данными</p>
        </div>
        <button
          onClick={onLogout}
          className="text-xs text-slate-400 hover:text-slate-700 transition-colors border border-slate-200 rounded-lg px-3 py-1.5 hover:bg-slate-50"
        >
          Выйти
        </button>
      </div>

      {/* Divider with label */}
      <div className="flex items-center gap-3 mb-5">
        <div className="h-px flex-1 bg-slate-200" />
        <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">
          Admin Panel sections
        </span>
        <div className="h-px flex-1 bg-slate-200" />
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 mb-6 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.id
                ? "border-slate-900 text-slate-900"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">
        {tab === "catalog" && <CatalogTab />}
        {tab === "pricelist" && <PricelistTab />}
        {tab === "import" && <ImportTab />}
        {tab === "slang" && <SlangLearningTab />}
        {tab === "workers" && <WorkersTab />}
        {tab === "barcodes" && <BarcodesTab />}
      </div>
    </div>
  );
}

// ── Entry point ───────────────────────────────────────────────────────────────

export default function AdminPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    setAuthed(sessionStorage.getItem(ADMIN_SESSION_KEY) === "1");
  }, []);

  if (authed === null) return null;

  if (!authed) {
    return <LoginScreen onSuccess={() => setAuthed(true)} />;
  }

  return (
    <AdminPanel
      onLogout={() => {
        sessionStorage.removeItem(ADMIN_SESSION_KEY);
        setAuthed(false);
      }}
    />
  );
}
