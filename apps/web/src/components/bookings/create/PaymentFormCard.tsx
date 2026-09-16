"use client";

import { useEffect, useState } from "react";

export type PaymentForm = "CASH" | "CASHLESS";

export const PAYMENT_FORM_LABELS: Record<PaymentForm, string> = {
  CASH: "Наличные",
  CASHLESS: "По счёту (ИП)",
};

type Props = {
  value: PaymentForm;
  onChange: (v: PaymentForm) => void;
  /** Процент надбавки на этой брони; null — дефолт из настроек. */
  surchargePercent: number | null;
  onChangeSurchargePercent: (v: number | null) => void;
  /** Дефолт из настроек организации — показывается, пока процент не перебит. */
  defaultPercent: number | null;
  /** Право менять процент. Без него виден только дефолт. */
  canEditPercent?: boolean;
};

/**
 * Форма оплаты: наличные (как в смете) или по счёту ИП — тогда к итогу
 * плюсуется процент. Сегментный переключатель, а не чекбокс: у обеих опций
 * есть имя, и «наличные» — такой же выбор, как и «по счёту».
 */
export function PaymentFormCard({
  value,
  onChange,
  surchargePercent,
  onChangeSurchargePercent,
  defaultPercent,
  canEditPercent = true,
}: Props) {
  const effective = surchargePercent ?? defaultPercent;
  const isCashless = value === "CASHLESS";
  // Черновик ввода: контролируемое поле с числом съедало бы запятую на «12,»
  // до того, как человек допишет «5». Синхронизируем с пропсами извне.
  const [draft, setDraft] = useState<string>(effective != null ? String(effective) : "");
  useEffect(() => {
    setDraft(effective != null ? String(effective) : "");
  }, [effective]);

  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="text-[13px] font-medium text-ink">Форма оплаты</label>
        <div
          role="radiogroup"
          aria-label="Форма оплаты"
          className="inline-flex rounded-md border border-border bg-surface-muted p-0.5 text-[12.5px]"
        >
          {(Object.keys(PAYMENT_FORM_LABELS) as PaymentForm[]).map((form) => {
            const active = form === value;
            return (
              <button
                key={form}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onChange(form)}
                className={`rounded px-3 py-1 font-medium transition-colors ${
                  active ? "bg-surface text-ink shadow-xs" : "text-ink-2 hover:text-ink"
                }`}
              >
                {PAYMENT_FORM_LABELS[form]}
              </button>
            );
          })}
        </div>
      </div>

      {isCashless && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <div className="min-w-0">
            <p className="text-[12.5px] text-ink-2">Надбавка за безналичный расчёт</p>
            <p className="text-[11px] text-ink-3">
              {surchargePercent == null
                ? defaultPercent != null
                  ? `по умолчанию ${defaultPercent} % из настроек`
                  : "процент не задан в настройках — надбавки не будет"
                : defaultPercent != null && surchargePercent !== defaultPercent
                  ? `по умолчанию ${defaultPercent} %`
                  : "процент зафиксирован на этой брони"}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            {/* type="text": в number-поле запятая с русской клавиатуры не вводится */}
            <input
              type="text"
              inputMode="decimal"
              aria-label="Процент надбавки за безналичный расчёт"
              disabled={!canEditPercent}
              value={draft}
              placeholder={defaultPercent != null ? String(defaultPercent) : "0"}
              onChange={(e) => {
                const raw = e.target.value;
                setDraft(raw);
                const trimmed = raw.trim();
                if (trimmed === "") {
                  onChangeSurchargePercent(null);
                  return;
                }
                if (/[.,]$/.test(trimmed)) return; // «12,» — ждём хвост
                const n = Number(trimmed.replace(",", "."));
                if (Number.isFinite(n)) onChangeSurchargePercent(Math.min(100, Math.max(0, n)));
              }}
              onBlur={() => setDraft(effective != null ? String(effective) : "")}
              className="w-16 rounded border border-border px-2 py-1 text-right font-mono text-[13px] focus:border-accent-bright focus:outline-none disabled:opacity-60"
            />
            <span className="text-[13px] text-ink-2">%</span>
            {surchargePercent != null && canEditPercent && (
              <button
                type="button"
                onClick={() => onChangeSurchargePercent(null)}
                className="ml-1 text-[11px] text-ink-3 underline-offset-2 hover:text-ink hover:underline"
              >
                сбросить
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
