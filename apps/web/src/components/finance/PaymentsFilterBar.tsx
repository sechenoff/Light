"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";

export interface PaymentsFilter {
  from: string;
  to: string;
  clientId: string;
  amountMin: string;
  amountMax: string;
  paymentStatuses: string[]; // subset of ["NOT_PAID","PARTIALLY_PAID","PAID","OVERDUE"]
}

const ALL_STATUSES = ["NOT_PAID", "PARTIALLY_PAID", "PAID", "OVERDUE"] as const;
type PaymentStatus = typeof ALL_STATUSES[number];

const STATUS_LABELS: Record<PaymentStatus, string> = {
  NOT_PAID: "Не оплачено",
  PARTIALLY_PAID: "Частично",
  PAID: "Оплачено",
  OVERDUE: "Просрочено",
};

interface ClientOption {
  id: string;
  name: string;
}

interface Props {
  filter: PaymentsFilter;
  onChange: (f: PaymentsFilter) => void;
}

export function PaymentsFilterBar({ filter, onChange }: Props) {
  const [clients, setClients] = useState<ClientOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ clients: ClientOption[] }>("/api/clients?limit=200")
      .then((r) => { if (!cancelled) setClients(r.clients ?? []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  function set<K extends keyof PaymentsFilter>(key: K, value: PaymentsFilter[K]) {
    onChange({ ...filter, [key]: value });
  }

  function toggleStatus(s: string) {
    const current = filter.paymentStatuses;
    const next = current.includes(s)
      ? current.filter((x) => x !== s)
      : [...current, s];
    onChange({ ...filter, paymentStatuses: next });
  }

  return (
    <div className="flex flex-wrap items-end gap-3 pb-4 border-b border-border mb-4">
      {/* Date range */}
      <div className="flex items-center gap-2">
        <div>
          <label className="eyebrow block mb-1">С</label>
          <input
            type="date"
            className="border border-border rounded px-2.5 py-1.5 text-sm bg-surface text-ink w-36"
            value={filter.from}
            onChange={(e) => set("from", e.target.value)}
          />
        </div>
        <div>
          <label className="eyebrow block mb-1">По</label>
          <input
            type="date"
            className="border border-border rounded px-2.5 py-1.5 text-sm bg-surface text-ink w-36"
            value={filter.to}
            onChange={(e) => set("to", e.target.value)}
          />
        </div>
      </div>

      {/* Client select */}
      <div>
        <label className="eyebrow block mb-1">Клиент</label>
        <select
          className="border border-border rounded px-2.5 py-1.5 text-sm bg-surface text-ink w-44"
          value={filter.clientId}
          onChange={(e) => set("clientId", e.target.value)}
        >
          <option value="">Все клиенты</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      {/* Amount range */}
      <div className="flex items-center gap-2">
        <div>
          <label className="eyebrow block mb-1">Сумма от</label>
          <input
            type="number"
            className="border border-border rounded px-2.5 py-1.5 text-sm bg-surface text-ink w-28"
            value={filter.amountMin}
            onChange={(e) => set("amountMin", e.target.value)}
            placeholder="0"
            min="0"
          />
        </div>
        <div>
          <label className="eyebrow block mb-1">до</label>
          <input
            type="number"
            className="border border-border rounded px-2.5 py-1.5 text-sm bg-surface text-ink w-28"
            value={filter.amountMax}
            onChange={(e) => set("amountMax", e.target.value)}
            placeholder="∞"
            min="0"
          />
        </div>
      </div>

      {/* Payment status chips */}
      <div>
        <p className="eyebrow mb-1">Статус оплаты</p>
        <div className="flex gap-1.5 flex-wrap">
          {ALL_STATUSES.map((s) => {
            const active = filter.paymentStatuses.includes(s);
            return (
              <button
                key={s}
                onClick={() => toggleStatus(s)}
                className={`px-2.5 py-1 text-xs rounded border font-medium transition-colors ${
                  active
                    ? "bg-accent-soft text-accent border-accent-border"
                    : "bg-surface text-ink-2 border-border hover:border-accent-border hover:text-accent"
                }`}
              >
                {STATUS_LABELS[s]}
              </button>
            );
          })}
        </div>
      </div>

      {/* Reset */}
      {(filter.from || filter.to || filter.clientId || filter.amountMin || filter.amountMax || filter.paymentStatuses.length < 4) && (
        <button
          onClick={() => onChange({
            from: "",
            to: "",
            clientId: "",
            amountMin: "",
            amountMax: "",
            paymentStatuses: ["NOT_PAID", "PARTIALLY_PAID", "PAID", "OVERDUE"],
          })}
          className="text-xs text-ink-2 hover:text-rose border border-border rounded px-2.5 py-1.5 self-end"
        >
          Сбросить
        </button>
      )}
    </div>
  );
}
