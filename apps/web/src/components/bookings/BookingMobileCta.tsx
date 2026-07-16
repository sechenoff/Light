"use client";

import type { UserRole } from "@/lib/auth";
import type { FinanceModalAction } from "./financeModalReducer";

// B2: Mobile-only sticky bottom CTA, 390px (фаза 4.10, вынос из
// bookings/[id]/page.tsx, поведение 1:1). Зеркалит inline-CTA финансового
// блока: платёж (primary), PDF счёта (только legacy-финансы), PDF акта.

export type MobileCtaBooking = {
  id: string;
  status: string;
  legacyFinance?: boolean | null;
  amountOutstanding?: string | null;
};

export function BookingMobileCta({
  booking,
  userRole,
  isArchived,
  dispatch,
  onDownload,
}: {
  booking: MobileCtaBooking | null;
  userRole: UserRole | undefined;
  isArchived: boolean;
  dispatch: (action: FinanceModalAction) => void;
  onDownload: (path: string, filename: string) => void | Promise<void>;
}) {
  if (!booking || (userRole !== "SUPER_ADMIN" && userRole !== "WAREHOUSE")) return null;
  if (booking.status === "CANCELLED" || booking.status === "DRAFT" || booking.status === "PENDING_APPROVAL") return null;

  return (
    <div className="md:hidden fixed bottom-0 left-0 right-0 z-30 flex gap-2 px-3 py-3 bg-surface border-t border-border shadow-lg no-print">
      {/* ₽ Платёж — primary. Не для архивных. */}
      {!isArchived && (userRole === "SUPER_ADMIN" ||
        ((booking.status === "ISSUED" || booking.status === "RETURNED") &&
          (booking.amountOutstanding == null || Number(booking.amountOutstanding) > 0))
      ) && (
        <button
          className="flex-1 rounded bg-accent-bright text-white px-2 py-2.5 text-sm font-medium hover:opacity-90 transition-opacity"
          onClick={() => dispatch({ type: "openPayment" })}
        >
          ₽ Платёж
        </button>
      )}
      {/* PDF Счёт — только legacy-финансы (как на десктопе). У Phase-2
          броней легаси-invoice.pdf отдаёт 409/неверный PDF. */}
      {booking.legacyFinance !== false && (
        <button
          className="flex-1 rounded border border-border px-2 py-2.5 text-sm font-medium hover:bg-surface-subtle transition-colors"
          onClick={() => onDownload(`/api/bookings/${booking.id}/invoice.pdf`, `Счёт_${booking.id}.pdf`)}
        >
          📄 Счёт
        </button>
      )}
      {/* PDF Акт */}
      {(() => {
        const canAct = booking.status === "RETURNED" && Number(booking.amountOutstanding ?? "0") === 0;
        const actHint = "Акт доступен после возврата оборудования и закрытия долга";
        return (
          <button
            className={`flex-1 rounded border px-2 py-2.5 text-sm font-medium transition-colors ${
              canAct ? "border-border hover:bg-surface-subtle" : "border-border text-ink-3 opacity-50 cursor-not-allowed"
            }`}
            title={canAct ? "Скачать акт PDF" : actHint}
            aria-label={canAct ? "Скачать акт PDF" : actHint}
            disabled={!canAct}
            onClick={canAct ? () => onDownload(`/api/bookings/${booking.id}/act.pdf`, `Акт_${booking.id}.pdf`) : undefined}
          >
            PDF Акт
          </button>
        );
      })()}
    </div>
  );
}
