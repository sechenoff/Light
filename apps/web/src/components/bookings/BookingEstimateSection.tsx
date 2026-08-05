"use client";

import { useState } from "react";
import { formatMoneyRub } from "@/lib/format";

// Карточка «Смета (только оборудование)» + экспорт полной сметы (фаза 4.10,
// вынос из bookings/[id]/page.tsx). Полная смета содержит оборудование,
// доб-смету и транспорт — сервер собирает всё в один A4-документ; кнопка
// «Печать» печатает именно этот PDF (см. printEstimatePdf на странице брони).
// Без снапшота сметы — заглушка с CTA «Скачать смету (PDF)» (fallback ловит
// 404 MAIN_ESTIMATE_NOT_FOUND).

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

// Иконки — инлайн-SVG в духе Lucide (без эмодзи по канону дизайн-системы).
function IconFileText({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M8 13h8M8 17h5" />
    </svg>
  );
}

function IconTable({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path d="M3 10h18M9 10v10M15 10v10" />
    </svg>
  );
}

function IconPrinter({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9V3h12v6" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="7" rx="0.5" />
    </svg>
  );
}

function IconCode({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />
    </svg>
  );
}

export function BookingEstimateSection({
  booking,
  onDownload,
  onPrint,
  onDownloadEstimateFallback,
}: {
  booking: EstimateBooking;
  onDownload: (path: string, filename: string) => void | Promise<void>;
  onPrint: () => void | Promise<void>;
  onDownloadEstimateFallback: () => void | Promise<void>;
}) {
  // Один busy-ключ на всю секцию: экспорт — быстрые операции, параллельные
  // клики по разным кнопкам скорее дубль, чем намерение.
  const [busy, setBusy] = useState<string | null>(null);

  async function run(key: string, action: () => void | Promise<void>) {
    if (busy) return;
    setBusy(key);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  }

  const hasTransport =
    ((booking.vehicles?.length ?? 0) > 0 || Boolean(booking.vehicleId)) &&
    Number(booking.transportSubtotalRub ?? "0") > 0;

  const btnBase =
    "inline-flex items-center justify-center gap-1.5 rounded px-3 py-2 text-sm transition-colors disabled:opacity-50 disabled:cursor-default";

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
        {hasTransport && (
          <div className="text-xs text-ink-3 rounded bg-surface-subtle px-2 py-1.5">
            Без транспорта. Полная сумма к оплате — в блоке «Финансы» выше
            ({formatMoneyRub(booking.finalAmount ?? "0")}).
          </div>
        )}

        <div className="space-y-2 no-print">
          {/* Полная смета — главный клиентский документ: A4, с реквизитами,
              доб-сметой и транспортом. */}
          <div>
            <p className="text-xs text-ink-3 mb-1.5">
              Полная смета{hasTransport ? " — оборудование, доборы и транспорт" : ""}:
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button
                className={`${btnBase} bg-accent-bright text-surface hover:bg-accent`}
                disabled={busy !== null}
                onClick={() =>
                  run("full-pdf", () =>
                    onDownload(
                      `/api/bookings/${booking.id}/full-estimate/export/pdf`,
                      `booking-${booking.id}-full.pdf`,
                    ),
                  )
                }
              >
                <IconFileText className="h-3.5 w-3.5" />
                Скачать PDF
              </button>
              <button
                className={`${btnBase} border border-border hover:bg-surface-muted`}
                disabled={busy !== null}
                onClick={() => run("print", onPrint)}
                title="Печать сметы (A4)"
              >
                <IconPrinter className="h-3.5 w-3.5" />
                Печать
              </button>
              <button
                className={`${btnBase} border border-border hover:bg-surface-muted`}
                disabled={busy !== null}
                onClick={() =>
                  run("full-xlsx", () =>
                    onDownload(
                      `/api/bookings/${booking.id}/full-estimate/export/xlsx`,
                      `booking-${booking.id}-full.xlsx`,
                    ),
                  )
                }
              >
                <IconTable className="h-3.5 w-3.5" />
                Excel
              </button>
              <button
                className={`${btnBase} border border-border hover:bg-surface-muted`}
                disabled={busy !== null}
                onClick={() =>
                  run("xml", () =>
                    onDownload(`/api/bookings/${booking.id}/full-estimate.xml`, `booking-${booking.id}.xml`),
                  )
                }
                title="Выгрузка для 1С и учётных систем"
              >
                <IconCode className="h-3.5 w-3.5" />
                XML
              </button>
            </div>
          </div>

          {/* Смета только по оборудованию — вторичный сценарий, компактные ссылки. */}
          <div className="flex items-center gap-2 text-xs text-ink-3">
            <span>Только оборудование:</span>
            <button
              className="underline decoration-border underline-offset-2 hover:text-ink transition-colors disabled:opacity-50"
              disabled={busy !== null}
              onClick={() =>
                run("eq-pdf", () =>
                  onDownload(
                    `/api/estimates/${booking.estimate!.id}/export/pdf`,
                    `estimate-${booking.estimate!.id}.pdf`,
                  ),
                )
              }
            >
              PDF
            </button>
            <span aria-hidden>·</span>
            <button
              className="underline decoration-border underline-offset-2 hover:text-ink transition-colors disabled:opacity-50"
              disabled={busy !== null}
              onClick={() =>
                run("eq-xlsx", () =>
                  onDownload(
                    `/api/estimates/${booking.estimate!.id}/export/xlsx`,
                    `estimate-${booking.estimate!.id}.xlsx`,
                  ),
                )
              }
            >
              Excel
            </button>
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
        className="inline-flex items-center gap-1.5 rounded border border-border bg-surface px-3 py-2 text-sm hover:bg-surface-muted transition-colors no-print"
        onClick={onDownloadEstimateFallback}
      >
        <IconFileText className="h-3.5 w-3.5" />
        Скачать смету (PDF)
      </button>
    </div>
  );
}
