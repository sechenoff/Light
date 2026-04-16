"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useRequireRole } from "@/hooks/useRequireRole";
import { AdminTabNav } from "@/components/admin/AdminTabNav";
import { UploadStep } from "@/components/admin/imports/UploadStep";
import { AnalysisProgress } from "@/components/admin/imports/AnalysisProgress";
import { OwnCatalogReview } from "@/components/admin/imports/OwnCatalogReview";
import { CompetitorReview } from "@/components/admin/imports/CompetitorReview";
import { SessionHistory } from "@/components/admin/imports/SessionHistory";
import { RebindModal } from "@/components/admin/imports/RebindModal";
import type {
  ImportSession,
  AnalyzeResultOwn,
  AnalyzeResultCompetitor,
  ChangeGroup,
  ImportRow,
} from "@/components/admin/imports/types";

type Step = "upload" | "analyzing" | "review";

export default function ImportsPage() {
  useRequireRole(["SUPER_ADMIN"]);

  const [step, setStep] = useState<Step>("upload");
  const [session, setSession] = useState<ImportSession | null>(null);
  const [ownResult, setOwnResult] = useState<AnalyzeResultOwn | null>(null);
  const [competitorResult, setCompetitorResult] = useState<AnalyzeResultCompetitor | null>(null);
  const [sessions, setSessions] = useState<ImportSession[]>([]);
  const [uploading, setUploading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [rebindRowId, setRebindRowId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [analyzeFileName, setAnalyzeFileName] = useState("");

  // Load session history on mount and when step changes back to upload
  useEffect(() => {
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
      // Update local ownResult state
      if (ownResult) {
        setOwnResult({
          ...ownResult,
          groups: ownResult.groups.map((g) => {
            if (groupType && g.type !== groupType) return g;
            return {
              ...g,
              rows: g.rows.map((r) => ({ ...r, status: action })),
            };
          }),
        });
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
      setStep("upload");
      setSession(null);
      setOwnResult(null);
      setCompetitorResult(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка применения");
    } finally {
      setApplying(false);
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

  function handleSelectSession(s: ImportSession) {
    setSession(s);
    // Navigate to review step with empty result (session already exists)
    // The user can see the session but we don't re-fetch analysis here
    setStep("review");
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

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-surface">
      <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
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
              className="text-sm text-ink-2 hover:text-ink border border-border rounded-lg px-3 py-1.5 hover:bg-surface-2 transition-colors"
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
            onApply={handleApply}
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

        {/* Fallback: session loaded but no result yet (opened from history) */}
        {step === "review" && session && !ownResult && !competitorResult && (
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
      </div>

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
