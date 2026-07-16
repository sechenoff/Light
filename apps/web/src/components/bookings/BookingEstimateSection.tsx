"use client";

import { formatMoneyRub } from "@/lib/format";

// Карточка «Смета (только оборудование)» + экспорт полной сметы (фаза 4.10,
// вынос из bookings/[id]/page.tsx, поведение 1:1). Позиции сметы не дублируются
// — они показаны выше в таблице «Позиции брони». Без снапшота сметы — заглушка
// с CTA «Скачать смету (PDF)» (fallback ловит 404 MAIN_ESTIMATE_NOT_FOUND).

/** Минимальная форма брони для блока сметы (структурно совместима с BookingDetail). */
export type EstimateBooking = {
  id: string;
  finalAmount?: string | null;
  transportSubtotalRub?: string | null;
  vehicleId?: string | null;
  vehicles?: Array<{ id: string }> | null;
  estimate?: {
    id: string;
    shifts: number;
    subtotal: string;
    discountAmount: string;
    totalAfterDiscount: string;
    commentSnapshot?: string | null;
  } | null;
};

export function BookingEstimateSection({
  booking,
  onDownload,
  onDownloadEstimateFallback,
}: {
  booking: EstimateBooking;
  onDownload: (path: string, filename: string) => void | Promise<void>;
  onDownloadEstimateFallback: () => void | Promise<void>;
}) {
  return booking.estimate ? (
    <div className="rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
      <div className="p-3 border-b border-border bg-surface-subtle flex items-center justify-between">
        <p className="eyebrow">Смета (только оборудование)</p>
        <span className="text-xs text-ink-3">Шифты: {booking.estimate.shifts}</span>
      </div>
      <div className="p-3 space-y-3">
        <div className="text-sm flex justify-between">
          <span className="text-ink-2">Итого</span>
          <span className="font-medium mono-num">{formatMoneyRub(booking.estimate.subtotal)}</span>
        </div>
        <div className="text-sm flex justify-between">
          <span className="text-ink-2">Скидка</span>
          <span className="font-medium mono-num">-{formatMoneyRub(booking.estimate.discountAmount)}</span>
        </div>
        <div className="text-sm flex justify-between pt-1 border-t border-border">
          <span className="font-semibold text-ink">После скидки</span>
          <span className="font-semibold text-ink mono-num">{formatMoneyRub(booking.estimate.totalAfterDiscount)}</span>
        </div>
        {((booking.vehicles?.length ?? 0) > 0 || Boolean(booking.vehicleId)) &&
          Number(booking.transportSubtotalRub ?? "0") > 0 && (
            <div className="text-xs text-ink-3 rounded bg-surface-subtle px-2 py-1.5">
              Без транспорта. Полная сумма к оплате — в блоке «Финансы» выше
              ({formatMoneyRub(booking.finalAmount ?? "0")}).
            </div>
          )}

        <div className="space-y-2 no-print">
          {/* Equipment-only smeta */}
          <div>
            <p className="text-xs text-ink-3 mb-1.5">Только оборудование:</p>
            <div className="flex gap-2">
              <button
                className="flex-1 rounded border border-border px-3 py-2 text-sm hover:bg-surface-muted transition-colors"
                onClick={() =>
                  onDownload(
                    `/api/estimates/${booking.estimate!.id}/export/xlsx`,
                    `estimate-${booking.estimate!.id}.xlsx`,
                  )
                }
              >
                📊 Excel
              </button>
              <button
                className="flex-1 rounded border border-border px-3 py-2 text-sm hover:bg-surface-muted transition-colors"
                onClick={() =>
                  onDownload(
                    `/api/estimates/${booking.estimate!.id}/export/pdf`,
                    `estimate-${booking.estimate!.id}.pdf`,
                  )
                }
              >
                📄 PDF
              </button>
            </div>
          </div>
          {/* Full smeta — includes transport. Highlighted as primary action. */}
          <div>
            <p className="text-xs text-ink-3 mb-1.5">Полная смета (с транспортом):</p>
            <div className="flex gap-2 flex-wrap">
              <button
                className="flex-1 min-w-[80px] rounded border border-border px-3 py-2 text-sm hover:bg-surface-muted transition-colors"
                onClick={() =>
                  onDownload(
                    `/api/bookings/${booking.id}/full-estimate/export/xlsx`,
                    `booking-${booking.id}-full.xlsx`,
                  )
                }
              >
                📊 Excel
              </button>
              <button
                className="flex-1 min-w-[80px] rounded bg-accent-bright text-white px-3 py-2 text-sm hover:bg-accent transition-colors"
                onClick={() =>
                  onDownload(
                    `/api/bookings/${booking.id}/full-estimate/export/pdf`,
                    `booking-${booking.id}-full.pdf`,
                  )
                }
              >
                📄 PDF
              </button>
              <button
                className="flex-1 min-w-[80px] rounded border border-border px-3 py-2 text-sm hover:bg-surface-muted transition-colors"
                onClick={() =>
                  onDownload(
                    `/api/bookings/${booking.id}/full-estimate.xml`,
                    `booking-${booking.id}.xml`,
                  )
                }
                title="Выгрузка для 1С и учётных систем"
              >
                ⟨/⟩ XML
              </button>
              <button
                className="flex-1 min-w-[80px] rounded border border-border px-3 py-2 text-sm hover:bg-surface-muted transition-colors"
                onClick={() => window.print()}
              >
                🖨 Печать
              </button>
            </div>
          </div>
        </div>

        {/* Позиции сметы показаны выше в таблице «Позиции брони»
            (с ценами/суммами) — здесь не дублируем. */}
        <div className="text-xs text-ink-3 border-t border-border pt-2">
          Состав позиций — в таблице «Позиции брони» (с ценами).
        </div>

        {booking.estimate.commentSnapshot ? <div className="text-xs text-ink-3">{booking.estimate.commentSnapshot}</div> : null}
      </div>
    </div>
  ) : (
    <div className="rounded-lg border border-border bg-surface-subtle p-3 text-sm text-ink-2 space-y-2">
      <div>Смета пока не сформирована (возможно, это черновик).</div>
      {/* CTA вместо тупика: у новых черновиков MAIN-смета создаётся
          сразу (тогда выше рендерится полный блок экспорта); у старых
          без сметы сервер ответит 404 MAIN_ESTIMATE_NOT_FOUND — покажем
          понятный тост вместо молчаливой заглушки. */}
      <button
        type="button"
        className="rounded border border-border bg-surface px-3 py-2 text-sm hover:bg-surface-muted transition-colors no-print"
        onClick={onDownloadEstimateFallback}
      >
        📄 Скачать смету (PDF)
      </button>
    </div>
  );
}
