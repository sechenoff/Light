"use client";

import { useState, useEffect } from "react";
import { AdminTabNav } from "@/components/admin/AdminTabNav";
import { useRequireRole } from "@/hooks/useRequireRole";
import { apiFetch } from "@/lib/api";
import { HealthBanner } from "@/components/admin/slang/HealthBanner";
import { SlangKpiCards } from "@/components/admin/slang/SlangKpiCards";
import { ReviewQueue } from "@/components/admin/slang/ReviewQueue";
import { DictionaryAccordion } from "@/components/admin/slang/DictionaryAccordion";
import { HowItWorks } from "@/components/admin/slang/HowItWorks";
import type { SlangStats, DictionaryGroup, SlangCandidate } from "@/components/admin/slang/types";

export default function SlangPage() {
  useRequireRole(["SUPER_ADMIN"]);

  const [stats, setStats] = useState<SlangStats | null>(null);
  const [groups, setGroups] = useState<DictionaryGroup[]>([]);
  const [candidates, setCandidates] = useState<SlangCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
          setGroups(dictData);
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

  // Rebind: create new alias first, then delete old (safe order — failure leaves duplicate, not data loss)
  async function handleRebind(oldAliasId: string, newEquipmentId: string, _newEquipmentName: string) {
    // Find the alias in groups
    let phraseOriginal: string | undefined;
    for (const group of groups) {
      const found = group.aliases.find((a) => a.id === oldAliasId);
      if (found) { phraseOriginal = found.phraseOriginal; break; }
    }
    if (!phraseOriginal) return;

    try {
      // 1. Create new binding first
      await apiFetch("/api/admin/slang-learning/propose", {
        method: "POST",
        body: JSON.stringify({
          rawPhrase: phraseOriginal,
          proposedEquipmentId: newEquipmentId,
          confidence: 1.0,
          contextJson: JSON.stringify({ source: "manual_rebind" }),
        }),
      });
      // 2. Only delete old after new is confirmed saved
      await apiFetch(`/api/admin/slang-learning/aliases/${oldAliasId}`, {
        method: "DELETE",
      });
      triggerRefresh();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Ошибка изменения связи");
      // Refresh to show current state (new may exist, old may still exist)
      triggerRefresh();
    }
  }

  function handleDelete(aliasId: string) {
    // Optimistically remove the phrase from the correct group
    setGroups((prev) =>
      prev
        .map((group) => ({
          ...group,
          aliases: group.aliases.filter((a) => a.id !== aliasId),
          aliasCount: group.aliasCount - (group.aliases.some((a) => a.id === aliasId) ? 1 : 0),
        }))
        .filter((group) => group.aliases.length > 0),
    );
    triggerRefresh();
  }

  function handleExport() {
    window.open("/api/admin/slang-learning/dictionary/export", "_blank");
  }

  const pendingCount = stats?.pendingCount ?? candidates.length;
  const totalAliases = groups.reduce((sum, g) => sum + g.aliases.length, 0);

  return (
    <div className="p-4 md:p-6 max-w-6xl">
      <AdminTabNav counts={{ slang: totalAliases }} />

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

      {/* Dictionary accordion */}
      {loading ? (
        <div className="py-10 text-center text-sm text-ink-3">Загрузка…</div>
      ) : (
        <DictionaryAccordion
          groups={groups}
          onDelete={handleDelete}
          onRebind={handleRebind}
          onExport={handleExport}
        />
      )}

      {/* How it works */}
      <HowItWorks />
    </div>
  );
}
