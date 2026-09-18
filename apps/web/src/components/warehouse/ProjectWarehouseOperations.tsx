"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiFetch } from "../../lib/api";
import { getWarehouseToken } from "./api";
import {
  projectButton as btn,
  projectPrimary as primary,
  projectInput as input,
  todayMoscow,
  shortProjectDate,
} from "../bookings/project/types";

type Operation = {
  id: string;
  bookingId: string;
  revision: number;
  name: string;
  projectName: string;
  clientName: string;
  status: string;
  fromDate: string;
  throughDate: string;
  quantity: number;
  remaining: number;
  trackingMode: string;
  units: Array<{ id: string; label: string }>;
};
export function ProjectWarehouseOperations({ tab }: { tab: string }) {
  const [rows, setRows] = useState<Operation[]>([]);
  const [selected, setSelected] = useState<Operation | null>(null);
  const [units, setUnits] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const headers = () => {
    const token = getWarehouseToken();
    return token ? { Authorization: `Bearer ${token}` } : undefined;
  };
  const load = useCallback(async () => {
    try {
      const d = await apiFetch<{ operations: Operation[] }>(
        "/api/warehouse/project-operations",
        { headers: headers() },
      );
      setRows(d.operations);
      setError("");
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Не удалось загрузить поставки проектов",
      );
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, tab]);
  if (!["shift", "issue", "return", "inwork"].includes(tab)) return null;
  const visible = rows.filter((r) =>
    tab === "issue"
      ? r.status === "PLANNED"
      : tab === "return" || tab === "inwork"
        ? r.status === "ISSUED"
        : r.status === "PLANNED"
          ? r.fromDate <= todayMoscow()
          : r.throughDate <= todayMoscow(),
  );
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selected || busy) return;
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      await apiFetch(
        `/api/warehouse/project-operations/${selected.bookingId}/${selected.id}/${selected.status === "PLANNED" ? "issue" : "return"}`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({
            revision: selected.revision,
            date: f.get("date"),
            quantity:
              selected.status === "PLANNED"
                ? selected.quantity
                : selected.trackingMode === "UNIT"
                  ? units.length
                  : Number(f.get("quantity")),
            unitIds: units,
            condition: f.get("condition") || "OK",
            reason: f.get("reason") || undefined,
          }),
        },
      );
      setSelected(null);
      setUnits([]);
      await load();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Не удалось подтвердить операцию",
      );
    } finally {
      setBusy(false);
    }
  }
  if (!visible.length && !error) return null;
  return (
    <section className="m-4 rounded-lg border border-border bg-surface p-4 lg:mx-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium text-ink">
          Поставки длинных проектов · {visible.length}
        </h2>
        <button
          type="button"
          className={btn}
          onClick={() => {
            setSelected(null);
            void load();
          }}
        >
          Обновить
        </button>
      </div>
      {error && (
        <p className="mb-3 text-sm text-rose" role="alert">
          {error}
        </p>
      )}
      <div className="space-y-2">
        {visible.map((r) => (
          <div
            key={r.id}
            className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3"
          >
            <div>
              <p className="text-sm font-medium">
                {r.projectName} · {r.name} ×{" "}
                {r.status === "PLANNED" ? r.quantity : r.remaining}
              </p>
              <p className="text-xs text-ink-3">
                {r.clientName} ·{" "}
                {r.status === "PLANNED" ? "Выдача" : "План возврата"}:{" "}
                {shortProjectDate(
                  r.status === "PLANNED" ? r.fromDate : r.throughDate,
                )}
              </p>
            </div>
            <button
              type="button"
              className={btn}
              disabled={busy}
              onClick={() => {
                setSelected(r);
                setUnits([]);
                setError("");
              }}
            >
              {r.status === "PLANNED"
                ? "Выдать поставку"
                : "Принять часть / всё"}
            </button>
          </div>
        ))}
      </div>
      {selected && (
        <form
          key={selected.id}
          onSubmit={submit}
          className="mt-4 space-y-3 rounded border border-accent-border bg-accent-soft p-4"
        >
          <p className="text-sm font-medium">
            {selected.name} ·{" "}
            {selected.status === "PLANNED"
              ? "Подтверждение выдачи"
              : "Подтверждение приёмки"}
          </p>
          <label className="block text-sm">
            {selected.status === "PLANNED" ? "Первый" : "Последний"}{" "}
            оплачиваемый день
            <input
              type="date"
              name="date"
              defaultValue={todayMoscow()}
              max={todayMoscow()}
              className={input}
              required
            />
          </label>
          {selected.status === "ISSUED" &&
            selected.trackingMode === "COUNT" && (
              <label className="block text-sm">
                Количество
                <input
                  type="number"
                  name="quantity"
                  min={1}
                  max={selected.remaining}
                  defaultValue={1}
                  className={input}
                  required
                />
              </label>
            )}
          {selected.trackingMode === "UNIT" && (
            <fieldset>
              <legend className="text-sm">
                Экземпляры · выбрано {units.length}
              </legend>
              {selected.units.map((u) => (
                <label
                  key={u.id}
                  className="flex min-h-11 items-center gap-3 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={units.includes(u.id)}
                    onChange={(e) =>
                      setUnits((old) =>
                        e.target.checked
                          ? [...old, u.id]
                          : old.filter((x) => x !== u.id),
                      )
                    }
                  />
                  {u.label}
                </label>
              ))}
            </fieldset>
          )}
          {selected.status === "ISSUED" && (
            <>
              <label className="block text-sm">
                Состояние
                <select className={input} name="condition">
                  <option value="OK">Исправное</option>
                  <option value="REPAIR">В ремонт</option>
                  <option value="MISSING">Недостача</option>
                </select>
              </label>
              <label className="block text-sm">
                Причина повреждения / недостачи
                <input className={input} name="reason" maxLength={500} />
              </label>
            </>
          )}
          <p className="text-xs text-ink-3">
            Подтверждайте только эту поставку. Остальная техника проекта
            продолжает числиться у клиента.
          </p>
          <div className="flex flex-wrap gap-2">
            <button className={primary} disabled={busy}>
              {busy ? "Сохраняем…" : "Подтвердить"}
            </button>
            <button
              type="button"
              className={btn}
              disabled={busy}
              onClick={() => setSelected(null)}
            >
              Отмена
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
