"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useRequireRole } from "@/hooks/useRequireRole";
import { AdminTabNav } from "@/components/admin/AdminTabNav";
import { formatMoneyRub } from "@/lib/format";
import { toast } from "@/components/ToastProvider";

// ── Types ──────────────────────────────────────────────────────────────────────

type VehicleRow = {
  id: string;
  slug: string;
  name: string;
  shiftPriceRub: string;
  hasGeneratorOption: boolean;
  generatorPriceRub: string | null;
  shiftHours: number;
  overtimePercent: string;
  displayOrder: number;
  active: boolean;
};

type EditForm = {
  shiftPriceRub: number;
  generatorPriceRub: number | null;
  shiftHours: number;
  overtimePercent: number;
  active: boolean;
  displayOrder: number;
};

// ── VehicleEditModal ───────────────────────────────────────────────────────────

function VehicleEditModal({
  vehicle,
  onClose,
  onSaved,
}: {
  vehicle: VehicleRow;
  onClose: () => void;
  onSaved: (updated: VehicleRow) => void;
}) {
  const [form, setForm] = useState<EditForm>({
    shiftPriceRub: Number(vehicle.shiftPriceRub),
    generatorPriceRub: vehicle.generatorPriceRub ? Number(vehicle.generatorPriceRub) : null,
    shiftHours: vehicle.shiftHours,
    overtimePercent: Number(vehicle.overtimePercent),
    active: vehicle.active,
    displayOrder: vehicle.displayOrder,
  });
  const [saving, setSaving] = useState(false);

  function setField<K extends keyof EditForm>(key: K, value: EditForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        shiftPriceRub: form.shiftPriceRub,
        shiftHours: form.shiftHours,
        overtimePercent: form.overtimePercent,
        active: form.active,
        displayOrder: form.displayOrder,
      };
      if (vehicle.hasGeneratorOption) {
        body.generatorPriceRub = form.generatorPriceRub;
      }
      const res = await apiFetch<{ vehicle: VehicleRow }>(`/api/vehicles/admin/${vehicle.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      toast.success("Сохранено");
      onSaved(res.vehicle);
      onClose();
    } catch (err: unknown) {
      toast.error((err as { message?: string })?.message ?? "Ошибка сохранения");
    } finally {
      setSaving(false);
    }
  }

  function handleBackdrop(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={handleBackdrop}
    >
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold text-ink">Редактировать: {vehicle.name}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-ink-3 hover:text-ink"
            aria-label="Закрыть"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-3">
          {/* shiftPriceRub */}
          <div>
            <label className="mb-1 block text-xs text-ink-2">Ставка смены, ₽</label>
            <input
              type="number"
              min={0}
              value={form.shiftPriceRub}
              onChange={(e) => setField("shiftPriceRub", Number(e.target.value))}
              className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
            />
          </div>

          {/* generatorPriceRub (only if hasGeneratorOption) */}
          {vehicle.hasGeneratorOption && (
            <div>
              <label className="mb-1 block text-xs text-ink-2">Стоимость генератора, ₽</label>
              <input
                type="number"
                min={0}
                value={form.generatorPriceRub ?? 0}
                onChange={(e) => setField("generatorPriceRub", Number(e.target.value))}
                className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
              />
            </div>
          )}

          {/* shiftHours */}
          <div>
            <label className="mb-1 block text-xs text-ink-2">Часы смены</label>
            <input
              type="number"
              min={1}
              max={24}
              value={form.shiftHours}
              onChange={(e) => setField("shiftHours", Number(e.target.value))}
              className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
            />
          </div>

          {/* overtimePercent */}
          <div>
            <label className="mb-1 block text-xs text-ink-2">Процент переработки, %</label>
            <input
              type="number"
              min={0}
              max={100}
              value={form.overtimePercent}
              onChange={(e) => setField("overtimePercent", Number(e.target.value))}
              className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
            />
          </div>

          {/* displayOrder */}
          <div>
            <label className="mb-1 block text-xs text-ink-2">Порядок отображения</label>
            <input
              type="number"
              min={0}
              value={form.displayOrder}
              onChange={(e) => setField("displayOrder", Number(e.target.value))}
              className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
            />
          </div>

          {/* active */}
          <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => setField("active", e.target.checked)}
              className="h-4 w-4 accent-accent"
            />
            <span>Активна / видна в форме брони</span>
          </label>
        </div>

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="flex-1 rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-bright disabled:opacity-50"
          >
            {saving ? "Сохраняю..." : "Сохранить"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-border px-4 py-2 text-sm text-ink-2 hover:bg-surface-muted"
          >
            Отмена
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function AdminVehiclesPage() {
  const { authorized, loading: authLoading } = useRequireRole(["SUPER_ADMIN"]);

  const [vehicles, setVehicles] = useState<VehicleRow[] | null>(null);
  const [loadingVehicles, setLoadingVehicles] = useState(true);
  const [editingVehicle, setEditingVehicle] = useState<VehicleRow | null>(null);

  useEffect(() => {
    if (!authorized) return;
    let cancelled = false;
    apiFetch<{ vehicles: VehicleRow[] }>("/api/vehicles/admin")
      .then((res) => { if (!cancelled) setVehicles(res.vehicles); })
      .catch(() => { if (!cancelled) setVehicles([]); })
      .finally(() => { if (!cancelled) setLoadingVehicles(false); });
    return () => { cancelled = true; };
  }, [authorized]);

  function handleSaved(updated: VehicleRow) {
    setVehicles((prev) => prev ? prev.map((v) => v.id === updated.id ? updated : v) : prev);
  }

  if (authLoading) {
    return (
      <div className="p-6 space-y-6">
        <AdminTabNav />
        <div className="h-40 animate-pulse rounded-lg bg-surface-muted" />
      </div>
    );
  }

  if (!authorized) return null;

  return (
    <div className="p-6 space-y-6">
      <AdminTabNav />

      <div>
        <p className="eyebrow mb-1">Транспорт</p>
        <h1 className="text-lg font-semibold text-ink">Управление машинами</h1>
        <p className="mt-1 text-xs text-ink-3">
          Здесь можно изменить ставку смены, стоимость генератора и другие параметры.
        </p>
      </div>

      {loadingVehicles ? (
        <div className="h-40 animate-pulse rounded-lg bg-surface-muted" />
      ) : !vehicles || vehicles.length === 0 ? (
        <p className="text-sm text-ink-3">Машины не найдены. Запустите seed.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-xs">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-surface-muted">
              <tr>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-ink-3">Порядок</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-ink-3">Машина</th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-ink-3">Ставка смены</th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-ink-3">Генератор</th>
                <th className="px-4 py-2.5 text-center text-xs font-medium text-ink-3">Часы смены</th>
                <th className="px-4 py-2.5 text-center text-xs font-medium text-ink-3">Активна</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {vehicles.map((vehicle, idx) => (
                <tr
                  key={vehicle.id}
                  className={idx % 2 === 0 ? "bg-surface" : "bg-surface-muted/30"}
                >
                  <td className="px-4 py-3 text-ink-3">{vehicle.displayOrder}</td>
                  <td className="px-4 py-3 font-medium text-ink">{vehicle.name}</td>
                  <td className="px-4 py-3 text-right font-mono text-ink">
                    {formatMoneyRub(Number(vehicle.shiftPriceRub))} ₽
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-ink-2">
                    {vehicle.hasGeneratorOption && vehicle.generatorPriceRub
                      ? `+${formatMoneyRub(Number(vehicle.generatorPriceRub))} ₽`
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-center text-ink-2">{vehicle.shiftHours} ч.</td>
                  <td className="px-4 py-3 text-center">
                    {vehicle.active ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald/10 px-2 py-0.5 text-[11px] text-emerald">
                        ✓ Да
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-surface-muted px-2 py-0.5 text-[11px] text-ink-3">
                        Нет
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => setEditingVehicle(vehicle)}
                      className="rounded border border-border px-3 py-1.5 text-xs text-ink-2 hover:border-accent hover:text-accent"
                    >
                      Редактировать
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editingVehicle && (
        <VehicleEditModal
          vehicle={editingVehicle}
          onClose={() => setEditingVehicle(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
