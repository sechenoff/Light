"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { apiFetch, apiFetchRaw } from "../../../../src/lib/api";
import { StatusPill, type StatusPillVariant } from "../../../../src/components/StatusPill";
import { SectionHeader } from "../../../../src/components/SectionHeader";

// ── Types ─────────────────────────────────────────────────────────────────────

type UnitStatus = "AVAILABLE" | "ISSUED" | "MAINTENANCE" | "RETIRED" | "MISSING";

type EquipmentUnit = {
  id: string;
  barcode: string;
  serialNumber: string | null;
  status: UnitStatus;
  comment: string | null;
  createdAt: string;
};

type Equipment = {
  id: string;
  name: string;
  category: string;
  brand: string | null;
  model: string | null;
};

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<UnitStatus, string> = {
  AVAILABLE:   "На складе",
  ISSUED:      "Выдана",
  MAINTENANCE: "Ремонт",
  RETIRED:     "Списана",
  MISSING:     "Утеряна",
};

const STATUS_VARIANT: Record<UnitStatus, StatusPillVariant> = {
  AVAILABLE:   "full",
  ISSUED:      "limited",
  MAINTENANCE: "warn",
  RETIRED:     "none",
  MISSING:     "none",
};

function UnitStatusBadge({ status }: { status: UnitStatus }) {
  return (
    <StatusPill
      variant={STATUS_VARIANT[status] ?? "none"}
      label={STATUS_LABELS[status] ?? status}
    />
  );
}

// ── Generate modal ────────────────────────────────────────────────────────────

function GenerateModal({
  equipmentId,
  onClose,
  onGenerated,
}: {
  equipmentId: string;
  onClose: () => void;
  onGenerated: () => void;
}) {
  const [count, setCount] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGenerate() {
    if (count < 1) return;
    setLoading(true);
    setError(null);
    try {
      await apiFetch(`/api/equipment/${equipmentId}/units/generate`, {
        method: "POST",
        body: JSON.stringify({ count }),
      });
      onGenerated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка генерации");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm bg-white rounded-2xl border border-slate-200 shadow-lg p-6">
        <h2 className="text-base font-semibold text-slate-900 mb-4">Сгенерировать единицы</h2>
        <label className="block text-sm text-slate-700 mb-1">Количество единиц</label>
        <input
          type="number"
          min={1}
          max={100}
          value={count}
          onChange={(e) => setCount(Math.max(1, parseInt(e.target.value) || 1))}
          className="w-full rounded border border-slate-300 px-3 py-2 text-sm mb-4"
        />
        {error && <p className="text-xs text-rose-600 mb-3">{error}</p>}
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={loading}
            className="rounded bg-accent-bright text-white px-4 py-2 text-sm hover:bg-accent disabled:opacity-50 transition-colors"
          >
            {loading ? "Генерация..." : `Создать ${count} шт.`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Edit row modal ────────────────────────────────────────────────────────────

function EditModal({
  unit,
  equipmentId,
  onClose,
  onSaved,
}: {
  unit: EquipmentUnit;
  equipmentId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [serialNumber, setSerialNumber] = useState(unit.serialNumber ?? "");
  const [status, setStatus] = useState<UnitStatus>(unit.status);
  const [comment, setComment] = useState(unit.comment ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setLoading(true);
    setError(null);
    try {
      await apiFetch(`/api/equipment/${equipmentId}/units/${unit.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          serialNumber: serialNumber || null,
          status,
          comment: comment || null,
        }),
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка сохранения");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-lg p-6">
        <h2 className="text-base font-semibold text-slate-900 mb-4">Редактировать единицу</h2>
        <p className="text-xs text-slate-500 mb-4 font-mono">{unit.barcode}</p>

        <label className="block text-sm text-slate-700 mb-1">Серийный номер</label>
        <input
          type="text"
          value={serialNumber}
          onChange={(e) => setSerialNumber(e.target.value)}
          placeholder="не указан"
          className="w-full rounded border border-slate-300 px-3 py-2 text-sm mb-3"
        />

        <label className="block text-sm text-slate-700 mb-1">Статус</label>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as UnitStatus)}
          className="w-full rounded border border-slate-300 px-3 py-2 text-sm mb-3 bg-white"
        >
          {(Object.keys(STATUS_LABELS) as UnitStatus[]).map((s) => (
            <option key={s} value={s}>{STATUS_LABELS[s]}</option>
          ))}
        </select>

        <label className="block text-sm text-slate-700 mb-1">Комментарий</label>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="необязательно"
          rows={2}
          className="w-full rounded border border-slate-300 px-3 py-2 text-sm mb-4 resize-none"
        />

        {error && <p className="text-xs text-rose-600 mb-3">{error}</p>}
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={loading}
            className="rounded bg-accent-bright text-white px-4 py-2 text-sm hover:bg-accent disabled:opacity-50 transition-colors"
          >
            {loading ? "Сохранение..." : "Сохранить"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Delete confirm dialog ─────────────────────────────────────────────────────

function DeleteConfirm({
  unit,
  equipmentId,
  onClose,
  onDeleted,
}: {
  unit: EquipmentUnit;
  equipmentId: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setLoading(true);
    setError(null);
    try {
      await apiFetch(`/api/equipment/${equipmentId}/units/${unit.id}`, { method: "DELETE" });
      onDeleted();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка удаления");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm bg-white rounded-2xl border border-slate-200 shadow-lg p-6">
        <h2 className="text-base font-semibold text-slate-900 mb-2">Удалить единицу?</h2>
        <p className="text-sm text-slate-600 mb-1">Штрихкод: <span className="font-mono">{unit.barcode}</span></p>
        {unit.serialNumber && (
          <p className="text-sm text-slate-600 mb-1">Серийный номер: {unit.serialNumber}</p>
        )}
        <p className="text-xs text-slate-400 mb-4">Это действие необратимо.</p>
        {error && <p className="text-xs text-rose-600 mb-3">{error}</p>}
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={loading}
            className="rounded bg-rose-600 text-white px-4 py-2 text-sm hover:bg-rose-700 disabled:opacity-50"
          >
            {loading ? "Удаление..." : "Удалить"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function UnitsPage() {
  const params = useParams();
  const equipmentId = params.id as string;

  const [equipment, setEquipment] = useState<Equipment | null>(null);
  const [units, setUnits] = useState<EquipmentUnit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showGenerate, setShowGenerate] = useState(false);
  const [editUnit, setEditUnit] = useState<EquipmentUnit | null>(null);
  const [deleteUnit, setDeleteUnit] = useState<EquipmentUnit | null>(null);

  const [printingAll, setPrintingAll] = useState(false);
  const [printingUnit, setPrintingUnit] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [eq, unitsData] = await Promise.all([
        apiFetch<Equipment>(`/api/equipment/${equipmentId}`),
        apiFetch<{ units: EquipmentUnit[] }>(`/api/equipment/${equipmentId}/units`),
      ]);
      setEquipment(eq);
      setUnits(unitsData.units);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка загрузки данных");
    } finally {
      setLoading(false);
    }
  }, [equipmentId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handlePrintAll() {
    setPrintingAll(true);
    try {
      const res = await apiFetchRaw(`/api/equipment/${equipmentId}/units/labels`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `labels-${equipmentId}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Ошибка печати этикеток");
    } finally {
      setPrintingAll(false);
    }
  }

  async function handlePrintUnit(unit: EquipmentUnit) {
    setPrintingUnit(unit.id);
    try {
      const res = await apiFetchRaw(`/api/equipment/${equipmentId}/units/${unit.id}/label`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `label-${unit.barcode}.png`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Ошибка печати этикетки");
    } finally {
      setPrintingUnit(null);
    }
  }

  return (
    <div className="p-4">
      {/* Back link */}
      <div className="mb-4">
        <Link href="/equipment" className="text-sm text-slate-500 hover:text-slate-900">
          ← Назад к каталогу
        </Link>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3 mb-5">
        <div>
          {equipment ? (
            <>
              <h1 className="text-xl font-semibold text-slate-900">{equipment.name}</h1>
              <p className="text-sm text-slate-500 mt-0.5">
                {equipment.category}
                {equipment.brand && ` · ${equipment.brand}`}
                {equipment.model && ` · ${equipment.model}`}
              </p>
            </>
          ) : (
            <h1 className="text-xl font-semibold text-slate-400">Загрузка...</h1>
          )}
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            type="button"
            onClick={handlePrintAll}
            disabled={printingAll || units.length === 0}
            className="rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {printingAll ? "Загрузка..." : "Печать всех этикеток (PDF)"}
          </button>
          <button
            type="button"
            onClick={() => setShowGenerate(true)}
            className="rounded bg-accent-bright text-white px-4 py-2 text-sm hover:bg-accent transition-colors"
          >
            Сгенерировать единицы
          </button>
          <Link
            href={`/admin/scanner?equipmentId=${params.id}&mode=assign`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
          >
            📷 Открыть в сканере
          </Link>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="py-12 text-center text-slate-400">Загрузка...</div>
      )}

      {/* Empty */}
      {!loading && !error && units.length === 0 && (
        <div className="py-12 text-center text-slate-500 border border-slate-200 rounded-xl bg-white">
          <p className="mb-2">Единицы ещё не созданы</p>
          <p className="text-sm text-slate-400">Нажмите «Сгенерировать единицы» чтобы добавить</p>
        </div>
      )}

      {/* Desktop table */}
      {!loading && units.length > 0 && (
        <div className="hidden md:block rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface-subtle text-ink-2 border-b border-border text-xs">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Штрихкод</th>
                <th className="text-left px-3 py-3 font-medium">Серийный номер</th>
                <th className="text-left px-3 py-3 font-medium">Статус</th>
                <th className="text-left px-3 py-3 font-medium">Комментарий</th>
                <th className="px-3 py-3 text-right font-medium">Действия</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {units.map((unit) => (
                <tr key={unit.id} className="hover:bg-surface-muted transition-colors">
                  <td className="px-4 py-3 text-xs text-ink-3 font-mono">{unit.barcode}</td>
                  <td className="px-3 py-3 text-ink-2">{unit.serialNumber ?? <span className="text-ink-3">—</span>}</td>
                  <td className="px-3 py-3"><UnitStatusBadge status={unit.status} /></td>
                  <td className="px-3 py-3 text-ink-3 text-xs max-w-[200px] truncate">{unit.comment ?? <span className="text-ink-3">—</span>}</td>
                  <td className="px-3 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => handlePrintUnit(unit)}
                        disabled={printingUnit === unit.id}
                        className="text-xs rounded border border-slate-200 px-2 py-1 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                      >
                        {printingUnit === unit.id ? "..." : "Этикетка"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditUnit(unit)}
                        className="text-xs rounded border border-slate-200 px-2 py-1 text-slate-600 hover:bg-slate-50"
                      >
                        Изменить
                      </button>
                      {unit.status === "AVAILABLE" && (
                        <button
                          type="button"
                          onClick={() => setDeleteUnit(unit)}
                          className="text-xs rounded border border-rose-200 px-2 py-1 text-rose-600 hover:bg-rose-50"
                        >
                          Удалить
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Mobile cards */}
      {!loading && units.length > 0 && (
        <div className="md:hidden space-y-3">
          {units.map((unit) => (
            <div key={unit.id} className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex items-start justify-between mb-2">
                <span className="font-mono text-xs text-ink-3">{unit.barcode}</span>
                <UnitStatusBadge status={unit.status} />
              </div>
              {unit.serialNumber && (
                <p className="text-sm text-slate-600 mb-1">С/н: {unit.serialNumber}</p>
              )}
              {unit.comment && (
                <p className="text-xs text-slate-400 mb-3">{unit.comment}</p>
              )}
              <div className="flex gap-2 flex-wrap mt-3">
                <button
                  type="button"
                  onClick={() => handlePrintUnit(unit)}
                  disabled={printingUnit === unit.id}
                  className="text-xs rounded border border-slate-200 px-2 py-1.5 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                >
                  {printingUnit === unit.id ? "..." : "Печать этикетки"}
                </button>
                <button
                  type="button"
                  onClick={() => setEditUnit(unit)}
                  className="text-xs rounded border border-slate-200 px-2 py-1.5 text-slate-600 hover:bg-slate-50"
                >
                  Изменить
                </button>
                {unit.status === "AVAILABLE" && (
                  <button
                    type="button"
                    onClick={() => setDeleteUnit(unit)}
                    className="text-xs rounded border border-rose-200 px-2 py-1.5 text-rose-600 hover:bg-rose-50"
                  >
                    Удалить
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Footer count */}
      {!loading && units.length > 0 && (
        <p className="mt-3 text-xs text-slate-400 text-right">Всего единиц: {units.length}</p>
      )}

      {/* Modals */}
      {showGenerate && (
        <GenerateModal
          equipmentId={equipmentId}
          onClose={() => setShowGenerate(false)}
          onGenerated={loadData}
        />
      )}
      {editUnit && (
        <EditModal
          unit={editUnit}
          equipmentId={equipmentId}
          onClose={() => setEditUnit(null)}
          onSaved={loadData}
        />
      )}
      {deleteUnit && (
        <DeleteConfirm
          unit={deleteUnit}
          equipmentId={equipmentId}
          onClose={() => setDeleteUnit(null)}
          onDeleted={loadData}
        />
      )}
    </div>
  );
}
