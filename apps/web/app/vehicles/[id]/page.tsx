"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

import { apiFetch } from "../../../src/lib/api";
import { SectionHeader } from "../../../src/components/SectionHeader";
import { StatusPill } from "../../../src/components/StatusPill";
import { useRequireRole } from "../../../src/hooks/useRequireRole";

// ── Types ────────────────────────────────────────────────────────────────────

type ServiceKind =
  | "SCHEDULED_TO"
  | "OIL_CHANGE"
  | "TIRE_CHANGE"
  | "REPAIR"
  | "INSPECTION"
  | "OTHER";

interface VehicleHead {
  id: string;
  name: string;
  slug: string;
  licensePlate: string | null;
  currentMileage: number;
  lastServiceAt: string | null;
  lastServiceMileage: number | null;
  lastServiceKind: ServiceKind | null;
  notes: string | null;
  active: boolean;
  shiftPriceRub: string;
  shiftHours: number;
}

interface MileageLog {
  id: string;
  mileage: number;
  recordedAt: string;
  bookingId: string | null;
  source: "RETURN" | "MANUAL";
  recordedBy: string;
  note: string | null;
}

interface ServiceLog {
  id: string;
  kind: ServiceKind;
  performedAt: string;
  mileage: number | null;
  description: string;
  cost: string | null;
  documentUrl: string | null;
  createdBy: string;
}

interface DetailResponse {
  vehicle: VehicleHead;
  mileageLogs: MileageLog[];
  serviceLogs: ServiceLog[];
}

// ── Constants ────────────────────────────────────────────────────────────────

const SERVICE_KIND_LABEL: Record<ServiceKind, string> = {
  SCHEDULED_TO: "Плановое ТО",
  OIL_CHANGE: "Замена масла",
  TIRE_CHANGE: "Шиномонтаж",
  REPAIR: "Ремонт",
  INSPECTION: "Диагностика",
  OTHER: "Прочее",
};

const SERVICE_KIND_OPTIONS: { value: ServiceKind; label: string }[] = (
  Object.keys(SERVICE_KIND_LABEL) as ServiceKind[]
).map((k) => ({ value: k, label: SERVICE_KIND_LABEL[k] }));

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatKm(n: number | null): string {
  if (n === null) return "—";
  return n.toLocaleString("ru-RU") + " км";
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Moscow",
  });
}

function formatRub(value: string | null): string {
  if (!value) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString("ru-RU") + " ₽";
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Component ────────────────────────────────────────────────────────────────

export default function VehicleDetailPage() {
  const params = useParams<{ id: string }>();
  const vehicleId = params?.id ?? "";
  const { user, loading: roleLoading } = useRequireRole([
    "SUPER_ADMIN",
    "WAREHOUSE",
    "TECHNICIAN",
  ]);
  const canEdit = user?.role === "SUPER_ADMIN" || user?.role === "WAREHOUSE";

  const [data, setData] = useState<DetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const fresh = await apiFetch<DetailResponse>(`/api/vehicles/fleet/${vehicleId}`);
      setData(fresh);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить машину");
    }
  }, [vehicleId]);

  useEffect(() => {
    if (roleLoading || !user || !vehicleId) return;
    let cancelled = false;
    void (async () => {
      try {
        const fresh = await apiFetch<DetailResponse>(`/api/vehicles/fleet/${vehicleId}`);
        if (cancelled) return;
        setData(fresh);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Не удалось загрузить машину");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vehicleId, roleLoading, user]);

  if (roleLoading || !user) return <div className="p-8 text-ink-3">Загрузка...</div>;
  if (error)
    return (
      <div className="p-8">
        <Link className="text-sm text-accent-bright" href="/vehicles">
          ← Назад к автопарку
        </Link>
        <p className="mt-3 rounded-md border border-rose-border bg-rose-soft px-3 py-2 text-rose text-sm">
          {error}
        </p>
      </div>
    );
  if (!data) return <div className="p-8 text-ink-3">Загрузка...</div>;

  const { vehicle, mileageLogs, serviceLogs } = data;

  return (
    <div className="p-4 max-w-5xl">
      <Link className="text-sm text-accent-bright hover:text-accent" href="/vehicles">
        ← Назад к автопарку
      </Link>

      <SectionHeader
        eyebrow="Машина"
        title={vehicle.name}
        actions={
          vehicle.active ? (
            <StatusPill variant="ok" label="Активна" />
          ) : (
            <StatusPill variant="none" label="Не активна" />
          )
        }
      />

      {/* Шапка */}
      <section className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card label="Текущий пробег" value={formatKm(vehicle.currentMileage)} valueClass="mono-num" />
        <Card
          label="Последнее ТО / ремонт"
          value={vehicle.lastServiceAt ? formatDate(vehicle.lastServiceAt) : "—"}
          sub={
            vehicle.lastServiceKind
              ? SERVICE_KIND_LABEL[vehicle.lastServiceKind]
              : null
          }
        />
        <Card
          label="Гос. номер"
          value={vehicle.licensePlate?.trim() || "—"}
          valueClass="mono-num"
        />
      </section>

      {vehicle.notes && (
        <section className="mt-3 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink-2">
          <p className="eyebrow mb-1">Заметки</p>
          <p className="whitespace-pre-wrap">{vehicle.notes}</p>
        </section>
      )}

      {canEdit && (
        <VehicleEditPanel
          vehicleId={vehicle.id}
          initialLicensePlate={vehicle.licensePlate}
          initialNotes={vehicle.notes}
          onSaved={refetch}
        />
      )}

      {/* Журнал пробега */}
      <section className="mt-6">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-medium text-ink">Журнал пробега</h2>
          {canEdit && (
            <AddMileageForm
              vehicleId={vehicle.id}
              currentMileage={vehicle.currentMileage}
              onAdded={refetch}
            />
          )}
        </div>
        <div className="mt-2 rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
          {mileageLogs.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-ink-3">
              Записей пробега пока нет.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate--soft text-ink-2 border-b border-border">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Дата</th>
                  <th className="text-right px-3 py-2 font-medium">Пробег</th>
                  <th className="text-left px-3 py-2 font-medium">Источник</th>
                  <th className="text-left px-3 py-2 font-medium">Кто</th>
                  <th className="text-left px-3 py-2 font-medium">Заметка</th>
                </tr>
              </thead>
              <tbody>
                {mileageLogs.map((m) => (
                  <tr key={m.id} className="border-t border-border">
                    <td className="px-3 py-2 mono-num text-ink-2">{formatDate(m.recordedAt)}</td>
                    <td className="px-3 py-2 mono-num text-right text-ink">{formatKm(m.mileage)}</td>
                    <td className="px-3 py-2 text-ink-2">
                      {m.source === "RETURN" ? (
                        <span>На возврате брони{m.bookingId ? <> · <Link className="text-accent-bright hover:text-accent" href={`/bookings/${m.bookingId}`}>открыть</Link></> : null}</span>
                      ) : (
                        "Вручную"
                      )}
                    </td>
                    <td className="px-3 py-2 text-ink-2">{m.recordedBy}</td>
                    <td className="px-3 py-2 text-ink-2">{m.note ?? <span className="text-ink-3">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* Журнал ТО / ремонтов */}
      <section className="mt-6">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-medium text-ink">Журнал ТО и ремонтов</h2>
          {canEdit && (
            <AddServiceForm
              vehicleId={vehicle.id}
              currentMileage={vehicle.currentMileage}
              onAdded={refetch}
            />
          )}
        </div>
        <div className="mt-2 rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
          {serviceLogs.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-ink-3">
              Записей обслуживания пока нет.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {serviceLogs.map((s) => (
                <li key={s.id} className="px-3 py-3">
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-1">
                    <div>
                      <p className="text-sm text-ink font-medium">
                        {SERVICE_KIND_LABEL[s.kind]}
                        <span className="ml-2 text-xs text-ink-3 mono-num">
                          {formatDate(s.performedAt)}
                        </span>
                        {s.mileage !== null && (
                          <span className="ml-2 text-xs text-ink-3 mono-num">
                            · {formatKm(s.mileage)}
                          </span>
                        )}
                      </p>
                      <p className="mt-1 text-sm text-ink-2 whitespace-pre-wrap">
                        {s.description}
                      </p>
                    </div>
                    <div className="text-right text-sm">
                      {s.cost && (
                        <p className="mono-num text-ink">{formatRub(s.cost)}</p>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function Card({
  label,
  value,
  sub,
  valueClass,
}: {
  label: string;
  value: string;
  sub?: string | null;
  valueClass?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-3 shadow-xs">
      <p className="eyebrow">{label}</p>
      <p className={`mt-1 text-lg text-ink ${valueClass ?? ""}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-ink-3">{sub}</p>}
    </div>
  );
}

function VehicleEditPanel({
  vehicleId,
  initialLicensePlate,
  initialNotes,
  onSaved,
}: {
  vehicleId: string;
  initialLicensePlate: string | null;
  initialNotes: string | null;
  onSaved: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [plate, setPlate] = useState(initialLicensePlate ?? "");
  const [notes, setNotes] = useState(initialNotes ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await apiFetch(`/api/vehicles/fleet/${vehicleId}/meta`, {
        method: "PATCH",
        body: JSON.stringify({
          licensePlate: plate.trim() || null,
          notes: notes.trim() || null,
        }),
      });
      await onSaved();
      setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="mt-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-xs text-accent-bright hover:text-accent font-medium"
        >
          Редактировать гос. номер / заметки
        </button>
      </div>
    );
  }

  return (
    <section className="mt-3 rounded-lg border border-border bg-surface p-3 shadow-xs">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="eyebrow mb-1 block">Гос. номер</label>
          <input
            type="text"
            value={plate}
            onChange={(e) => setPlate(e.target.value)}
            className="mono-num w-full rounded border border-border px-2 py-1 text-sm bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-accent"
            placeholder="А 123 БВ 77"
          />
        </div>
        <div>
          <label className="eyebrow mb-1 block">Заметки</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full rounded border border-border px-2 py-1 text-sm bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-accent"
            rows={3}
            placeholder="VIN, страховка, особенности…"
          />
        </div>
      </div>
      {err && <p className="mt-2 text-xs text-rose">{err}</p>}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded bg-accent-bright text-white px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
        >
          {busy ? "Сохраняем..." : "Сохранить"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded border border-border px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-muted"
        >
          Отмена
        </button>
      </div>
    </section>
  );
}

function AddMileageForm({
  vehicleId,
  currentMileage,
  onAdded,
}: {
  vehicleId: string;
  currentMileage: number;
  onAdded: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [mileage, setMileage] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function reset() {
    setMileage("");
    setNote("");
    setErr(null);
    setOpen(false);
  }

  async function submit() {
    const n = Number.parseInt(mileage, 10);
    if (!Number.isFinite(n) || n < currentMileage) {
      setErr(`Введите целое число ≥ ${currentMileage}`);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await apiFetch(`/api/vehicles/fleet/${vehicleId}/mileage`, {
        method: "POST",
        body: JSON.stringify({
          mileage: n,
          note: note.trim() || null,
        }),
      });
      await onAdded();
      reset();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Не удалось записать пробег");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs rounded border border-border px-3 py-1.5 text-ink-2 hover:bg-surface-muted"
      >
        + Записать пробег
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-2 shadow-xs flex flex-wrap items-end gap-2">
      <div>
        <label className="eyebrow mb-1 block">Пробег, км</label>
        <input
          type="number"
          inputMode="numeric"
          min={currentMileage}
          step={1}
          value={mileage}
          onChange={(e) => setMileage(e.target.value)}
          placeholder={`≥ ${currentMileage}`}
          className="mono-num w-32 rounded border border-border px-2 py-1 text-sm bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>
      <div className="flex-1 min-w-[160px]">
        <label className="eyebrow mb-1 block">Заметка</label>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Не обязательно"
          className="w-full rounded border border-border px-2 py-1 text-sm bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>
      <button
        type="button"
        onClick={submit}
        disabled={busy}
        className="rounded bg-accent-bright text-white px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
      >
        {busy ? "..." : "Сохранить"}
      </button>
      <button
        type="button"
        onClick={reset}
        className="rounded border border-border px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-muted"
      >
        Отмена
      </button>
      {err && <p className="basis-full text-xs text-rose">{err}</p>}
    </div>
  );
}

function AddServiceForm({
  vehicleId,
  currentMileage,
  onAdded,
}: {
  vehicleId: string;
  currentMileage: number;
  onAdded: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ServiceKind>("SCHEDULED_TO");
  const [performedAt, setPerformedAt] = useState<string>(todayIso());
  const [mileage, setMileage] = useState<string>(String(currentMileage));
  const [description, setDescription] = useState<string>("");
  const [cost, setCost] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function reset() {
    setKind("SCHEDULED_TO");
    setPerformedAt(todayIso());
    setMileage(String(currentMileage));
    setDescription("");
    setCost("");
    setErr(null);
    setOpen(false);
  }

  async function submit() {
    if (description.trim().length < 3) {
      setErr("Опишите, что было сделано (минимум 3 символа)");
      return;
    }
    const performedAtIso = new Date(`${performedAt}T00:00:00.000Z`).toISOString();
    const mileageNum = mileage.trim() === "" ? null : Number.parseInt(mileage, 10);
    if (mileageNum !== null && (!Number.isFinite(mileageNum) || mileageNum < 0)) {
      setErr("Пробег должен быть целым числом ≥ 0 или пустым");
      return;
    }
    const costNum = cost.trim() === "" ? null : Number.parseFloat(cost);
    if (costNum !== null && (!Number.isFinite(costNum) || costNum < 0)) {
      setErr("Стоимость должна быть числом ≥ 0 или пустой");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await apiFetch(`/api/vehicles/fleet/${vehicleId}/service`, {
        method: "POST",
        body: JSON.stringify({
          kind,
          performedAt: performedAtIso,
          mileage: mileageNum,
          description: description.trim(),
          cost: costNum,
        }),
      });
      await onAdded();
      reset();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Не удалось сохранить запись");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs rounded border border-border px-3 py-1.5 text-ink-2 hover:bg-surface-muted"
      >
        + Запись ТО / ремонта
      </button>
    );
  }

  return (
    <div className="basis-full rounded-lg border border-border bg-surface p-3 shadow-xs">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="eyebrow mb-1 block">Тип</label>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as ServiceKind)}
            className="w-full rounded border border-border px-2 py-1 text-sm bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-accent"
          >
            {SERVICE_KIND_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="eyebrow mb-1 block">Дата</label>
          <input
            type="date"
            value={performedAt}
            onChange={(e) => setPerformedAt(e.target.value)}
            className="w-full rounded border border-border px-2 py-1 text-sm bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
        <div>
          <label className="eyebrow mb-1 block">Пробег на момент, км</label>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={mileage}
            onChange={(e) => setMileage(e.target.value)}
            className="mono-num w-full rounded border border-border px-2 py-1 text-sm bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
        <div>
          <label className="eyebrow mb-1 block">Стоимость, ₽</label>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step={1}
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            placeholder="Не обязательно"
            className="mono-num w-full rounded border border-border px-2 py-1 text-sm bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
        <div className="md:col-span-2">
          <label className="eyebrow mb-1 block">Что делали</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Замена масла, фильтров, диагностика…"
            className="w-full rounded border border-border px-2 py-1 text-sm bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
      </div>
      {err && <p className="mt-2 text-xs text-rose">{err}</p>}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="rounded bg-accent-bright text-white px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
        >
          {busy ? "Сохраняем..." : "Сохранить"}
        </button>
        <button
          type="button"
          onClick={reset}
          className="rounded border border-border px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-muted"
        >
          Отмена
        </button>
      </div>
    </div>
  );
}
