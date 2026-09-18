"use client";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { apiFetch } from "../../../lib/api";
import { ModalViewport } from "../../ModalViewport";
import {
  projectButton as btn,
  projectInput as input,
  projectPrimary as primary,
  projectMoney as money,
  todayMoscow,
  type ProjectData,
  type ProjectLot,
  type ProjectLine,
} from "./types";

export type ProjectAction =
  | "ADD"
  | "ISSUE"
  | "RETURN"
  | "EXTEND"
  | "CANCEL"
  | "CALENDAR"
  | "CLOSE"
  | "PAYMENT"
  | "CHARGE"
  | "CORRECTION"
  | "CONFIRM"
  | "FINISH"
  | "CANCEL_PROJECT";
const titles: Record<ProjectAction, string> = {
  ADD: "Новая поставка / добор",
  ISSUE: "Подтвердить выдачу",
  RETURN: "Частичный возврат",
  EXTEND: "Продлить поставку",
  CANCEL: "Отменить поставку",
  CALENDAR: "Заполнить календарь",
  CLOSE: "Закрыть расчётный период",
  PAYMENT: "Принять оплату / аванс",
  CHARGE: "Добавить доставку или услугу",
  CORRECTION: "Корректировка периода",
  CONFIRM: "Забронировать проект",
  FINISH: "Завершить складской цикл",
  CANCEL_PROJECT: "Отменить проект",
};
function Field({ title, children }: { title: string; children: ReactNode }) {
  return (
    <label className="block text-sm text-ink">
      {title}
      {children}
    </label>
  );
}

type CatalogRow = {
  equipment: {
    id: string;
    name: string;
    stockTrackingMode: string;
    rentalRatePerShift: string;
  };
  availableQuantity: number;
};
export function ProjectActionDialog({
  project: p,
  action,
  lot,
  periodId,
  onClose,
  onSaved,
}: {
  project: ProjectData;
  action: ProjectAction;
  lot?: ProjectLot;
  periodId?: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [operationRevision] = useState(p.revision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [catalog, setCatalog] = useState<CatalogRow[]>([]);
  const [selected, setSelected] = useState<CatalogRow | null>(null);
  const [rate, setRate] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [units, setUnits] = useState<string[]>([]);
  const [fromDate, setFromDate] = useState(
    action === "CALENDAR"
      ? (p.nextPeriod?.fromDate ?? p.fromDate)
      : action === "ISSUE"
        ? todayMoscow()
        : [p.fromDate, todayMoscow()].sort().at(-1)!,
  );
  const [throughDate, setThroughDate] = useState(
    action === "CLOSE"
      ? (p.nextPeriod?.throughDate ?? p.throughDate)
      : action === "RETURN"
        ? todayMoscow()
        : (lot?.throughDate ?? p.throughDate),
  );
  const [preview, setPreview] = useState<{
    total: string;
    lines: ProjectLine[];
    fromDate: string;
    throughDate: string;
  } | null>(null);
  const [requestKey] = useState(() => crypto.randomUUID());
  const endpoint = `/api/booking-projects/${p.bookingId}`;
  const unitOptions = lot
    ? p.units.filter(
        (u) =>
          u.equipmentId === lot.equipmentId &&
          (action === "ISSUE"
            ? u.status === "AVAILABLE"
            : lot.units.some(
                (x) => x.equipmentUnitId === u.id && !x.returnedAt,
              )),
      )
    : [];
  const isUnit = lot?.trackingMode === "UNIT";
  useEffect(() => {
    if (action !== "ADD" || !fromDate || !throughDate || fromDate > throughDate)
      return;
    const controller = new AbortController();
    const t = setTimeout(
      () =>
        apiFetch<{ rows: CatalogRow[] }>(
          `/api/booking-projects/catalog?${new URLSearchParams({ fromDate, throughDate, q: search })}`,
          { signal: controller.signal },
        )
          .then((d) => setCatalog(d.rows))
          .catch((e) => {
            if (e.name !== "AbortError") setError(e.message);
          }),
      250,
    );
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [action, fromDate, throughDate, search]);
  useEffect(() => {
    if (action !== "CLOSE" || !throughDate) return;
    const controller = new AbortController();
    setPreview(null);
    apiFetch<{
      total: string;
      lines: ProjectLine[];
      fromDate: string;
      throughDate: string;
    }>(`${endpoint}/period-preview?throughDate=${throughDate}`, {
      signal: controller.signal,
    })
      .then((d) => {
        setPreview(d);
        setError("");
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => controller.abort();
  }, [action, endpoint, throughDate]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setError("");
    const f = new FormData(e.currentTarget);
    const payload: Record<string, unknown> = { revision: operationRevision };
    let url = endpoint,
      method = "POST";
    if (action === "ADD") {
      if (!selected) {
        setError("Выберите оборудование");
        return;
      }
      url += "/lots";
      Object.assign(payload, {
        equipmentId: selected.equipment.id,
        quantity,
        ratePerShift: Number(rate),
        fromDate,
        throughDate,
      });
    }
    if (action === "ISSUE") {
      url += `/lots/${lot?.id}/issue`;
      Object.assign(payload, { fromDate, unitIds: units });
    }
    if (action === "RETURN") {
      url += `/lots/${lot?.id}/return`;
      Object.assign(payload, {
        quantity: isUnit ? units.length : quantity,
        lastBillableDate: throughDate,
        unitIds: units,
        condition: f.get("condition"),
        reason: f.get("reason"),
      });
    }
    if (action === "EXTEND" || action === "CANCEL") {
      url += `/lots/${lot?.id}`;
      method = "PATCH";
      Object.assign(payload, { action, throughDate });
    }
    if (action === "CALENDAR") {
      url += "/calendar";
      method = "PATCH";
      Object.assign(payload, { fromDate, throughDate, kind: f.get("kind") });
    }
    if (action === "CLOSE") {
      url += "/periods";
      Object.assign(payload, { throughDate, requestKey });
    }
    if (action === "PAYMENT") {
      url += "/payments";
      Object.assign(payload, {
        amount: Number(f.get("amount")),
        method: f.get("method"),
        comment: f.get("comment"),
      });
    }
    if (action === "CHARGE") {
      url += "/charges";
      Object.assign(payload, {
        amount: Number(f.get("amount")),
        date: fromDate,
        description: f.get("description"),
      });
    }
    if (action === "CORRECTION") {
      url += `/periods/${periodId}/corrections`;
      Object.assign(payload, {
        amount: Number(f.get("amount")),
        reason: f.get("reason"),
        requestKey,
      });
    }
    if (action === "CONFIRM") url += "/confirm";
    if (action === "FINISH") url += "/finish";
    if (action === "CANCEL_PROJECT") url += "/cancel";
    setBusy(true);
    try {
      await apiFetch(url, { method, body: JSON.stringify(payload) });
      await onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить");
      await onSaved();
    } finally {
      setBusy(false);
    }
  }
  const addPreview =
    selected && rate && fromDate <= throughDate
      ? p.days
          .filter((d) => d.date >= fromDate && d.date <= throughDate)
          .reduce(
            (sum, d) => sum + (d.kind === "REST" ? Number(p.restFactor) : 1),
            0,
          ) *
        Number(rate) *
        quantity
      : 0;
  return (
    <ModalViewport
      className="fixed inset-0 z-50 bg-black/45 p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-action-title"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) onClose();
      }}
    >
      <form
        onSubmit={submit}
        className="mx-auto my-auto w-full max-w-2xl space-y-4 rounded-xl border border-border bg-surface p-4 shadow-xl sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="project-action-title" className="font-cond text-2xl text-ink">
            {titles[action]}
          </h2>
          <button
            type="button"
            className={btn}
            disabled={busy}
            onClick={onClose}
            aria-label="Закрыть"
          >
            ×
          </button>
        </div>
        {lot && (
          <p className="text-sm text-ink-3">
            {lot.nameSnapshot} · {lot.quantity} шт. · {money(lot.ratePerShift)}{" "}
            / смена
          </p>
        )}
        {["ADD", "CALENDAR"].includes(action) && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field title="Первый оплачиваемый день">
              <input
                className={input}
                type="date"
                required
                min={p.fromDate}
                max={p.throughDate}
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
              />
            </Field>
            <Field title="Последний оплачиваемый день">
              <input
                className={input}
                type="date"
                required
                min={fromDate}
                max={p.throughDate}
                value={throughDate}
                onChange={(e) => setThroughDate(e.target.value)}
              />
            </Field>
          </div>
        )}
        {action === "ADD" && (
          <>
            <Field title="Поиск оборудования">
              <input
                autoFocus
                className={input}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Название прибора"
              />
            </Field>
            <div className="max-h-52 overflow-auto rounded border border-border">
              {catalog.map((row) => (
                <button
                  key={row.equipment.id}
                  type="button"
                  aria-pressed={selected?.equipment.id === row.equipment.id}
                  className={`flex w-full items-center justify-between gap-2 border-b border-border p-3 text-left text-sm ${selected?.equipment.id === row.equipment.id ? "bg-accent-soft text-accent-bright" : "text-ink hover:bg-surface-muted"}`}
                  onClick={() => {
                    setSelected(row);
                    setRate(row.equipment.rentalRatePerShift);
                  }}
                >
                  <span>{row.equipment.name}</span>
                  <span className="shrink-0 text-xs">
                    Свободно: {row.availableQuantity}
                  </span>
                </button>
              ))}
              {catalog.length === 0 && (
                <p className="p-3 text-sm text-ink-3">
                  По этим условиям ничего не найдено
                </p>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field title="Количество">
                <input
                  className={input}
                  type="number"
                  min={1}
                  max={10000}
                  required
                  value={quantity}
                  onChange={(e) => setQuantity(Number(e.target.value))}
                />
              </Field>
              <Field title="Согласованная ставка / смена, ₽">
                <input
                  className={input}
                  type="number"
                  min={0}
                  max={100000000}
                  step="0.01"
                  required
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                />
              </Field>
            </div>
            <p className="rounded bg-surface-muted p-3 text-sm">
              Стоимость поставки: <strong>{money(addPreview)}</strong> ·
              выходной {Number(p.restFactor) * 100}%
              {p.booking.paymentForm === "CASHLESS"
                ? `; надбавка за безнал ${p.booking.cashlessSurchargePercent}% добавится в расчёте`
                : ""}
            </p>
          </>
        )}
        {action === "CALENDAR" && (
          <Field title="Тип дней">
            <select name="kind" className={input}>
              <option value="SHOOT">Съёмочные — 100%</option>
              <option value="REST">
                Выходные — {Number(p.restFactor) * 100}%
              </option>
              <option value="WEEKDAYS">
                Шаблон: пн–пт съёмка, сб–вс выходной
              </option>
            </select>
          </Field>
        )}
        {action === "ISSUE" && (
          <>
            <Field title="Первый оплачиваемый день">
              <input
                className={input}
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                max={todayMoscow()}
                min={p.fromDate}
                required
              />
            </Field>
            <p className="text-sm text-ink-3">
              Подтвердите только фактически переданное оборудование. Время
              выдачи будет записано сейчас.
            </p>
          </>
        )}
        {action === "RETURN" && (
          <>
            <Field title="Последний оплачиваемый день (включительно)">
              <input
                className={input}
                type="date"
                value={throughDate}
                onChange={(e) => setThroughDate(e.target.value)}
                max={todayMoscow()}
                min={lot?.fromDate}
                required
              />
            </Field>
            {!isUnit && (
              <Field title="Принимаемое количество">
                <input
                  className={input}
                  type="number"
                  min={1}
                  max={
                    lot
                      ? lot.quantity -
                        lot.returns.reduce((s, r) => s + r.quantity, 0)
                      : 1
                  }
                  value={quantity}
                  onChange={(e) => setQuantity(Number(e.target.value))}
                  required
                />
              </Field>
            )}
            <Field title="Состояние">
              <select className={input} name="condition">
                <option value="OK">Принято исправным</option>
                <option value="REPAIR">Принято в ремонт</option>
                <option value="MISSING">Зафиксирована недостача</option>
              </select>
            </Field>
            <Field title="Комментарий к повреждению / недостаче">
              <input className={input} name="reason" maxLength={500} />
            </Field>
            <p className="text-sm text-ink-3">
              Остальное оборудование остаётся у клиента. Повреждённое и
              недостача не станут доступными для выдачи.
            </p>
          </>
        )}
        {isUnit && ["ISSUE", "RETURN"].includes(action) && (
          <fieldset className="rounded border border-border p-3">
            <legend className="px-1 text-sm">
              Экземпляры · выбрано {units.length}
              {action === "ISSUE" ? ` из ${lot?.quantity}` : ""}
            </legend>
            <div className="max-h-52 space-y-2 overflow-auto">
              {unitOptions.map((u) => (
                <label
                  key={u.id}
                  className="flex min-h-10 items-center gap-3 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={units.includes(u.id)}
                    onChange={(e) =>
                      setUnits((prev) =>
                        e.target.checked
                          ? [...prev, u.id]
                          : prev.filter((x) => x !== u.id),
                      )
                    }
                  />
                  {u.internalInventoryNumber || u.id.slice(-8)}
                </label>
              ))}
              {unitOptions.length === 0 && (
                <p className="text-sm text-rose">Нет доступных экземпляров</p>
              )}
            </div>
          </fieldset>
        )}
        {action === "EXTEND" && (
          <Field title="Новый последний оплачиваемый день">
            <input
              className={input}
              type="date"
              value={throughDate}
              onChange={(e) => setThroughDate(e.target.value)}
              required
            />
            <span className="text-xs text-ink-3">
              Срок проекта расширится автоматически. Доступность будет проверена
              перед сохранением.
            </span>
          </Field>
        )}
        {action === "CLOSE" && (
          <>
            <Field title="Закрыть по дату включительно">
              <input
                className={input}
                type="date"
                value={throughDate}
                min={p.nextPeriod?.fromDate}
                max={[todayMoscow(), p.throughDate].sort()[0]}
                onChange={(e) => setThroughDate(e.target.value)}
                required
              />
            </Field>
            {preview && (
              <div className="rounded border border-border p-3">
                <p className="text-sm">
                  {preview.fromDate} — {preview.throughDate}
                </p>
                <p className="my-2 font-cond text-2xl">
                  {money(preview.total)}
                </p>
                <div className="max-h-52 space-y-2 overflow-auto">
                  {preview.lines.map((l, i) => (
                    <div key={i} className="flex justify-between gap-3 text-sm">
                      <span>
                        {l.name} × {l.quantity}
                        <span className="block text-xs text-ink-3">
                          Съёмочных {l.shootDays}, выходных {l.restDays} ×{" "}
                          {l.restFactor}
                        </span>
                      </span>
                      <span className="shrink-0">{money(l.amount)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <p className="text-sm text-ink-3">
              Создадим счёт и зафиксируем расчёт. Изменения закрытого периода
              оформляются отдельной корректировкой.
            </p>
          </>
        )}
        {["PAYMENT", "CHARGE", "CORRECTION"].includes(action) && (
          <Field
            title={
              action === "CORRECTION"
                ? "Изменение суммы, ₽ (минус — уменьшить)"
                : "Сумма, ₽"
            }
          >
            <input
              className={input}
              name="amount"
              type="number"
              min={action === "CORRECTION" ? -100000000 : 0.01}
              max={100000000}
              step="0.01"
              required
            />
          </Field>
        )}
        {action === "PAYMENT" && (
          <>
            <Field title="Способ оплаты">
              <select className={input} name="method">
                <option value="CASH">Наличные</option>
                <option value="BANK_TRANSFER">Банковский перевод</option>
                <option value="CARD">Карта</option>
                <option value="OTHER">Другой</option>
              </select>
            </Field>
            <Field title="Комментарий">
              <input className={input} name="comment" maxLength={1000} />
            </Field>
            <p className="text-sm text-ink-3">
              Оплата покрывает периоды по сроку платежа. Остаток сохраняется
              авансом на проекте.
            </p>
          </>
        )}
        {action === "CHARGE" && (
          <>
            <Field title="Услуга">
              <input
                className={input}
                name="description"
                placeholder="Доставка добора"
                maxLength={300}
                required
              />
            </Field>
            <Field title="Дата услуги">
              <input
                className={input}
                type="date"
                min={p.fromDate}
                max={p.throughDate}
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                required
              />
            </Field>
          </>
        )}
        {action === "CORRECTION" && (
          <Field title="Причина корректировки">
            <textarea
              className={input}
              name="reason"
              minLength={3}
              maxLength={1000}
              required
            />
          </Field>
        )}
        {action === "CANCEL" && (
          <p className="text-sm">
            Снимем резерв этой поставки. Остальные поставки продолжат
            действовать.
          </p>
        )}
        {action === "CONFIRM" && (
          <p className="text-sm">
            Проверим наличие и зарезервируем все поставки на их даты.
            Фактическая выдача подтверждается отдельно.
          </p>
        )}
        {action === "CANCEL_PROJECT" && (
          <p className="text-sm">
            Отменим проект и снимем все резервы. Если принят аванс, сначала
            оформите его возврат в журнале платежей.
          </p>
        )}
        {action === "FINISH" && (
          <p className="text-sm">
            Завершим работу склада по проекту. Счета, оплаты и возможность
            закрыть последний период сохранятся.
          </p>
        )}
        {error && (
          <p
            className="rounded bg-rose-soft p-3 text-sm text-rose"
            role="alert"
          >
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
          <button
            className={btn}
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            Отмена
          </button>
          <button
            className={primary}
            disabled={busy || (action === "CLOSE" && !preview)}
          >
            {busy
              ? "Сохраняем…"
              : action === "CLOSE"
                ? "Зафиксировать и создать счёт"
                : "Подтвердить"}
          </button>
        </div>
      </form>
    </ModalViewport>
  );
}
