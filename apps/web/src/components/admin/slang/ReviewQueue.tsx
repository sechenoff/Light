"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import type { SlangCandidate } from "./types";
import { ReviewItem } from "./ReviewItem";
import { RebindModal } from "./RebindModal";

type Props = {
  candidates: SlangCandidate[];
  onUpdate: () => void; // re-fetch all data after changes
};

export function ReviewQueue({ candidates, onUpdate }: Props) {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [acting, setActing] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  if (candidates.length === 0) return null;

  const allChecked = checked.size === candidates.length;

  function toggleCheck(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (allChecked) setChecked(new Set());
    else setChecked(new Set(candidates.map((c) => c.id)));
  }

  async function handleApprove(id: string) {
    const c = candidates.find((x) => x.id === id);
    if (!c || !c.proposedEquipmentId) return;
    setActing(id);
    try {
      await apiFetch(`/api/admin/slang-learning/${id}/approve`, {
        method: "POST",
        body: JSON.stringify({ reviewedBy: "admin", equipmentId: c.proposedEquipmentId }),
      });
      onUpdate();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Ошибка подтверждения");
    } finally {
      setActing(null);
    }
  }

  async function handleReject(id: string) {
    setActing(id);
    try {
      await apiFetch(`/api/admin/slang-learning/${id}/reject`, {
        method: "POST",
        body: JSON.stringify({ reviewedBy: "admin" }),
      });
      onUpdate();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Ошибка отклонения");
    } finally {
      setActing(null);
    }
  }

  async function handleBatchApprove() {
    const ids = Array.from(checked).filter((id) => {
      const c = candidates.find((x) => x.id === id);
      return c && c.proposedEquipmentId;
    });
    if (ids.length === 0) return;
    setActing("batch");
    try {
      // Sequential to avoid SQLite SQLITE_BUSY under concurrent writes
      for (const id of ids) {
        const c = candidates.find((x) => x.id === id)!;
        await apiFetch(`/api/admin/slang-learning/${id}/approve`, {
          method: "POST",
          body: JSON.stringify({ reviewedBy: "admin", equipmentId: c.proposedEquipmentId }),
        });
      }
      setChecked(new Set());
      onUpdate();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Ошибка batch-подтверждения");
      onUpdate(); // Refresh to show partial progress
    } finally {
      setActing(null);
    }
  }

  async function handleBatchReject() {
    const ids = Array.from(checked);
    if (ids.length === 0) return;
    setActing("batch");
    try {
      // Sequential to avoid SQLite SQLITE_BUSY under concurrent writes
      for (const id of ids) {
        await apiFetch(`/api/admin/slang-learning/${id}/reject`, {
          method: "POST",
          body: JSON.stringify({ reviewedBy: "admin" }),
        });
      }
      setChecked(new Set());
      onUpdate();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Ошибка batch-отклонения");
      onUpdate(); // Refresh to show partial progress
    } finally {
      setActing(null);
    }
  }

  function handleRebind(equipmentId: string, _equipmentName: string) {
    if (!editingId) return;
    apiFetch(`/api/admin/slang-learning/${editingId}/approve`, {
      method: "POST",
      body: JSON.stringify({ reviewedBy: "admin", equipmentId }),
    })
      .then(() => {
        setEditingId(null);
        onUpdate();
      })
      .catch((e: unknown) => {
        alert(e instanceof Error ? e.message : "Ошибка сохранения");
      });
  }

  const editingCandidate = editingId ? candidates.find((c) => c.id === editingId) : null;

  return (
    <>
      <div className="mb-6" id="review-queue">
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-[15px] font-semibold text-ink">На проверку</h2>
          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-soft text-amber border border-amber-border">
            {candidates.length}
          </span>
        </div>

        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-amber-soft">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={allChecked}
                onChange={toggleAll}
                className="w-4 h-4 accent-accent"
                title="Выбрать все"
              />
              <span className="text-xs font-semibold text-amber">
                AI предложил связи — подтвердите или исправьте
              </span>
            </div>
            {checked.size > 0 && (
              <div className="flex gap-2">
                <button
                  onClick={handleBatchApprove}
                  disabled={acting === "batch"}
                  className="px-3 py-1 text-xs font-medium rounded-md border border-emerald-border bg-surface text-emerald hover:bg-emerald-soft transition-colors disabled:opacity-50"
                >
                  ✓ Подтвердить выбранные
                </button>
                <button
                  onClick={handleBatchReject}
                  disabled={acting === "batch"}
                  className="px-3 py-1 text-xs font-medium rounded-md border border-rose-border bg-surface text-rose hover:bg-rose-soft transition-colors disabled:opacity-50"
                >
                  ✕ Отклонить выбранные
                </button>
              </div>
            )}
          </div>

          {/* Items */}
          {candidates.map((c) => (
            <ReviewItem
              key={c.id}
              candidate={c}
              checked={checked.has(c.id)}
              onCheck={toggleCheck}
              onApprove={handleApprove}
              onReject={handleReject}
              onEdit={setEditingId}
              acting={acting}
            />
          ))}
        </div>
      </div>

      {editingCandidate && (
        <RebindModal
          phrase={editingCandidate.rawPhrase}
          currentEquipmentId={editingCandidate.proposedEquipmentId ?? ""}
          onRebind={handleRebind}
          onClose={() => setEditingId(null)}
        />
      )}
    </>
  );
}
