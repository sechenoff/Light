"use client";

import { useState } from "react";

import { apiFetch } from "../../lib/api";
import type { UserRole } from "../../lib/auth";
import { formatRub, pluralize } from "../../lib/format";
import { toast } from "../ToastProvider";
import { ConfirmActionModal } from "./ConfirmActionModal";

/**
 * Секция «Доб-смета» на странице брони.
 *
 * Читает `booking.addonEstimate` из ответа GET /api/bookings/:id (не ходит за
 * ним отдельно — иначе после добора или вливания секция показывала бы старое,
 * пока страница перечитывает бронь). Не рендерится без доборов.
 *
 * «Влить в основную смету» — обратный переключатель режима: добор, оформленный
 * отдельным документом, становится частью согласованной сметы; сумма к оплате
 * не меняется, меняется только раскладка по документам.
 */

export type AddonEstimateLineView = {
  id?: string;
  equipmentId: string | null;
  nameSnapshot: string;
  categorySnapshot?: string;
  quantity: number;
  unitPrice: string;
  lineSum: string;
};

export type AddonEstimateView = {
  id: string;
  shifts: number;
  subtotal: string;
  discountPercent: string | null;
  discountAmount: string;
  totalAfterDiscount: string;
  lines: AddonEstimateLineView[];
};

export type AddonSectionBooking = {
  id: string;
  status: string;
  deletedAt?: string | null;
  addonEstimate?: AddonEstimateView | null;
};

/** Статусы, в которых сервер разрешает влить доп-смету (зеркало MERGE_ALLOWED_STATUSES). */
const MERGE_ALLOWED_STATUSES = new Set(["CONFIRMED", "ISSUED", "RETURNED"]);

export function AddonEstimateSection({
  booking,
  userRole,
  onMerged,
}: {
  booking: AddonSectionBooking;
  userRole?: UserRole;
  /** После успешного вливания — страница перечитывает бронь. */
  onMerged?: () => void | Promise<void>;
}) {
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);

  const addon = booking.addonEstimate;
  if (!addon || addon.lines.length === 0) return null;

  const canMerge =
    (userRole === "SUPER_ADMIN" || userRole === "WAREHOUSE") &&
    MERGE_ALLOWED_STATUSES.has(booking.status) &&
    !booking.deletedAt;

  async function merge() {
    if (mergeBusy) return;
    setMergeBusy(true);
    try {
      await apiFetch(`/api/bookings/${booking.id}/addon-estimate/merge`, { method: "POST" });
      toast.success("Доп-смета влита в основную — документ теперь один");
      setMergeOpen(false);
      await onMerged?.();
    } catch (e: unknown) {
      const err = e as { message?: string };
      toast.error(err?.message ?? "Не удалось влить доп-смету");
    } finally {
      setMergeBusy(false);
    }
  }

  const linkClass = "rounded border border-border px-3 py-1.5 hover:bg-surface-muted";

  return (
    <section className="mt-6 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[14px] font-semibold text-ink">Доб-смета</h2>
          <p className="text-[12px] text-ink-3 mb-3">
            Позиции, добавленные поверх согласованной сметы — при выдаче или довезённые позже.
          </p>
        </div>
        <span className="shrink-0 text-xs text-ink-3">Смен: {addon.shifts}</span>
      </div>
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
            <tr key={l.id ?? `${l.equipmentId ?? "line"}-${i}`} className="border-b border-border last:border-0">
              <td className="py-1.5">{l.nameSnapshot}</td>
              <td className="py-1.5 text-right mono-num">×{l.quantity}</td>
              <td className="py-1.5 text-right mono-num">{formatRub(l.lineSum)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="text-[12px]">
          <tr>
            <td colSpan={2} className="pt-2 text-right">Итого:</td>
            <td className="pt-2 text-right mono-num">{formatRub(addon.subtotal)}</td>
          </tr>
          {addon.discountPercent && Number(addon.discountPercent) > 0 && (
            <tr>
              <td colSpan={2} className="text-right">Скидка {addon.discountPercent}%:</td>
              <td className="text-right mono-num">−{formatRub(addon.discountAmount)}</td>
            </tr>
          )}
          <tr className="font-semibold">
            <td colSpan={2} className="text-right">К доплате:</td>
            <td className="text-right mono-num">{formatRub(addon.totalAfterDiscount)}</td>
          </tr>
        </tfoot>
      </table>
      <div className="mt-3 flex flex-wrap gap-2 text-[12px] no-print">
        <a href={`/api/addon-estimates/${booking.id}/export/pdf`} target="_blank" rel="noreferrer" className={linkClass}>
          PDF доб-сметы
        </a>
        <a href={`/api/bookings/${booking.id}/full-estimate/export/pdf`} target="_blank" rel="noreferrer" className={linkClass}>
          PDF общая смета
        </a>
        <a href={`/api/addon-estimates/${booking.id}/export/xlsx`} target="_blank" rel="noreferrer" className={linkClass}>
          XLSX доб-сметы
        </a>
        {canMerge && (
          <button
            type="button"
            onClick={() => setMergeOpen(true)}
            className="ml-auto rounded border border-accent-border bg-accent-soft px-3 py-1.5 text-accent hover:bg-accent hover:text-surface transition-colors"
            title="Перенести доборы в основную смету — документ станет один, сумма не изменится"
          >
            Влить в основную смету
          </button>
        )}
      </div>
      <ConfirmActionModal
        open={mergeOpen}
        title="Влить доп-смету"
        subtitle={`${addon.lines.length} ${pluralize(addon.lines.length, "позиция", "позиции", "позиций")} · ${formatRub(addon.totalAfterDiscount)}`}
        message={
          "Доборы войдут в основную смету по тем же ценам, отдельный документ «Смета-добор» исчезнет.\n\nСумма к оплате не изменится — меняется только раскладка по документам. Обратно разделить смету нельзя."
        }
        confirmLabel="Влить в основную"
        tone="primary"
        loading={mergeBusy}
        onClose={() => !mergeBusy && setMergeOpen(false)}
        onConfirm={merge}
      />
    </section>
  );
}
