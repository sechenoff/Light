"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { apiFetch } from "../../lib/api";
import { formatRub } from "../../lib/format";
import { toMoscowDateString } from "../../lib/moscowDate";
import { ClientAutocomplete } from "./create/ClientAutocomplete";

type Props = {
  open: boolean;
  onClose: () => void;
  /** Вызывается после успешного создания — родитель обновляет список. */
  onCreated: (booking: { id: string; projectName: string }) => void;
};

/** Сегодня и завтра в формате `YYYY-MM-DD` по московскому дню. */
function defaultDates(): { start: string; end: string } {
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  return { start: toMoscowDateString(today), end: toMoscowDateString(tomorrow) };
}

/** «40 000», «40000,50», «40 000.5» → 40000 / 40000.5. NaN, если мусор. */
function parseAmount(raw: string): number {
  const normalized = raw.replace(/\s| /g, "").replace(",", ".");
  if (normalized === "") return NaN;
  return Number(normalized);
}

/**
 * Быстрая бронь: клиент + произвольная сумма, без списка оборудования.
 *
 * Сценарий — «договорились на словах, надо записать»: сумма названа целиком,
 * разбивать её по позициям каталога не нужно и некогда. Поле дат свёрнуто,
 * подставляется сегодня→завтра: в 90% случаев его не трогают.
 *
 * Бронь создаётся сразу подтверждённой (согласование пропускается осознанно —
 * см. POST /api/bookings/quick) и попадает в календарь, долги и финансы.
 * На складских экранах она не показывается: выдавать нечего.
 */
export function QuickBookingModal({ open, onClose, onCreated }: Props) {
  const [clientName, setClientName] = useState("");
  const [willCreateNew, setWillCreateNew] = useState(false);
  const [phone, setPhone] = useState("");
  const [amount, setAmount] = useState("");
  const [projectName, setProjectName] = useState("");
  const [datesOpen, setDatesOpen] = useState(false);
  const [dates, setDates] = useState(defaultDates);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setClientName("");
      setWillCreateNew(false);
      setPhone("");
      setAmount("");
      setProjectName("");
      setDatesOpen(false);
      setDates(defaultDates());
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, saving, onClose]);

  const parsedAmount = useMemo(() => parseAmount(amount), [amount]);
  const amountValid =
    Number.isFinite(parsedAmount) && parsedAmount >= 0 && parsedAmount <= 1_000_000_000;
  const canSubmit = clientName.trim().length > 0 && amountValid && !saving;

  if (!open) return null;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      // Даты уходят как локальная полночь МСК + типовое время выдачи;
      // бэкенд принимает и `YYYY-MM-DD`, и ISO — шлём ISO-безопасный формат.
      const res = await apiFetch<{ booking: { id: string; projectName: string } }>(
        "/api/bookings/quick",
        {
          method: "POST",
          body: JSON.stringify({
            client: {
              name: clientName.trim(),
              ...(willCreateNew && phone.trim() ? { phone: phone.trim() } : {}),
            },
            amount: parsedAmount,
            ...(projectName.trim() ? { projectName: projectName.trim() } : {}),
            ...(datesOpen
              ? {
                  startDate: `${dates.start}T10:00`,
                  endDate: `${dates.end}T10:00`,
                }
              : {}),
          }),
        },
      );
      onCreated(res.booking);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось создать бронь");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/50 px-4"
      onClick={() => !saving && onClose()}
    >
      <div
        className="w-full max-w-md rounded-lg bg-surface p-6 shadow-lg"
        role="dialog"
        aria-modal="true"
        aria-label="Быстрая бронь"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <div className="eyebrow mb-1">Быстрая бронь</div>
            <p className="text-sm text-ink-3">
              Без списка оборудования — только клиент и сумма.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Закрыть"
            className="-mr-1 -mt-1 rounded p-1 text-ink-3 hover:bg-surface-muted hover:text-ink disabled:opacity-50"
          >
            ✕
          </button>
        </div>

        <label htmlFor="quick-client" className="mb-1 block text-sm text-ink-2">
          Клиент <span className="text-rose">*</span>
        </label>
        <ClientAutocomplete
          id="quick-client"
          value={clientName}
          onChange={setClientName}
          onWillCreateNewChange={setWillCreateNew}
          autoFocus
        />

        {willCreateNew && clientName.trim() && (
          <div className="mt-2">
            <label htmlFor="quick-phone" className="mb-1 block text-xs text-ink-3">
              Телефон нового клиента · опционально
            </label>
            <input
              id="quick-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={saving}
              placeholder="+7 916 123-45-67"
              className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
            />
          </div>
        )}

        <label htmlFor="quick-amount" className="mb-1 mt-4 block text-sm text-ink-2">
          Сумма, ₽ <span className="text-rose">*</span>
        </label>
        <input
          id="quick-amount"
          ref={amountRef}
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSubmit) {
              e.preventDefault();
              void handleSubmit();
            }
          }}
          disabled={saving}
          placeholder="40 000"
          aria-invalid={amount.trim() !== "" && !amountValid}
          className="mono-num w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-lg font-semibold text-ink focus:border-accent-bright focus:outline-none"
        />
        <div className="mt-1 min-h-[1rem] text-xs">
          {amount.trim() !== "" && !amountValid ? (
            <span className="text-rose">Введите сумму числом, например 40000</span>
          ) : amountValid && parsedAmount > 0 ? (
            <span className="text-ink-3">Итого по броне: {formatRub(String(parsedAmount))}</span>
          ) : null}
        </div>

        <label htmlFor="quick-project" className="mb-1 mt-3 block text-sm text-ink-2">
          Проект <span className="text-ink-3">· опционально</span>
        </label>
        <input
          id="quick-project"
          type="text"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          disabled={saving}
          placeholder="Без описания"
          className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
        />

        {/* Даты свёрнуты: в типовом случае это сегодня→завтра */}
        <div className="mt-4 rounded border border-dashed border-border-strong px-3 py-2">
          {datesOpen ? (
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <label htmlFor="quick-start" className="mb-1 block text-xs text-ink-3">
                  Выдача
                </label>
                <input
                  id="quick-start"
                  type="date"
                  value={dates.start}
                  onChange={(e) => setDates((d) => ({ ...d, start: e.target.value }))}
                  disabled={saving}
                  className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
                />
              </div>
              <div className="flex-1">
                <label htmlFor="quick-end" className="mb-1 block text-xs text-ink-3">
                  Возврат
                </label>
                <input
                  id="quick-end"
                  type="date"
                  value={dates.end}
                  onChange={(e) => setDates((d) => ({ ...d, end: e.target.value }))}
                  disabled={saving}
                  className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
                />
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setDatesOpen(true)}
              disabled={saving}
              className="flex w-full items-center justify-between text-left text-xs text-ink-3 hover:text-ink disabled:opacity-50"
            >
              <span>
                Период: <span className="mono-num text-ink-2">сегодня → завтра</span>
              </span>
              <span className="text-accent">изменить даты</span>
            </button>
          )}
        </div>

        {error && (
          <p className="mt-3 rounded border border-rose-border bg-rose-soft px-3 py-2 text-sm text-rose">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded border border-border px-4 py-2 text-sm text-ink-2 hover:bg-surface-muted disabled:opacity-50"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className="rounded bg-accent-bright px-5 py-2 text-sm font-medium text-surface transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Создаю…" : "Создать бронь"}
          </button>
        </div>
      </div>
    </div>
  );
}
