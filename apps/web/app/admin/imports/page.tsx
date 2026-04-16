"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useRequireRole } from "@/hooks/useRequireRole";
import { AdminTabNav } from "@/components/admin/AdminTabNav";

// ── Types ─────────────────────────────────────────────────────────────────────

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

type MapStats = { priceChanges: number; newItems: number; removedItems: number; qtyChanges: number; noChange: number };
type UploadPreview = { session: ImportSession; preview: { headers: string[]; sampleRows: Record<string, unknown>[]; suggestedMapping: Record<string, string> } };
type WizardStep = "list" | "mapping" | "review";
type PricesFilter = "changed" | "all" | "price" | "new" | "removed" | "qty" | "unmatched";

// ── Constants ─────────────────────────────────────────────────────────────────

const PRICE_MAPPING_FIELDS = [
  { key: "name",                label: "Наименование",  required: true  },
  { key: "category",            label: "Категория",      required: false },
  { key: "brand",               label: "Бренд",          required: false },
  { key: "model",               label: "Модель",         required: false },
  { key: "quantity",            label: "Количество",     required: false },
  { key: "rentalRatePerShift",  label: "Цена (смена)",   required: true  },
  { key: "rentalRateTwoShifts", label: "Цена (2 смены)", required: false },
  { key: "rentalRatePerProject",label: "Цена (проект)",  required: false },
] as const;

type PriceMappingKey = (typeof PRICE_MAPPING_FIELDS)[number]["key"];
type PriceMappingState = Partial<Record<PriceMappingKey, string>>;

const FILTER_OPTIONS: { id: PricesFilter; label: string; actionFilter?: string; queryParam?: string }[] = [
  { id: "changed",   label: "Все изменения", queryParam:    "changed"       },
  { id: "all",       label: "Все"                                            },
  { id: "price",     label: "Цены",          actionFilter:  "PRICE_CHANGE"  },
  { id: "new",       label: "Новых",         actionFilter:  "NEW_ITEM"      },
  { id: "removed",   label: "Пропали",       actionFilter:  "REMOVED_ITEM"  },
  { id: "qty",       label: "Кол-во",        actionFilter:  "QTY_CHANGE"    },
  { id: "unmatched", label: "Не найдено",    queryParam:    "unmatched"     },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function actionPill(action: string) {
  const labels: Record<string, string> = { PRICE_CHANGE: "CHG", NEW_ITEM: "NEW", REMOVED_ITEM: "DEL", QTY_CHANGE: "QTY", NO_CHANGE: "=" };
  const cls: Record<string, string> = {
    PRICE_CHANGE: "bg-amber-soft text-amber border border-amber-border",
    NEW_ITEM:     "bg-emerald-soft text-emerald border border-emerald-border",
    REMOVED_ITEM: "bg-rose-soft text-rose border border-rose-border",
    QTY_CHANGE:   "bg-accent-soft text-accent border border-accent-border",
  };
  return { label: labels[action] ?? action, cls: cls[action] ?? "bg-surface-2 text-ink-3 border border-border" };
}

function rowBgClass(row: ImportSessionRow) {
  if (row.action === "REMOVED_ITEM") return "bg-rose-soft";
  if (row.action === "NEW_ITEM") return "bg-emerald-soft";
  const d = row.priceDelta ? parseFloat(row.priceDelta) : null;
  if (d !== null) { if (d > 5) return "bg-rose-soft"; if (d < -5) return "bg-emerald-soft"; return "bg-amber-soft"; }
  return "";
}

// ── Wizard Step Indicator ─────────────────────────────────────────────────────

function WizardStepIndicator({ current }: { current: WizardStep }) {
  const steps = [
    { id: "list" as WizardStep,    label: "Загрузка"              },
    { id: "mapping" as WizardStep, label: "Сопоставление колонок" },
    { id: "review" as WizardStep,  label: "Проверка изменений"    },
    { id: "apply" as const,        label: "Применить"             },
  ];
  const order: string[] = ["list", "mapping", "review", "apply"];
  const currentIdx = order.indexOf(current);

  return (
    <div className="flex items-center gap-1.5 p-2.5 px-3.5 bg-surface-2 border border-border rounded-lg">
      {steps.map((step, idx) => {
        const stepIdx = order.indexOf(step.id);
        const isDone   = stepIdx < currentIdx;
        const isActive = stepIdx === currentIdx;
        return (
          <div key={step.id} className="flex items-center gap-1">
            {idx > 0 && <span className="text-border px-1">—</span>}
            <div className={`flex items-center gap-2 px-2.5 py-1 rounded text-xs${isActive ? " bg-surface shadow-xs" : ""}`}>
              <span className={`w-5 h-5 rounded-full flex items-center justify-center mono-num text-[11px] font-semibold ${isDone ? "bg-teal-soft text-teal" : isActive ? "bg-ink text-white" : "bg-border text-ink-2"}`}>
                {isDone ? "✓" : idx + 1}
              </span>
              <span className={isDone ? "text-teal" : isActive ? "text-ink" : "text-ink-3"}>{step.label}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Diff Stats Cards ──────────────────────────────────────────────────────────

function DiffStatsCards({ stats, total }: { stats: MapStats; total: number }) {
  const cards = [
    { label: "Всего строк",     value: total,              valueCls: "text-ink",   cardCls: "border-border"                               },
    { label: "Новых",           value: stats.newItems,     valueCls: "text-emerald", cardCls: "border-emerald-border bg-emerald-soft"     },
    { label: "Изменены цены",   value: stats.priceChanges, valueCls: "text-amber",  cardCls: "border-amber-border bg-amber-soft"          },
    { label: "Пропали",         value: stats.removedItems, valueCls: "text-rose",   cardCls: "border-rose-border bg-rose-soft"            },
    { label: "Без изменений",   value: stats.noChange,     valueCls: "text-ink-2",  cardCls: "border-border bg-surface-2"                 },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
      {cards.map(({ label, value, valueCls, cardCls }) => (
        <div key={label} className={`p-3 border rounded-lg ${cardCls}`}>
          <div className="eyebrow text-ink-3 mb-1">{label}</div>
          <div className={`mono-num text-xl font-medium ${valueCls}`}>{value}</div>
        </div>
      ))}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ImportsPage() {
  useRequireRole(["SUPER_ADMIN"]);

  const [wizardStep, setWizardStep]     = useState<WizardStep>("list");
  const [sessions,   setSessions]       = useState<ImportSession[]>([]);
  const [activeSession, setActiveSession] = useState<ImportSession | null>(null);
  const [preview,    setPreview]        = useState<UploadPreview["preview"] | null>(null);
  const [mappingConfig, setMappingConfig] = useState<PriceMappingState>({});
  const [importType, setImportType]     = useState<"OWN_PRICE_UPDATE" | "COMPETITOR_IMPORT">("OWN_PRICE_UPDATE");
  const [competitorName, setCompetitorName] = useState("");
  const [rows,       setRows]           = useState<ImportSessionRow[]>([]);
  const [rowsTotal,  setRowsTotal]      = useState(0);
  const [rowsPage,   setRowsPage]       = useState(1);
  const [rowsTotalPages, setRowsTotalPages] = useState(1);
  const [filter,     setFilter]         = useState<PricesFilter>("changed");
  const [searchQuery, setSearchQuery]   = useState("");
  const [stats,      setStats]          = useState<MapStats | null>(null);
  const [uploading,  setUploading]      = useState(false);
  const [mappingBusy, setMappingBusy]  = useState(false);
  const [applying,   setApplying]       = useState(false);
  const [loadingRows, setLoadingRows]   = useState(false);
  const [confirmBulk, setConfirmBulk]  = useState<{ action: "ACCEPTED" | "REJECTED"; count: number } | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);
  const [applyResult, setApplyResult]  = useState<{ applied: Record<string, number>; skipped: { id: string; reason: string }[] } | null>(null);
  const [message,    setMessage]        = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const dropRef = useRef<HTMLInputElement>(null);

  // ── API helpers ─────────────────────────────────────────────────────────────

  async function loadSessions() {
    try { const d = await apiFetch<{ sessions: ImportSession[] }>("/api/import-sessions"); return d.sessions ?? []; }
    catch { return []; }
  }

  useEffect(() => {
    let cancelled = false;
    loadSessions().then((s) => { if (!cancelled) setSessions(s); });
    return () => { cancelled = true; };
  }, []);

  async function loadRows(sessionId: string, f: PricesFilter, page: number) {
    setLoadingRows(true);
    try {
      const opt = FILTER_OPTIONS.find((x) => x.id === f);
      const p = new URLSearchParams({ page: String(page), limit: "50" });
      if (opt?.actionFilter) p.set("action", opt.actionFilter);
      if (opt?.queryParam)   p.set(opt.queryParam, "true");
      const d = await apiFetch<{ rows: ImportSessionRow[]; total: number; totalPages: number }>(
        `/api/import-sessions/${sessionId}/rows?${p}`
      );
      setRows(d.rows ?? []); setRowsTotal(d.total ?? 0); setRowsTotalPages(d.totalPages ?? 1); setRowsPage(page);
    } catch { setRows([]); } finally { setLoadingRows(false); }
  }

  async function handleUpload(file: File) {
    setUploading(true); setMessage(null);
    try {
      const form = new FormData(); form.append("file", file);
      const res = await apiFetch<UploadPreview>("/api/import-sessions/upload", { method: "POST", body: form });
      setActiveSession(res.session); setPreview(res.preview);
      const next: PriceMappingState = {};
      for (const k of Object.keys(res.preview?.suggestedMapping ?? {})) next[k as PriceMappingKey] = res.preview.suggestedMapping[k];
      setMappingConfig(next); setWizardStep("mapping");
    } catch (e) { setMessage({ type: "err", text: e instanceof Error ? e.message : "Ошибка загрузки файла" }); }
    finally { setUploading(false); }
  }

  async function handleMap() {
    if (!activeSession) return;
    setMappingBusy(true); setMessage(null);
    try {
      const colMap: Record<string, string> = {};
      for (const k of Object.keys(mappingConfig)) { const v = mappingConfig[k as PriceMappingKey]; if (v) colMap[k] = v; }
      const res = await apiFetch<{ session: ImportSession; stats: MapStats }>(
        `/api/import-sessions/${activeSession.id}/map`,
        { method: "POST", body: JSON.stringify({ type: importType, competitorName: importType === "COMPETITOR_IMPORT" ? competitorName || undefined : undefined, mapping: colMap }) }
      );
      setActiveSession(res.session); setStats(res.stats); setWizardStep("review"); loadRows(res.session.id, "changed", 1);
    } catch (e) { setMessage({ type: "err", text: e instanceof Error ? e.message : "Ошибка анализа" }); }
    finally { setMappingBusy(false); }
  }

  async function handleOpenSession(session: ImportSession) {
    setActiveSession(session);
    try {
      const counts: MapStats = { priceChanges: 0, newItems: 0, removedItems: 0, qtyChanges: 0, noChange: 0 };
      await Promise.all([
        apiFetch<{ total: number }>(`/api/import-sessions/${session.id}/rows?action=PRICE_CHANGE&limit=1`).then(r => { counts.priceChanges = r.total; }),
        apiFetch<{ total: number }>(`/api/import-sessions/${session.id}/rows?action=NEW_ITEM&limit=1`).then(r => { counts.newItems = r.total; }),
        apiFetch<{ total: number }>(`/api/import-sessions/${session.id}/rows?action=REMOVED_ITEM&limit=1`).then(r => { counts.removedItems = r.total; }),
        apiFetch<{ total: number }>(`/api/import-sessions/${session.id}/rows?action=QTY_CHANGE&limit=1`).then(r => { counts.qtyChanges = r.total; }),
        apiFetch<{ total: number }>(`/api/import-sessions/${session.id}/rows?action=NO_CHANGE&limit=1`).then(r => { counts.noChange = r.total; }),
      ]);
      setStats(counts);
    } catch { /* non-critical */ }
    setWizardStep("review"); loadRows(session.id, "changed", 1);
  }

  async function handleRowToggle(row: ImportSessionRow) {
    if (!activeSession) return;
    const next = row.status === "ACCEPTED" ? "REJECTED" : "ACCEPTED";
    try {
      await apiFetch(`/api/import-sessions/${activeSession.id}/rows/${row.id}`, { method: "PATCH", body: JSON.stringify({ status: next }) });
      setRows(prev => prev.map(r => r.id === row.id ? { ...r, status: next } : r));
    } catch (e) { setMessage({ type: "err", text: e instanceof Error ? e.message : "Ошибка обновления строки" }); }
  }

  async function handleBulkAction(action: "ACCEPTED" | "REJECTED") {
    if (!activeSession) return;
    setConfirmBulk(null);
    try {
      const opt = FILTER_OPTIONS.find(x => x.id === filter);
      await apiFetch(`/api/import-sessions/${activeSession.id}/bulk-action`, {
        method: "POST", body: JSON.stringify({ action, filter: opt?.actionFilter ? { action: opt.actionFilter } : {} })
      });
      loadRows(activeSession.id, filter, rowsPage);
      setMessage({ type: "ok", text: action === "ACCEPTED" ? "Все позиции приняты" : "Все позиции отклонены" });
    } catch (e) { setMessage({ type: "err", text: e instanceof Error ? e.message : "Ошибка массового действия" }); }
  }

  async function handleApply() {
    if (!activeSession) return;
    setApplying(true); setConfirmApply(false); setMessage(null);
    try {
      const res = await apiFetch<{ applied: Record<string, number>; skipped: { id: string; reason: string }[] }>(
        `/api/import-sessions/${activeSession.id}/apply`, { method: "POST" }
      );
      setApplyResult(res); setMessage({ type: "ok", text: "Изменения применены" }); loadSessions();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Ошибка применения";
      setMessage({ type: "err", text: msg.includes("409") || msg.toLowerCase().includes("применяются") ? "Изменения уже применяются, подождите" : msg });
    } finally { setApplying(false); }
  }

  async function handleExport(sessionId: string) {
    try {
      const res = await window.fetch(`/api/import-sessions/${sessionId}/export`, { credentials: "same-origin" });
      if (!res.ok) throw new Error("Ошибка экспорта");
      const blob = await res.blob(); const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `import-session-${sessionId}.xlsx`; a.click(); URL.revokeObjectURL(url);
    } catch (e) { setMessage({ type: "err", text: e instanceof Error ? e.message : "Ошибка экспорта" }); }
  }

  async function handleDeleteSession(sessionId: string) {
    if (!confirm("Удалить сессию импорта?")) return;
    try {
      await apiFetch(`/api/import-sessions/${sessionId}`, { method: "DELETE" });
      if (activeSession?.id === sessionId) { setActiveSession(null); setWizardStep("list"); setRows([]); setApplyResult(null); }
      loadSessions();
    } catch (e) { setMessage({ type: "err", text: e instanceof Error ? e.message : "Ошибка удаления" }); }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) handleUpload(f);
  }

  const isOwnMode = (activeSession?.type ?? importType) === "OWN_PRICE_UPDATE";
  const acceptedCount = activeSession?.acceptedCount ?? rows.filter(r => r.status === "ACCEPTED").length;
  const filteredRows = searchQuery.trim()
    ? rows.filter(r => r.sourceName.toLowerCase().includes(searchQuery.toLowerCase()))
    : rows;
  const totalChanged = stats ? stats.priceChanges + stats.newItems + stats.removedItems + stats.qtyChanges : 0;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-surface">
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-5">
        <AdminTabNav />

        {/* Page header */}
        <div>
          <h1 className="text-lg font-semibold text-ink">
            Импорт прайса{activeSession && <span className="text-ink-2 font-normal"> · {activeSession.fileName}</span>}
          </h1>
          <p className="text-sm text-ink-3 mt-0.5">Загрузите прайс-лист для обновления цен или сравнения с конкурентом</p>
        </div>

        {wizardStep !== "list" && <WizardStepIndicator current={wizardStep} />}

        {/* Message banner */}
        {message && (
          <div className={`px-4 py-3 rounded-lg text-sm font-medium flex items-center justify-between ${message.type === "ok" ? "bg-emerald-soft text-emerald border border-emerald-border" : "bg-rose-soft text-rose border border-rose-border"}`}>
            <span>{message.text}</span>
            <button onClick={() => setMessage(null)} aria-label="Закрыть сообщение" className="ml-3 text-xs opacity-60 hover:opacity-100">✕</button>
          </div>
        )}

        {/* ── Session list ───────────────────────────────────────────────────── */}
        {wizardStep === "list" && (
          <div className="space-y-5">
            {/* Upload dropzone */}
            <div
              className="rounded-xl border-2 border-dashed border-border bg-surface hover:bg-surface-2 transition-colors cursor-pointer"
              onDrop={handleDrop} onDragOver={e => e.preventDefault()} onClick={() => dropRef.current?.click()}
            >
              <div className="flex flex-col items-center py-10 px-6 text-center">
                <svg className="w-10 h-10 text-ink-3 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
                <p className="text-sm font-medium text-ink-2">{uploading ? "Загрузка…" : "Перетащите файл или нажмите для выбора"}</p>
                <p className="text-xs text-ink-3 mt-1">Поддерживаются .xlsx, .xls</p>
              </div>
              <input ref={dropRef} type="file" className="hidden" accept=".xlsx,.xls" disabled={uploading}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); }} />
            </div>

            {/* Past sessions list */}
            {sessions.length > 0 && (
              <div className="rounded-xl border border-border overflow-hidden">
                <div className="px-4 py-2.5 bg-surface-2 border-b border-border">
                  <span className="eyebrow text-ink-3">Прошлые сессии</span>
                </div>
                <div className="divide-y divide-border">
                  {sessions.map(s => (
                    <div key={s.id} className="flex items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-ink truncate">{s.fileName}</div>
                        <div className="text-xs text-ink-3 mt-0.5">
                          {formatDate(s.createdAt)} · {s.type === "COMPETITOR_IMPORT" ? `Конкурент: ${s.competitorName ?? "—"}` : "Обновление прайса"} · <span className={s.status === "COMPLETED" ? "text-emerald" : "text-amber"}>{s.status}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button onClick={() => handleOpenSession(s)} className="px-3 py-1.5 text-xs font-medium text-accent bg-accent-soft border border-accent-border rounded-lg hover:bg-accent hover:text-white transition-colors">Открыть</button>
                        <button onClick={() => handleExport(s.id)} className="px-3 py-1.5 text-xs font-medium text-ink-2 bg-surface border border-border rounded-lg hover:bg-surface-2 transition-colors">XLSX</button>
                        <button onClick={() => handleDeleteSession(s.id)} className="px-3 py-1.5 text-xs font-medium text-rose bg-rose-soft border border-rose-border rounded-lg hover:opacity-80 transition-colors">Удалить</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Mapping step ───────────────────────────────────────────────────── */}
        {wizardStep === "mapping" && preview && (
          <div className="space-y-5">
            {/* Import type selector */}
            <div className="rounded-xl border border-border bg-surface overflow-hidden">
              <div className="px-4 py-3 bg-surface-2 border-b border-border">
                <span className="eyebrow text-ink-3">Шаг 1 — Тип импорта</span>
              </div>
              <div className="p-4 space-y-3">
                <div className="flex gap-3">
                  {(["OWN_PRICE_UPDATE", "COMPETITOR_IMPORT"] as const).map(t => (
                    <button key={t} onClick={() => setImportType(t)}
                      className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${importType === t ? "bg-accent text-white border-accent" : "bg-surface text-ink-2 border-border hover:border-accent"}`}>
                      {t === "OWN_PRICE_UPDATE" ? "Обновление прайса" : "Сравнение с конкурентом"}
                    </button>
                  ))}
                </div>
                {importType === "COMPETITOR_IMPORT" && (
                  <div>
                    <label className="text-xs text-ink-2 mb-1 block">Название конкурента</label>
                    <input type="text" value={competitorName} onChange={e => setCompetitorName(e.target.value)} placeholder="Например: РентаЛайт"
                      className="w-full max-w-xs px-3 py-2 text-sm rounded-lg border border-border focus:outline-none focus:border-accent" />
                  </div>
                )}
              </div>
            </div>

            {/* Column mapping */}
            <div className="rounded-xl border border-border bg-surface overflow-hidden">
              <div className="px-4 py-3 bg-surface-2 border-b border-border">
                <span className="eyebrow text-ink-3">Шаг 2 — Сопоставление колонок</span>
              </div>
              <div className="p-4 grid grid-cols-1 lg:grid-cols-12 gap-6">
                <div className="lg:col-span-6 space-y-2">
                  {PRICE_MAPPING_FIELDS.map(f => (
                    <div key={f.key} className="flex items-center gap-3">
                      <div className="w-44 text-xs text-ink-2 shrink-0">{f.label}{f.required && <span className="text-rose ml-0.5">*</span>}</div>
                      <select className="flex-1 rounded-lg border border-border px-3 py-1.5 text-sm bg-surface"
                        value={mappingConfig[f.key] ?? ""}
                        onChange={e => setMappingConfig(prev => ({ ...prev, [f.key]: e.target.value || undefined }))}>
                        <option value="">(не используется)</option>
                        {preview.headers.map(h => <option value={h} key={h}>{h}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
                <div className="lg:col-span-6">
                  <div className="rounded-lg border border-border bg-surface overflow-hidden">
                    <div className="px-3 py-2 border-b border-border"><span className="eyebrow text-ink-3">Предпросмотр</span></div>
                    <div className="overflow-auto max-h-48">
                      <table className="min-w-[400px] w-full text-xs">
                        <thead className="bg-surface-2">
                          <tr>{preview.headers.slice(0, 6).map(h => <th key={h} className="text-left px-3 py-2 border-b border-border font-medium text-ink-2">{h}</th>)}</tr>
                        </thead>
                        <tbody>
                          {preview.sampleRows.slice(0, 5).map((row, idx) => (
                            <tr key={idx} className="border-t border-border">
                              {preview.headers.slice(0, 6).map(h => <td key={h} className="px-3 py-1.5 text-ink-2">{String(row[h] ?? "")}</td>)}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button onClick={handleMap} disabled={mappingBusy || !mappingConfig.name || !mappingConfig.rentalRatePerShift}
                className="px-6 py-3 rounded-xl text-sm font-medium bg-accent text-white hover:bg-accent-bright disabled:opacity-50 transition-colors">
                {mappingBusy ? "Анализ…" : "Начать анализ"}
              </button>
              <button onClick={() => { setWizardStep("list"); setActiveSession(null); loadSessions(); }}
                className="px-4 py-2 text-sm text-ink-2 border border-border rounded-xl hover:bg-surface-2 transition-colors">
                Отмена
              </button>
            </div>
          </div>
        )}

        {/* ── Review step ────────────────────────────────────────────────────── */}
        {wizardStep === "review" && activeSession && (
          <div className="space-y-4">
            {/* Session header */}
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-sm font-medium text-ink">{activeSession.fileName}</span>
              <span className="text-xs text-ink-3">{activeSession.type === "COMPETITOR_IMPORT" ? `Конкурент: ${activeSession.competitorName ?? "—"}` : "Обновление прайса"}</span>
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${activeSession.status === "COMPLETED" ? "bg-emerald-soft text-emerald border-emerald-border" : "bg-amber-soft text-amber border-amber-border"}`}>
                {activeSession.status}
              </span>
              <button onClick={() => { setWizardStep("list"); setActiveSession(null); setRows([]); setApplyResult(null); loadSessions(); }}
                className="ml-auto text-xs text-ink-3 hover:text-ink-2 border border-border rounded-lg px-3 py-1.5 hover:bg-surface-2 transition-colors">
                ← Назад
              </button>
            </div>

            {/* Diff stats cards */}
            {stats && <DiffStatsCards stats={stats} total={activeSession.totalRows} />}

            {/* Apply result */}
            {applyResult && (
              <div className="rounded-xl border border-emerald-border bg-emerald-soft p-4 text-sm space-y-1">
                <div className="font-semibold text-emerald mb-2">Изменения применены</div>
                {Object.entries(applyResult.applied).map(([k, v]) => <div key={k} className="flex justify-between text-emerald"><span>{k}</span><span className="font-semibold">{v}</span></div>)}
                {applyResult.skipped.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-emerald-border">
                    <div className="text-amber font-medium">Пропущено {applyResult.skipped.length} позиц.</div>
                    {applyResult.skipped.map(s => <div key={s.id} className="text-xs text-amber mt-0.5">{s.reason}</div>)}
                  </div>
                )}
              </div>
            )}

            {/* Filter toolbar */}
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex gap-1 flex-wrap">
                {FILTER_OPTIONS.map(opt => {
                  const count = opt.id === "changed" ? totalChanged : opt.id === "new" ? (stats?.newItems ?? null) : opt.id === "price" ? (stats?.priceChanges ?? null) : opt.id === "removed" ? (stats?.removedItems ?? null) : null;
                  return (
                    <button key={opt.id}
                      onClick={() => { setFilter(opt.id); if (activeSession) loadRows(activeSession.id, opt.id, 1); }}
                      className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${filter === opt.id ? "bg-ink text-white border-ink" : "bg-surface text-ink-2 border-border hover:border-ink"}`}>
                      {opt.label}{count !== null ? ` (${count})` : ""}
                    </button>
                  );
                })}
              </div>
              <div className="relative ml-auto">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3 text-sm select-none">⌕</span>
                <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Поиск"
                  className="pl-7 pr-3 py-1.5 text-xs rounded-lg border border-border bg-surface focus:outline-none focus:border-accent w-44" />
              </div>
            </div>

            {/* Bulk actions */}
            {isOwnMode && activeSession.status !== "COMPLETED" && (
              <div className="flex items-center gap-2">
                <button onClick={() => setConfirmBulk({ action: "ACCEPTED", count: rowsTotal })} className="px-3 py-1.5 text-xs font-medium text-emerald bg-emerald-soft border border-emerald-border rounded-lg hover:opacity-80 transition-colors">Принять все</button>
                <button onClick={() => setConfirmBulk({ action: "REJECTED", count: rowsTotal })} className="px-3 py-1.5 text-xs font-medium text-rose bg-rose-soft border border-rose-border rounded-lg hover:opacity-80 transition-colors">Отклонить все</button>
                <span className="text-xs text-ink-3">в текущем фильтре</span>
              </div>
            )}

            {/* Diff table */}
            <div className="rounded-xl border border-border overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-surface-2 border-b border-border">
                      <th className="w-10 px-3 py-2.5"></th>
                      <th className="text-left px-3 py-2.5 font-semibold text-ink-2">Позиция</th>
                      {isOwnMode ? (
                        <>
                          <th className="text-right px-3 py-2.5 font-semibold text-ink-2">Текущая цена</th>
                          <th className="text-right px-3 py-2.5 font-semibold text-ink-2">Новая цена</th>
                          <th className="text-left px-3 py-2.5 font-semibold text-ink-2">Действие</th>
                          {activeSession.status !== "COMPLETED" && <th className="w-8 px-3 py-2.5"></th>}
                        </>
                      ) : (
                        <>
                          <th className="text-right px-3 py-2.5 font-semibold text-ink-2">Наша цена</th>
                          <th className="text-right px-3 py-2.5 font-semibold text-ink-2">Конкурент</th>
                          <th className="text-right px-3 py-2.5 font-semibold text-ink-2">Δ%</th>
                          <th className="text-left px-3 py-2.5 font-semibold text-ink-2">Уверенность</th>
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {loadingRows ? (
                      <tr><td colSpan={6} className="py-8 text-center text-ink-3">Загрузка…</td></tr>
                    ) : filteredRows.length === 0 ? (
                      <tr><td colSpan={6} className="py-8 text-center text-ink-3">Нет позиций</td></tr>
                    ) : filteredRows.map(row => {
                      const { label, cls } = actionPill(row.action);
                      const delta = row.priceDelta ? parseFloat(row.priceDelta) : null;
                      const blockedRemoved = row.action === "REMOVED_ITEM" && row.hasActiveBookings;
                      return (
                        <tr key={row.id} className={rowBgClass(row)}>
                          {/* Status pill */}
                          <td className="px-3 py-2.5 text-center">
                            <span className={`inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded ${cls}`}>{label}</span>
                          </td>
                          {/* Name + alias */}
                          <td className="px-3 py-2.5 max-w-[220px]">
                            <div className="truncate font-medium text-ink">{row.sourceName}</div>
                            {row.equipment && <div className="text-ink-3 truncate text-[10px] mt-0.5">{row.equipment.name}</div>}
                            {!row.equipmentId && <span className="inline-block text-[10px] font-medium bg-surface-2 text-ink-3 border border-border rounded px-1.5 py-0.5 mt-0.5">Не найдено</span>}
                            {row.matchMethod?.includes(":FLAGGED") && <span className="inline-block text-[10px] bg-amber-soft text-amber rounded px-1.5 py-0.5 mt-0.5">⚠ Подозрительное значение</span>}
                          </td>
                          {isOwnMode ? (
                            <>
                              {/* Old price */}
                              <td className="px-3 py-2.5 text-right">
                                {row.oldPrice ? <span className={row.action === "PRICE_CHANGE" ? "line-through text-ink-3" : "text-ink-2"}>{row.oldPrice}</span> : <span className="text-ink-3">—</span>}
                              </td>
                              {/* New price + % */}
                              <td className="px-3 py-2.5 text-right font-medium">
                                {row.sourcePrice ? (
                                  <span className={delta !== null && delta > 0 ? "text-emerald" : delta !== null && delta < 0 ? "text-rose" : "text-ink"}>
                                    {row.sourcePrice}
                                    {delta !== null && Math.abs(delta) >= 0.1 && <span className="ml-1 text-[10px] font-normal">{delta > 0 ? `+${delta.toFixed(0)}%` : `${delta.toFixed(0)}%`}</span>}
                                  </span>
                                ) : <span className="text-ink-3">—</span>}
                              </td>
                              {/* Action verb */}
                              <td className="px-3 py-2.5">
                                {activeSession.status !== "COMPLETED" ? (
                                  blockedRemoved ? (
                                    <span title="Нельзя удалить (активные брони)" className="text-[10px] text-ink-3 cursor-not-allowed px-2 py-1 rounded border border-border">Заблокировано</span>
                                  ) : (
                                    <button onClick={() => handleRowToggle(row)}
                                      className={`text-[10px] font-medium px-2 py-0.5 rounded border transition-colors ${row.status === "ACCEPTED" ? "bg-emerald-soft text-emerald border-emerald-border" : "bg-surface text-ink-2 border-border hover:border-emerald"}`}>
                                      {row.status === "ACCEPTED" ? "Принято ✓" : label === "NEW" ? "Добавить" : label === "DEL" ? "Скрыть" : "Обновить"}
                                    </button>
                                  )
                                ) : <span className="text-[10px] text-ink-3">{label === "NEW" ? "Добавить" : label === "DEL" ? "Скрыть" : "Обновить"}</span>}
                              </td>
                              {activeSession.status !== "COMPLETED" && (
                                <td className="px-3 py-2.5 text-center">
                                  {!blockedRemoved && <button onClick={() => handleRowToggle(row)} aria-label="Переключить статус строки" className="text-ink-3 hover:text-ink transition-colors text-base leading-none">⋯</button>}
                                </td>
                              )}
                            </>
                          ) : (
                            <>
                              <td className="px-3 py-2.5 text-right text-ink-2">{row.oldPrice ?? "—"}</td>
                              <td className="px-3 py-2.5 text-right font-medium text-ink">{row.sourcePrice ?? "—"}</td>
                              <td className={`px-3 py-2.5 text-right font-medium ${delta !== null ? (delta > 5 ? "text-rose" : delta < -5 ? "text-emerald" : "text-amber") : "text-ink-3"}`}>
                                {delta !== null ? `${delta > 0 ? "+" : ""}${delta.toFixed(1)}%` : "—"}
                              </td>
                              <td className="px-3 py-2.5">
                                {row.matchConfidence && (
                                  <span className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded ${parseFloat(row.matchConfidence) >= 0.8 ? "bg-emerald-soft text-emerald" : parseFloat(row.matchConfidence) >= 0.5 ? "bg-amber-soft text-amber" : "bg-rose-soft text-rose"}`}>
                                    {Math.round(parseFloat(row.matchConfidence) * 100)}%
                                  </span>
                                )}
                              </td>
                            </>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {rowsTotalPages > 1 && (
                <div className="flex items-center justify-between px-4 py-3 border-t border-border bg-surface">
                  <span className="text-xs text-ink-3">Страница {rowsPage} из {rowsTotalPages} · {rowsTotal} позиций</span>
                  <div className="flex gap-2">
                    <button disabled={rowsPage <= 1} onClick={() => { if (activeSession) loadRows(activeSession.id, filter, rowsPage - 1); }} className="px-3 py-1.5 text-xs rounded-lg border border-border disabled:opacity-40 hover:bg-surface-2 transition-colors">← Назад</button>
                    <button disabled={rowsPage >= rowsTotalPages} onClick={() => { if (activeSession) loadRows(activeSession.id, filter, rowsPage + 1); }} className="px-3 py-1.5 text-xs rounded-lg border border-border disabled:opacity-40 hover:bg-surface-2 transition-colors">Вперёд →</button>
                  </div>
                </div>
              )}
            </div>

            {/* Apply action bar */}
            {isOwnMode && activeSession.status !== "COMPLETED" && acceptedCount > 0 && (
              <div className="bg-accent-soft border border-accent-border rounded-lg p-3 flex items-center gap-2 flex-wrap">
                <span className="text-sm text-ink-2 flex-1 min-w-0">
                  Готовы применить? <strong className="text-ink">{acceptedCount} изменений</strong>
                  {stats && <span className="text-ink-3"> — {[stats.newItems > 0 && `новых ${stats.newItems}`, stats.priceChanges > 0 && `цен ${stats.priceChanges}`, stats.removedItems > 0 && `удалений ${stats.removedItems}`].filter(Boolean).join(", ")}</span>}
                </span>
                <button onClick={() => handleExport(activeSession.id)} className="px-3 py-1.5 text-xs font-medium text-ink-2 border border-border rounded-lg bg-surface hover:bg-surface-2 transition-colors">Сохранить на потом</button>
                <button onClick={() => setConfirmApply(true)} disabled={applying} className="px-4 py-1.5 text-xs font-medium bg-accent text-white rounded-lg hover:bg-accent-bright disabled:opacity-50 transition-colors">
                  {applying ? "Применение…" : "Применить к каталогу →"}
                </button>
              </div>
            )}

            {/* Bottom toolbar */}
            <div className="flex items-center gap-3 flex-wrap pt-1">
              <button onClick={() => handleExport(activeSession.id)} className="px-4 py-2 text-sm font-medium text-ink-2 bg-surface border border-border hover:bg-surface-2 rounded-xl transition-colors">Скачать XLSX</button>
              {isOwnMode && activeSession.status !== "COMPLETED" && (
                <button onClick={() => setConfirmApply(true)} disabled={applying} className="px-4 py-2 text-sm font-medium bg-emerald text-white disabled:opacity-50 rounded-xl hover:opacity-90 transition-colors">
                  {applying ? "Применение…" : `Применить ${acceptedCount > 0 ? acceptedCount : ""} изменений`}
                </button>
              )}
              <button onClick={() => handleDeleteSession(activeSession.id)} className="px-4 py-2 text-sm font-medium text-rose bg-rose-soft border border-rose-border rounded-xl hover:opacity-80 transition-colors">Удалить сессию</button>
            </div>
          </div>
        )}

        {/* ── Bulk confirm modal ─────────────────────────────────────────────── */}
        {confirmBulk && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
            <div className="bg-surface rounded-2xl shadow-xl p-6 w-full max-w-sm space-y-4">
              <h3 className="text-base font-semibold text-ink">{confirmBulk.action === "ACCEPTED" ? "Принять" : "Отклонить"} {confirmBulk.count} позиций?</h3>
              <p className="text-sm text-ink-2">Действие применится ко всем строкам в текущем фильтре.</p>
              <div className="flex gap-2 justify-end">
                <button onClick={() => setConfirmBulk(null)} className="px-4 py-2 text-sm text-ink-2 hover:text-ink">Отмена</button>
                <button onClick={() => handleBulkAction(confirmBulk.action)} className={`px-4 py-2 text-sm font-medium rounded-lg text-white transition-colors ${confirmBulk.action === "ACCEPTED" ? "bg-emerald hover:opacity-90" : "bg-rose hover:opacity-90"}`}>Подтвердить</button>
              </div>
            </div>
          </div>
        )}

        {/* ── Apply confirm modal ────────────────────────────────────────────── */}
        {confirmApply && stats && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
            <div className="bg-surface rounded-2xl shadow-xl p-6 w-full max-w-sm space-y-4">
              <h3 className="text-base font-semibold text-ink">Применить изменения?</h3>
              <div className="space-y-2 text-sm">
                {([["Изменены цены", stats.priceChanges], ["Новые позиции", stats.newItems], ["Удалены позиции", stats.removedItems], ["Изменено кол-во", stats.qtyChanges]] as [string, number][]).map(([label, count]) =>
                  count > 0 && <div key={label} className="flex justify-between"><span className="text-ink-2">{label}</span><span className="font-semibold text-ink mono-num">{count}</span></div>
                )}
              </div>
              <p className="text-xs text-amber">Действие нельзя отменить.</p>
              <div className="flex gap-2 justify-end">
                <button onClick={() => setConfirmApply(false)} className="px-4 py-2 text-sm text-ink-2 hover:text-ink">Отмена</button>
                <button onClick={handleApply} className="px-4 py-2 text-sm font-medium bg-emerald hover:opacity-90 text-white rounded-lg transition-colors">Применить</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
