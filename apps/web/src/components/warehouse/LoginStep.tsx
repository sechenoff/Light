"use client";

/**
 * Warehouse PIN login.
 *
 * Behaviour is a faithful 1:1 port of the original
 * `apps/web/app/warehouse/scan/page.tsx` `LoginStep`:
 *  - loads worker names via the public `GET /workers/names`
 *  - validates name + PIN (>= 4 digits, digits-only input)
 *  - `POST /auth` then persists the token (the api.ts `authWorker`
 *    setter writes sessionStorage `warehouse_token` — same contract)
 *  - calls `onSuccess()` on success; surfaces server error message inline
 *
 * Only the visuals change: IBM Plex canon, max-w ~360px, semantic tokens,
 * `accent-bright` primary button. No barcodes, Russian labels.
 */

import { useEffect, useState } from "react";
import { scanApi } from "./api";
import type { ScanApiError } from "./types";

function isScanApiError(value: unknown): value is ScanApiError {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "message" in value
  );
}

export function LoginStep({ onSuccess }: { onSuccess: () => void }) {
  const [names, setNames] = useState<string[]>([]);
  const [selectedName, setSelectedName] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingNames, setLoadingNames] = useState(true);

  useEffect(() => {
    let cancelled = false;
    scanApi
      .listWorkerNames()
      .then((list) => {
        if (cancelled) return;
        setNames(list);
        if (list.length > 0) setSelectedName(list[0]);
      })
      .catch(() => {
        if (!cancelled) setError("Не удалось загрузить список сотрудников");
      })
      .finally(() => {
        if (!cancelled) setLoadingNames(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedName || pin.length < 4) {
      setError("Введите имя и PIN (минимум 4 цифры)");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      // authWorker() persists the token via the api.ts setter
      // (sessionStorage "warehouse_token") — identical token contract.
      await scanApi.authWorker(selectedName, pin);
      onSuccess();
    } catch (err: unknown) {
      const msg = isScanApiError(err)
        ? err.message
        : err instanceof Error
          ? err.message
          : "Ошибка входа";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-[360px] rounded-lg border border-border bg-surface p-6 shadow-xs">
      <div className="mb-6">
        <p className="eyebrow mb-1">Склад</p>
        <h2 className="text-[17px] font-semibold tracking-tight text-ink">
          Вход на склад
        </h2>
        <p className="mt-1 text-xs text-ink-3">Выберите имя и введите PIN</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="eyebrow mb-1.5 block">Сотрудник</label>
          {loadingNames ? (
            <div className="h-12 animate-pulse rounded bg-surface-subtle" />
          ) : (
            <select
              value={selectedName}
              onChange={(e) => setSelectedName(e.target.value)}
              className="h-12 w-full rounded border border-border bg-surface px-3 text-base text-ink focus:border-accent-bright focus:outline-none focus:ring-1 focus:ring-accent-bright"
              required
            >
              <option value="">— выберите сотрудника —</option>
              {names.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          )}
        </div>

        <div>
          <label className="eyebrow mb-1.5 block">PIN-код</label>
          <input
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            minLength={4}
            maxLength={8}
            placeholder="••••"
            aria-label="PIN-код"
            className="h-12 w-full rounded border border-border bg-surface px-3 text-base text-ink focus:border-accent-bright focus:outline-none focus:ring-1 focus:ring-accent-bright"
            required
          />
        </div>

        {error && (
          <div className="rounded border border-rose-border bg-rose-soft px-3 py-2 text-sm text-rose">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="h-14 w-full rounded bg-accent-bright text-base font-semibold text-white transition-colors hover:bg-accent disabled:opacity-50"
        >
          {loading ? "Вход…" : "Войти"}
        </button>
      </form>
    </div>
  );
}
