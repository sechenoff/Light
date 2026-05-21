"use client";

import { useEffect, useState } from "react";
import { formatRub } from "../../lib/format";
import { scanApi } from "../warehouse/api";
import type { AddonEstimateView } from "../warehouse/types";

/**
 * Секция «Доб-смета» на странице брони. Грузит ADDON Estimate через
 * `GET /api/addon-estimates/:bookingId`. Не рендерится если addon null
 * (бронь без доборов).
 */
export function AddonEstimateSection({ bookingId }: { bookingId: string }) {
  const [addon, setAddon] = useState<AddonEstimateView | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    scanApi
      .getAddonEstimate(bookingId)
      .then((r) => {
        if (!cancelled) {
          setAddon(r.addon);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [bookingId]);

  if (!loaded || !addon || addon.lines.length === 0) return null;

  return (
    <section className="mt-6 rounded-lg border border-border bg-surface p-4">
      <h2 className="text-[14px] font-semibold text-ink">Доб-смета</h2>
      <p className="text-[12px] text-ink-3 mb-3">
        Позиции, добавленные при выдаче поверх согласованной сметы.
      </p>
      <table className="w-full text-[13px]">
        <thead className="text-[11px] uppercase tracking-wider text-ink-3">
          <tr className="border-b border-border">
            <th className="py-2 text-left">Позиция</th>
            <th className="py-2 text-right">Кол-во</th>
            <th className="py-2 text-right">Сумма</th>
          </tr>
        </thead>
        <tbody>
          {addon.lines.map((l, i) => (
            <tr key={i} className="border-b border-border last:border-0">
              <td className="py-1.5">{l.name}</td>
              <td className="py-1.5 text-right mono-num">×{l.quantity}</td>
              <td className="py-1.5 text-right mono-num">{formatRub(l.lineSum)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="text-[12px]">
          <tr><td colSpan={2} className="pt-2 text-right">Итого:</td><td className="pt-2 text-right mono-num">{formatRub(addon.subtotal)}</td></tr>
          {addon.discountPercent && Number(addon.discountPercent) > 0 && (
            <tr><td colSpan={2} className="text-right">Скидка {addon.discountPercent}%:</td><td className="text-right mono-num">−{formatRub(addon.discountAmount)}</td></tr>
          )}
          <tr className="font-semibold"><td colSpan={2} className="text-right">К доплате:</td><td className="text-right mono-num">{formatRub(addon.totalAfterDiscount)}</td></tr>
        </tfoot>
      </table>
      <div className="mt-3 flex gap-2 text-[12px]">
        <a
          href={`/api/addon-estimates/${bookingId}/export/pdf`}
          target="_blank"
          rel="noreferrer"
          className="rounded border border-border px-3 py-1.5 hover:bg-surface-muted"
        >
          PDF доб-сметы
        </a>
        <a
          href={`/api/bookings/${bookingId}/full-estimate/export/pdf`}
          target="_blank"
          rel="noreferrer"
          className="rounded border border-border px-3 py-1.5 hover:bg-surface-muted"
        >
          PDF общая смета
        </a>
        <a
          href={`/api/addon-estimates/${bookingId}/export/xlsx`}
          target="_blank"
          rel="noreferrer"
          className="rounded border border-border px-3 py-1.5 hover:bg-surface-muted"
        >
          XLSX доб-сметы
        </a>
      </div>
    </section>
  );
}
