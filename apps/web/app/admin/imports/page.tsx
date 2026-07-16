"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useRequireRole } from "@/hooks/useRequireRole";
import { toast } from "@/components/ToastProvider";
import { AdminTabNav } from "@/components/admin/AdminTabNav";
import { UploadStep } from "@/components/admin/imports/UploadStep";
import { AnalysisProgress } from "@/components/admin/imports/AnalysisProgress";
import { OwnCatalogReview } from "@/components/admin/imports/OwnCatalogReview";
import { CompetitorReview } from "@/components/admin/imports/CompetitorReview";
import { SessionHistory } from "@/components/admin/imports/SessionHistory";
import { RebindModal } from "@/components/admin/imports/RebindModal";
import {
  buildOwnResultFromRows,
  buildCompetitorResultFromRows,
  type RawSessionRow,
} from "./rebuild";
import type {
  ImportSession,
  AnalyzeResultOwn,
  AnalyzeResultCompetitor,
  ChangeGroup,
  ImportRow,
} from "@/components/admin/imports/types";

type Step = "upload" | "analyzing" | "review";

// ── Загрузка всех строк сессии постранично (limit=200 — серверный максимум) ──

async function fetchAllRows(sessionId: string): Promise<RawSessionRow[]> {
  const all: RawSessionRow[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const res = await apiFetch<{ rows: RawSessionRow[]; totalPages: number }>(
      `/api/import-sessions/${sessionId}/rows?limit=200&page=${page}`
    );
    all.push(...(res.rows ?? []));
    totalPages = res.totalPages ?? 1;
    page += 1;
  } while (page <= totalPages);
  return all;
}

// ── Apply Confirmation Modal ────────────────────────────────────────────────

type ApplyConfirmModalProps = {
  open: boolean;
  acceptedCount: number;
  loading: boolean;
  onConfirm: () => void;
  onClose: () => void;
};

function ApplyConfirmModal({ open, acceptedCount, loading, onConfirm, onClose }: ApplyConfirmModalProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // Автофокус на основное действие: Enter подтверждает, Esc отменяет.
    setTimeout(() => confirmRef.current?.focus(), 50);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !loading) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, loading, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 px-4"
      onClick={() => !loading && onClose()}
      aria-modal="true"
      role="dialog"
      aria-labelledby="apply-import-title"
    >
      <div
        className="w-full max-w-md rounded-lg bg-surface p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="apply-import-title" className="text-[17px] font-semibold text-ink mb-2">
          Применить {acceptedCount} изменений?
        </h2>
        <p className="text-[13.5px] text-ink-2 mb-5">
          Принятые цены будут записаны в каталог. Это действие нельзя отменить.
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="rounded border border-border px-4 py-2 text-sm text-ink-2 hover:bg-surface-muted disabled:opacity-50"
          >
            Отмена
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className="rounded bg-accent-bright px-4 py-2 text-sm text-white hover:bg-accent disabled:opacity-50"
          >
            {loading ? "Применяем…" : "Применить"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ImportsPage() {
  const { authorized, loading } = useRequireRole(["SUPER_ADMIN"]);
  if (loading || !authorized) return null;
  return <ImportsPageInner />;
}

function ImportsPageInner() {
  const [step, setStep] = useState<Step>("upload");
  const [session, setSession] = useState<ImportSession | null>(null);
  const [ownResult, setOwnResult] = useState<AnalyzeResultOwn | null>(null);
  const [competitorResult, setCompetitorResult] = useState<AnalyzeResultCompetitor | null>(null);
  const [sessions, setSessions] = useState<ImportSession[]>([]);
  const [uploading, setUploading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [rebindRowId, setRebindRowId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [analyzeFileName, setAnalyzeFileName] = useState("");
  const [confirmApplyOpen, setConfirmApplyOpen] = useState(false);

  // Load session history on mount and when step changes back to upload
  useEffect(() => {
    if (step !== "upload") return;
    let cancelled = false;
    async function load() {
      try {
        const data = await apiFetch<{ sessions: ImportSession[] }>("/api/import-sessions");
        if (!cancelled) setSessions(data.sessions ?? []);
      } catch {
        // non-critical
      }
    }
    load();
    return () => { cancelled = true; };
  }, [step]);

  // ── Handlers ────────────────────────────────────────────────────────────────

  async function handleUpload(
    file: File,
    type: "OWN_PRICE_UPDATE" | "COMPETITOR_IMPORT",
    competitorName?: string
  ) {
    setUploading(true);
    setError(null);
    setAnalyzeFileName(file.name);
    try {
      // 1. Upload
      const form = new FormData();
      form.append("file", file);
      if (type) form.append("type", type);
      if (competitorName) form.append("competitorName", competitorName);
      const uploadRes = await apiFetch<{ session: ImportSession }>(
        "/api/import-sessions/upload",
        { method: "POST", body: form }
      );
      const uploadedSession = uploadRes.session;
      setSession(uploadedSession);
      setStep("analyzing");

      // 2. Analyze
      const analyzeRes = await apiFetch<AnalyzeResultOwn | AnalyzeResultCompetitor>(
        `/api/import-sessions/${uploadedSession.id}/analyze`,
        { method: "POST", body: JSON.stringify({ type, competitorName }) }
      );

      // 3. Set result
      if (type === "OWN_PRICE_UPDATE") {
        setOwnResult(analyzeRes as AnalyzeResultOwn);
        setCompetitorResult(null);
      } else {
        setCompetitorResult(analyzeRes as AnalyzeResultCompetitor);
        setOwnResult(null);
      }

      // 4. Refresh session with latest data
      try {
        const refreshed = await apiFetch<{ session: ImportSession }>(
          `/api/import-sessions/${uploadedSession.id}`
        );
        setSession(refreshed.session);
      } catch {
        // use original session
      }

      setStep("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка при загрузке файла");
      setStep("upload");
      setSession(null);
    } finally {
      setUploading(false);
    }
  }

  async function handleRowAction(rowId: string, status: "ACCEPTED" | "REJECTED") {
    if (!session) return;
    try {
      await apiFetch(`/api/import-sessions/${session.id}/rows/${rowId}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      // Update local ownResult state
      if (ownResult) {
        setOwnResult({
          ...ownResult,
          groups: ownResult.groups.map((g) => ({
            ...g,
            rows: g.rows.map((r) => (r.id === rowId ? { ...r, status } : r)),
          })),
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка обновления строки");
    }
  }

  async function handleBulkAction(
    action: "ACCEPTED" | "REJECTED",
    groupType?: ChangeGroup["type"]
  ) {
    if (!session) return;
    try {
      await apiFetch(`/api/import-sessions/${session.id}/bulk-action`, {
        method: "POST",
        body: JSON.stringify({
          action,
          filter: groupType ? { action: groupType } : {},
        }),
      });
      // Re-fetch rows from server to get the true state (server skips FLAGGED rows for ACCEPTED).
      // Полный пагинационный цикл — иначе строки со 2-й страницы остаются в старом статусе.
      if (ownResult) {
        try {
          const all = await fetchAllRows(session.id);
          const byId = new Map(all.map((r) => [r.id, r]));
          setOwnResult({
            ...ownResult,
            groups: ownResult.groups.map((g) => ({
              ...g,
              rows: g.rows.map((r) => {
                const serverRow = byId.get(r.id);
                return serverRow ? { ...r, status: serverRow.status } : r;
              }),
            })),
          });
        } catch {
          // non-critical: leave existing optimistic state
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка массового действия");
    }
  }

  async function handleApply() {
    if (!session) return;
    setApplying(true);
    setError(null);
    try {
      await apiFetch(`/api/import-sessions/${session.id}/apply`, { method: "POST" });
      toast.success("Изменения применены");
      setStep("upload");
      setSession(null);
      setOwnResult(null);
      setCompetitorResult(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка применения");
    } finally {
      setApplying(false);
      setConfirmApplyOpen(false);
    }
  }

  async function handleExport() {
    if (!session) return;
    try {
      const res = await window.fetch(`/api/import-sessions/${session.id}/export`, {
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error("Ошибка экспорта");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `import-${session.id}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка экспорта");
    }
  }

  async function handleRebind(equipmentId: string, equipmentName: string) {
    if (!session || !rebindRowId) return;
    try {
      await apiFetch(
        `/api/import-sessions/${session.id}/rows/${rebindRowId}/rebind`,
        { method: "PATCH", body: JSON.stringify({ equipmentId }) }
      );
      // Update local state
      const updateRow = (r: ImportRow): ImportRow =>
        r.id === rebindRowId
          ? { ...r, equipmentId, equipmentName, matchSource: "manual_rebind" }
          : r;
      if (ownResult) {
        setOwnResult({
          ...ownResult,
          groups: ownResult.groups.map((g) => ({
            ...g,
            rows: g.rows.map(updateRow),
          })),
        });
      }
      if (competitorResult) {
        setCompetitorResult({
          ...competitorResult,
          comparison: {
            ...competitorResult.comparison,
            matched: competitorResult.comparison.matched.map((r) =>
              r.id === rebindRowId
                ? { ...r, equipmentId, equipmentName, matchSource: "manual_rebind" }
                : r
            ),
          },
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка переподвязки");
    } finally {
      setRebindRowId(null);
    }
  }

  async function handleSelectSession(s: ImportSession) {
    setError(null);
    setSession(s);
    setOwnResult(null);
    setCompetitorResult(null);
    setHistoryLoading(true);
    setStep("review");
    try {
      // Дозагружаем все строки сессии постранично.
      const all = await fetchAllRows(s.id);

      if (s.type === "OWN_PRICE_UPDATE") {
        setOwnResult(buildOwnResultFromRows(s, all));
      } else {
        setCompetitorResult(buildCompetitorResultFromRows(s, all));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить данные сессии");
    } finally {
      setHistoryLoading(false);
    }
  }

  // ── Find rebind row data ─────────────────────────────────────────────────────

  let rebindSourceName = "";
  let rebindCurrentEquipmentId: string | null = null;

  if (rebindRowId) {
    if (ownResult) {
      for (const g of ownResult.groups) {
        const row = g.rows.find((r) => r.id === rebindRowId);
        if (row) {
          rebindSourceName = row.sourceName;
          rebindCurrentEquipmentId = row.equipmentId;
          break;
        }
      }
    }
    if (!rebindSourceName && competitorResult) {
      const row = competitorResult.comparison.matched.find((r) => r.id === rebindRowId);
      if (row) {
        rebindSourceName = row.sourceName;
        rebindCurrentEquipmentId = row.equipmentId;
      }
    }
  }

  const isOwnType = session?.type === "OWN_PRICE_UPDATE";
  const acceptedCount = ownResult
    ? ownResult.groups.reduce(
        (sum, g) => sum + g.rows.filter((r) => r.status === "ACCEPTED").length,
        0
      )
    : 0;

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 space-y-6">
      <AdminTabNav />

      {/* Page header */}
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-lg font-semibold text-ink">Импорт цен</h1>
        {step !== "upload" && (
          <button
            type="button"
            onClick={() => {
              setStep("upload");
              setSession(null);
              setOwnResult(null);
              setCompetitorResult(null);
              setError(null);
            }}
            className="text-sm text-ink-2 hover:text-ink border border-border rounded-lg px-3 py-1.5 hover:bg-surface-muted transition-colors"
          >
            ← Новый импорт
          </button>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-lg text-sm font-medium bg-rose-soft text-rose border border-rose-border">
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            aria-label="Закрыть ошибку"
            className="text-xs opacity-60 hover:opacity-100"
          >
            ✕
          </button>
        </div>
      )}

      {/* Steps */}
      {step === "upload" && (
        <div className="space-y-8">
          <UploadStep onUpload={handleUpload} loading={uploading} />
          <SessionHistory sessions={sessions} onSelect={handleSelectSession} />
        </div>
      )}

      {step === "analyzing" && (
        <AnalysisProgress fileName={analyzeFileName} />
      )}

      {step === "review" && session && isOwnType && ownResult && (
        <OwnCatalogReview
          result={ownResult}
          fileName={session.fileName}
          onAccept={(rowId) => handleRowAction(rowId, "ACCEPTED")}
          onReject={(rowId) => handleRowAction(rowId, "REJECTED")}
          onRebind={(rowId) => setRebindRowId(rowId)}
          onBulkAccept={(groupType) => handleBulkAction("ACCEPTED", groupType)}
          onBulkReject={(groupType) => handleBulkAction("REJECTED", groupType)}
          onApply={() => setConfirmApplyOpen(true)}
          onExport={handleExport}
          applying={applying}
        />
      )}

      {step === "review" && session && !isOwnType && competitorResult && (
        <CompetitorReview
          result={competitorResult}
          competitorName={session.competitorName ?? ""}
          fileName={session.fileName}
          onRebind={(rowId) => setRebindRowId(rowId)}
          onExport={handleExport}
        />
      )}

      {/* Loading: восстанавливаем данные сессии из истории */}
      {step === "review" && historyLoading && (
        <div className="py-16 text-center text-sm text-ink-3">
          Загружаем данные сессии…
        </div>
      )}

      {/* Fallback: строки не удалось загрузить (сетевая ошибка и т.п.) */}
      {step === "review" && session && !historyLoading && !ownResult && !competitorResult && (
        <div className="py-16 text-center text-sm text-ink-3">
          <p className="mb-4">Данные анализа недоступны для этой сессии.</p>
          <button
            type="button"
            onClick={() => {
              setStep("upload");
              setSession(null);
            }}
            className="text-accent hover:underline"
          >
            Загрузить новый файл
          </button>
        </div>
      )}

      {/* Apply confirmation modal */}
      <ApplyConfirmModal
        open={confirmApplyOpen}
        acceptedCount={acceptedCount}
        loading={applying}
        onConfirm={() => { void handleApply(); }}
        onClose={() => setConfirmApplyOpen(false)}
      />

      {/* Rebind modal */}
      {rebindRowId && (
        <RebindModal
          sourceName={rebindSourceName}
          currentEquipmentId={rebindCurrentEquipmentId}
          onRebind={handleRebind}
          onClose={() => setRebindRowId(null)}
        />
      )}
    </div>
  );
}
