"use client";
import {
  REGISTER_STATUSES,
  type BookingRegisterResponse,
} from "@light-rental/shared";
import { bookingStatusLabel } from "../../../lib/bookingConstants";
import { BOOKING_ISSUE_FILTERS } from "@light-rental/shared";
import { actionLabels, dateLabels, FILTER_KEYS } from "./model";
export const control =
  "min-h-10 w-full min-w-0 rounded border border-border bg-surface px-3 py-2 text-base sm:text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";
export const button =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-ink-2 hover:bg-surface-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";
export function RegisterFilters({
  params,
  options,
  apply,
}: {
  params: URLSearchParams;
  options?: BookingRegisterResponse["options"];
  apply: (patch: Record<string, string>) => void;
}) {
  const field = (name: string, label: string, children: React.ReactNode) => (
    <label className="min-w-0 space-y-1 text-xs text-ink-2">
      <span>{label}</span>
      {children}
    </label>
  );
  const select = (
    name: string,
    choices: Record<string, string>,
    all = "Все",
  ) => (
    <select
      name={name}
      defaultValue={params.get(name) ?? ""}
      className={control}
    >
      <option value="">{all}</option>
      {Object.entries(choices).map(([k, v]) => (
        <option key={k} value={k}>
          {v}
        </option>
      ))}
    </select>
  );
  return (
    <form
      className="rounded-lg border border-border bg-surface-subtle p-4"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget),
          patch: Record<string, string> = {};
        for (const k of FILTER_KEYS.filter((k) => k !== "q"))
          patch[k] =
            k === "status"
              ? data.getAll(k).join(",")
              : String(data.get(k) ?? "");
        apply(patch);
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {field(
          "clientId",
          "Клиент",
          <select
            name="clientId"
            defaultValue={params.get("clientId") ?? ""}
            className={control}
          >
            <option value="">Все клиенты</option>
            {options?.clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>,
        )}
        {field(
          "projectId",
          "Проект / бронирование",
          <select
            name="projectId"
            defaultValue={params.get("projectId") ?? ""}
            className={control}
          >
            <option value="">Все проекты</option>
            {options?.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>,
        )}
        {field(
          "mode",
          "Тип аренды",
          select("mode", {
            STANDARD: "Обычная аренда",
            PROJECT: "Длинный проект",
          }),
        )}
        {field(
          "payment",
          "Расчёты",
          select("payment", {
            unpaid: "Есть остаток",
            partial: "Частичная оплата",
            overdue: "Есть просрочка",
            paid: "Оплачено",
            unpriced: "Без расчёта / начислений",
            zero: "К оплате 0 ₽",
            settled: "Со списанием",
            credit: "Аванс / переплата",
          }),
        )}
        {field(
          "dateField",
          "По какой дате",
          <select
            name="dateField"
            defaultValue={params.get("dateField") ?? "rental"}
            className={control}
          >
            {Object.entries(dateLabels).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>,
        )}
        {field(
          "from",
          "С даты (МСК)",
          <input
            className={control}
            type="date"
            name="from"
            defaultValue={params.get("from") ?? ""}
          />,
        )}
        {field(
          "to",
          "По дату включительно (МСК)",
          <input
            className={control}
            type="date"
            name="to"
            defaultValue={params.get("to") ?? ""}
          />,
        )}
        {field(
          "age",
          "Срок просрочки оплаты",
          select("age", {
            "1-7": "До 7 дней включительно",
            "8-30": "8–30 дней",
            "31+": "Более 30 дней",
          }),
        )}
        {field(
          "amountField",
          "Фильтровать сумму",
          <select
            name="amountField"
            defaultValue={params.get("amountField") ?? "outstanding"}
            className={control}
          >
            <option value="outstanding">Остаток к оплате</option>
            <option value="total">Начислено</option>
            <option value="paid">Получено</option>
            <option value="overdue">Просрочено</option>
          </select>,
        )}
        {field(
          "min",
          "От, ₽",
          <input
            className={control}
            name="min"
            type="number"
            min="0"
            step="0.01"
            defaultValue={params.get("min") ?? ""}
          />,
        )}
        {field(
          "max",
          "До, ₽",
          <input
            className={control}
            name="max"
            type="number"
            min="0"
            step="0.01"
            defaultValue={params.get("max") ?? ""}
          />,
        )}
        {field("action", "Требуемое действие", select("action", actionLabels))}
        {field("issue", "Проблемы оборудования", select("issue", BOOKING_ISSUE_FILTERS))}
      </div>
      <fieldset className="mt-4">
        <legend className="mb-2 text-xs text-ink-2">
          Этап аренды — можно выбрать несколько
        </legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {REGISTER_STATUSES.map((s) => (
            <label
              key={s}
              className="flex min-h-9 items-center gap-2 text-sm text-ink"
            >
              <input
                type="checkbox"
                className="h-4 w-4 accent-accent"
                name="status"
                value={s}
                defaultChecked={params.get("status")?.split(",").includes(s)}
              />
              {bookingStatusLabel(s)}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-xs text-ink-3">
          «Период аренды» находит все брони, пересекающие выбранные даты,
          включая длинные проекты. Фильтры применяются ко всей базе.
        </p>
        <button className={`${button} !bg-accent !text-white`} type="submit">
          Применить фильтры
        </button>
      </div>
    </form>
  );
}
