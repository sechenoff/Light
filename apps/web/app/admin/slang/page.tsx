"use client";

import { useState, useEffect } from "react";
import { AdminTabNav } from "@/components/admin/AdminTabNav";
import { useRequireRole } from "@/hooks/useRequireRole";
import { apiFetch } from "@/lib/api";
import { HealthBanner } from "@/components/admin/slang/HealthBanner";
import { SlangKpiCards } from "@/components/admin/slang/SlangKpiCards";
import { ReviewQueue } from "@/components/admin/slang/ReviewQueue";
import { DictionaryTable } from "@/components/admin/slang/DictionaryTable";
import { DetailSidebar } from "@/components/admin/slang/DetailSidebar";
import { HowItWorks } from "@/components/admin/slang/HowItWorks";
import type { SlangStats, SlangAlias, DictionaryGroup, SlangCandidate } from "@/components/admin/slang/types";

// Flatten grouped dictionary into flat alias list
function flattenGroups(groups: DictionaryGroup[]): SlangAlias[] {
  return groups.flatMap((g) => g.aliases);
}

export default function SlangPage() {
  useRequireRole(["SUPER_ADMIN"]);

  const [stats, setStats] = useState<SlangStats | null>(null);
  const [aliases, setAliases] = useState<SlangAlias[]>([]);
  const [candidates, setCandidates] = useState<SlangCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [statsData, dictData, pendingData] = await Promise.all([
          apiFetch<SlangStats>("/api/admin/slang-learning/stats"),
          apiFetch<DictionaryGroup[]>("/api/admin/slang-learning/dictionary"),
          apiFetch<SlangCandidate[]>("/api/admin/slang-learning?status=PENDING"),
        ]);
        if (!cancelled) {
          setStats(statsData);
          setAliases(flattenGroups(dictData));
          setCandidates(pendingData);
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Ошибка загрузки");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [refreshKey]);

  function triggerRefresh() {
    setRefreshKey((k) => k + 1);
  }

  const selectedAlias = selectedId ? aliases.find((a) => a.id === selectedId) ?? null : null;

  // Rebind: create new alias first, then delete old (safe order — failure leaves duplicate, not data loss)
  async function handleRebind(oldAliasId: string, newEquipmentId: string, _newEquipmentName: string) {
    const alias = aliases.find((a) => a.id === oldAliasId);
    if (!alias) return;
    try {
      // 1. Create new binding first
      await apiFetch("/api/admin/slang-learning/propose", {
        method: "POST",
        body: JSON.stringify({
          rawPhrase: alias.phraseOriginal,
          proposedEquipmentId: newEquipmentId,
          confidence: 1.0,
          contextJson: JSON.stringify({ source: "manual_rebind" }),
        }),
      });
      // 2. Only delete old after new is confirmed saved
      await apiFetch(`/api/admin/slang-learning/aliases/${oldAliasId}`, {
        method: "DELETE",
      });
      setSelectedId(null);
      triggerRefresh();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Ошибка изменения связи");
      // Refresh to show current state (new may exist, old may still exist)
      triggerRefresh();
    }
  }

  function handleDelete(id: string) {
    setAliases((prev) => prev.filter((a) => a.id !== id));
    if (selectedId === id) setSelectedId(null);
    // Also refresh stats
    triggerRefresh();
  }

  function handleExport() {
    window.open("/api/admin/slang-learning/dictionary/export", "_blank");
  }

  const pendingCount = stats?.pendingCount ?? candidates.length;

  return (
    <div className="p-4 md:p-6 max-w-6xl">
      <AdminTabNav counts={{ slang: aliases.length }} />

      {/* Page header */}
      <div className="mt-4 mb-5">
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          Словарь сленга
        </h1>
        <p className="text-sm text-ink-2 mt-1">
          AI учится понимать, как гафферы называют оборудование. Здесь можно
          проверить, исправить или удалить выученные связи.
        </p>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-rose-soft border border-rose-border text-rose text-sm rounded-lg p-3 mb-4">
          {error}
        </div>
      )}

      {/* Health banner */}
      {!loading && <HealthBanner pendingCount={pendingCount} />}

      {/* KPI cards */}
      <SlangKpiCards stats={loading ? null : stats} />

      {/* Review queue — only visible when there are pending candidates */}
      {!loading && candidates.length > 0 && (
        <ReviewQueue candidates={candidates} onUpdate={triggerRefresh} />
      )}

      {/* Dictionary + Sidebar layout */}
      <div className="flex gap-4 items-start">
        <div className="flex-1 min-w-0">
          {loading ? (
            <div className="py-10 text-center text-sm text-ink-3">Загрузка…</div>
          ) : (
            <DictionaryTable
              aliases={aliases}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onExport={handleExport}
            />
          )}
        </div>

        {selectedAlias && (
          <DetailSidebar
            alias={selectedAlias}
            onDelete={handleDelete}
            onRebind={handleRebind}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>

      {/* How it works */}
      <HowItWorks />
    </div>
  );
}
