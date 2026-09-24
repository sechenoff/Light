"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { useRequireRole } from "@/hooks/useRequireRole";
import { AdminShell } from "@/components/admin/AdminShell";
import { StatusPill } from "@/components/StatusPill";
import { SectionHeader } from "@/components/SectionHeader";
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saving, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/30 p-4"
      onClick={handleBackdrop}
      aria-modal="true"
      role="dialog"
      aria-labelledby="vehicle-edit-title"
    >
      <div className="w-full max-w-sm max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-lg border border-border bg-surface p-5 sm:p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="vehicle-edit-title" className="font-semibold text-ink">Редактировать: {vehicle.name}</h2>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-ink-3 hover:bg-surface-muted hover:text-ink"
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
            className="flex-1 rounded bg-accent px-4 py-2 text-sm font-medium text-surface hover:bg-accent-bright disabled:opacity-50"
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
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [editingVehicle, setEditingVehicle] = useState<VehicleRow | null>(null);

  useEffect(() => {
    if (!authorized) return;
    let cancelled = false;
    setLoadingVehicles(true);
    setLoadError(false);
    apiFetch<{ vehicles: VehicleRow[] }>("/api/vehicles/admin")
      .then((res) => { if (!cancelled) setVehicles(res.vehicles); })
      .catch(() => { if (!cancelled) { setVehicles(null); setLoadError(true); } })
      .finally(() => { if (!cancelled) setLoadingVehicles(false); });
    return () => { cancelled = true; };
  }, [authorized, reloadKey]);

  function handleSaved(updated: VehicleRow) {
    setVehicles((prev) => prev ? prev.map((v) => v.id === updated.id ? updated : v) : prev);
  }

  if (authLoading) {
    return (
      <AdminShell>
        <div className="h-40 animate-pulse rounded-lg bg-surface-subtle" />
      </AdminShell>
    );
  }

  if (!authorized) return null;

  return (
    <AdminShell>
      <div className="space-y-6">

      <div>
        <SectionHeader
          eyebrow="Транспорт"
          title="Управление машинами"
          actions={
            <Link
              href="/vehicles"
              className="inline-flex min-h-8 items-center text-xs font-medium text-accent-bright hover:text-accent"
            >
              Автопарк и журнал →
            </Link>
          }
        />
        <p className="mt-1 text-sm text-ink-2">
          Здесь можно изменить ставку смены, стоимость генератора и другие параметры.
        </p>
      </div>

      {loadingVehicles ? (
        <div className="h-40 animate-pulse rounded-lg bg-surface-subtle" />
      ) : loadError ? (
        <div className="rounded-lg border border-rose-border bg-rose-soft px-6 py-10 text-center">
          <p className="text-sm font-semibold text-rose">Не удалось загрузить список машин</p>
          <p className="mt-1 text-xs text-ink-3">Проверьте соединение с интернетом и попробуйте ещё раз.</p>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="mt-4 rounded border border-border bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-surface-muted transition-colors"
          >
            Повторить
          </button>
        </div>
      ) : !vehicles || vehicles.length === 0 ? (
        <p className="text-sm text-ink-3">Машины пока не добавлены.</p>
      ) : (
        <>
        {/* Телефон: список вместо таблицы — все параметры и «Изменить» без прокрутки вбок */}
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface shadow-xs md:hidden">
          {vehicles.map((vehicle) => (
            <li key={vehicle.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-ink">{vehicle.name}</p>
                <p className="mt-0.5 text-xs tabular-nums text-ink-2">
                  {formatMoneyRub(Number(vehicle.shiftPriceRub))}&nbsp;₽ · {vehicle.shiftHours}&nbsp;ч.
                  {vehicle.hasGeneratorOption && vehicle.generatorPriceRub
                    ? ` · ген. +${formatMoneyRub(Number(vehicle.generatorPriceRub))}\u00a0₽`
                    : ""}
                </p>
              </div>
              <StatusPill variant={vehicle.active ? "ok" : "none"} label={vehicle.active ? "Активна" : "Скрыта"} />
              <button
                type="button"
                onClick={() => setEditingVehicle(vehicle)}
                className="h-10 shrink-0 rounded border border-border px-3 text-xs text-ink-2 hover:border-accent hover:text-accent"
              >
                Изменить
              </button>
            </li>
          ))}
        </ul>
        <div className="hidden md:block overflow-x-auto rounded-lg border border-border bg-surface shadow-xs">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-surface-muted">
              <tr>
                <th className="hidden xl:table-cell px-3 xl:px-4 py-2.5 text-left eyebrow whitespace-nowrap">Порядок</th>
                <th className="px-3 xl:px-4 py-2.5 text-left eyebrow whitespace-nowrap">Машина</th>
                <th className="px-3 xl:px-4 py-2.5 text-right eyebrow whitespace-nowrap">Ставка смены</th>
                <th className="px-3 xl:px-4 py-2.5 text-right eyebrow whitespace-nowrap">Генератор</th>
                <th className="px-3 xl:px-4 py-2.5 text-center eyebrow whitespace-nowrap">Часы смены</th>
                <th className="px-3 xl:px-4 py-2.5 text-center eyebrow whitespace-nowrap">Активна</th>
                <th className="px-3 xl:px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {vehicles.map((vehicle, idx) => (
                <tr
                  key={vehicle.id}
                  className={idx % 2 === 0 ? "bg-surface" : "bg-surface-muted/30"}
                >
                  <td className="hidden xl:table-cell px-3 xl:px-4 py-3 text-ink-3">{vehicle.displayOrder}</td>
                  <td className="px-3 xl:px-4 py-3 font-medium text-ink">{vehicle.name}</td>
                  <td className="px-3 xl:px-4 py-3 text-right mono-num text-ink whitespace-nowrap">
                    {formatMoneyRub(Number(vehicle.shiftPriceRub))}&nbsp;₽
                  </td>
                  <td className="px-3 xl:px-4 py-3 text-right mono-num text-ink-2 whitespace-nowrap">
                    {vehicle.hasGeneratorOption && vehicle.generatorPriceRub
                      ? `+${formatMoneyRub(Number(vehicle.generatorPriceRub))}\u00a0₽`
                      : "—"}
                  </td>
                  <td className="px-3 xl:px-4 py-3 text-center text-ink-2 mono-num whitespace-nowrap">{vehicle.shiftHours}&nbsp;ч.</td>
                  <td className="px-3 xl:px-4 py-3 text-center">
                    {vehicle.active ? (
                      <StatusPill variant="ok" label="Да" />
                    ) : (
                      <StatusPill variant="none" label="Нет" />
                    )}
                  </td>
                  <td className="px-3 xl:px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => setEditingVehicle(vehicle)}
                      aria-label={`Изменить: ${vehicle.name}`}
                      className="whitespace-nowrap rounded border border-border px-3 py-1.5 text-xs text-ink-2 hover:border-accent hover:text-accent"
                    >
                      Изменить
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
      </div>

      {/* Модалка — вне space-y-6: иначе fixed-подложка получает margin-top и сверху
          остаётся незатемнённая полоса. */}
      {editingVehicle && (
        <VehicleEditModal
          vehicle={editingVehicle}
          onClose={() => setEditingVehicle(null)}
          onSaved={handleSaved}
        />
      )}
    </AdminShell>
  );
}
