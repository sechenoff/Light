"use client";

import { StatusPill } from "../StatusPill";
import { FinanceTimeline } from "../finance/FinanceTimeline";
import { RelatedExpenses } from "../finance/RelatedExpenses";
import { formatMoneyRub } from "@/lib/format";
import type { UserRole } from "@/lib/auth";
import type { FinanceModalAction } from "./financeModalReducer";

// ── ФИНАНСЫ ── Mockup-faithful finance block (фаза 4.7, вынос из
// bookings/[id]/page.tsx, поведение 1:1). Модалки остаются в странице —
// панель открывает их через dispatch (financeModalReducer из 4.5).

export type InvoiceItem = {
  id: string;
  number: string | null;
  kind: "FULL" | "DEPOSIT" | "BALANCE" | "CORRECTION";
  status: "DRAFT" | "ISSUED" | "PARTIAL_PAID" | "PAID" | "OVERDUE" | "VOID";
  total: string;
  paidAmount: string;
  dueDate: string | null;
};

function paymentMethodLabel(method: string | null): string {
  switch (method) {
    case "CASH": return "Наличные";
    case "CARD": return "Карта";
    case "BANK_TRANSFER": return "Перевод";
    case "OTHER": return "Другое";
    default: return method ?? "—";
  }
}

/** Минимальная форма брони для панели (структурно совместима с BookingDetail). */
export type FinanceBooking = {
  id: string;
  status: string;
  paymentStatus?: string | null;
  expectedPaymentDate?: string | null;
  finalAmount?: string | null;
  amountPaid?: string | null;
  amountOutstanding?: string | null;
  legacyFinance?: boolean | null;
  discountAmount?: string | null;
  totalEstimateAmount?: string | null;
  transportSubtotalRub?: string | null;
  vehicleId?: string | null;
  vehicle?: { name?: string | null } | null;
  vehicles?: Array<{
    id: string;
    subtotalRub?: string | null;
    vehicle?: { name?: string | null } | null;
  }> | null;
  estimate?: {
    subtotal: string;
    discountAmount: string;
    discountPercent?: string | null;
    totalAfterDiscount: string;
  } | null;
  payments?: Array<{
    id: string;
    amount: string;
    method: string | null;
    note?: string | null;
    receivedAt?: string | null;
    voidedAt?: string | null;
    voidReason?: string | null;
  }> | null;
};

export interface BookingFinancePanelProps {
  booking: FinanceBooking;
  userRole: UserRole | undefined;
  isArchived: boolean;
  invoices: InvoiceItem[];
  invoicesError: boolean;
  dispatch: (action: FinanceModalAction) => void;
  onDownload: (path: string, filename: string) => void | Promise<void>;
  onReloadInvoices: () => void | Promise<void>;
  onDownloadInvoicePdf: (inv: InvoiceItem) => void | Promise<void>;
}

export function BookingFinancePanel({
  booking,
  userRole,
  isArchived,
  invoices,
  invoicesError,
  dispatch,
  onDownload,
  onReloadInvoices,
  onDownloadInvoicePdf,
}: BookingFinancePanelProps) {
  if (userRole !== "SUPER_ADMIN" && userRole !== "WAREHOUSE") return null;

  return (
    <div className="rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-border bg-surface-subtle">
        <p className="eyebrow text-accent-bright mb-1">Финансы</p>
        <div className="flex items-center gap-2 flex-wrap">
          <StatusPill
            variant={
              booking.paymentStatus === "PAID" ? "ok"
              : booking.paymentStatus === "PARTIALLY_PAID" ? "limited"
              : booking.paymentStatus === "OVERDUE" ? "alert"
              : "none"
            }
            label={
              booking.paymentStatus === "PAID" ? "Оплачен"
              : booking.paymentStatus === "PARTIALLY_PAID" ? "Частично оплачен"
              : booking.paymentStatus === "OVERDUE" ? "Просрочен"
              : "Не оплачен"
            }
          />
          {booking.expectedPaymentDate && (
            <span className="text-xs text-ink-3">
              срок {new Date(booking.expectedPaymentDate).toLocaleDateString("ru-RU")}
            </span>
          )}
        </div>
      </div>

      <div className="p-4 space-y-4">
        {/* KPI mini-strip */}
        <div className="grid grid-cols-3 gap-2 p-3 bg-surface-muted rounded-lg">
          <div>
            <div className="eyebrow text-ink-3 mb-1">Сумма брони</div>
            <div className="text-lg font-semibold mono-num text-ink">{formatMoneyRub(booking.finalAmount ?? "0")}</div>
          </div>
          <div>
            <div className="eyebrow text-ink-3 mb-1">Получено</div>
            <div className="text-lg font-semibold mono-num text-emerald">{formatMoneyRub(booking.amountPaid ?? "0")}</div>
          </div>
          <div>
            <div className="eyebrow text-ink-3 mb-1">К получению</div>
            <div className={`text-lg font-semibold mono-num ${Number(booking.amountOutstanding ?? "0") > 0 ? "text-rose" : "text-ink"}`}>
              {formatMoneyRub(booking.amountOutstanding ?? "0")}
            </div>
          </div>
        </div>

        {/* Разбивка «Сумма брони» — единственный источник истины для оператора.
            finalAmount = аренда-после-скидки (снапшот сметы) + транспорт.
            Показываем явно, чтобы расхождение с блоком «Смета» (там только
            оборудование, без транспорта) не сбивало с толку. */}
        {(() => {
          const equipAfterDiscount = booking.estimate
            ? Number(booking.estimate.totalAfterDiscount)
            : Number(booking.finalAmount ?? "0") - Number(booking.transportSubtotalRub ?? "0");
          const transport = Number(booking.transportSubtotalRub ?? "0");
          const transportVehicles = booking.vehicles ?? [];
          const hasMultiVehicles = transportVehicles.length > 0;
          const hasTransport =
            (hasMultiVehicles || Boolean(booking.vehicleId)) && transport > 0;
          const finalNum = Number(booking.finalAmount ?? "0");
          const discount = booking.estimate ? Number(booking.estimate.discountAmount) : Number(booking.discountAmount ?? "0");
          const rentBeforeDiscount = booking.estimate ? Number(booking.estimate.subtotal) : Number(booking.totalEstimateAmount ?? "0");
          // Сигнал рассинхрона: снапшот сметы + транспорт ≠ сохранённый finalAmount.
          const recomposed = equipAfterDiscount + transport;
          const drifted = booking.estimate != null && Math.abs(recomposed - finalNum) > 0.01;
          return (
            <div className="rounded-lg border border-border bg-surface px-3 py-2.5 text-sm space-y-1.5">
              <div className="eyebrow text-ink-3 mb-1">Из чего складывается сумма</div>
              <div className="flex justify-between">
                <span className="text-ink-2">Аренда оборудования</span>
                <span className="mono-num text-ink-2">{formatMoneyRub(rentBeforeDiscount)}</span>
              </div>
              {discount > 0 && (
                <div className="flex justify-between">
                  <span className="text-ink-2">
                    Скидка{booking.estimate?.discountPercent ? ` ${booking.estimate.discountPercent}%` : ""}
                  </span>
                  <span className="mono-num text-rose">−{formatMoneyRub(discount)}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-ink-2">Аренда после скидки</span>
                <span className="mono-num text-ink-2">{formatMoneyRub(equipAfterDiscount)}</span>
              </div>
              {hasTransport && hasMultiVehicles && (
                <>
                  {transportVehicles.map((v) => (
                    <div key={v.id} className="flex justify-between">
                      <span className="text-ink-2">
                        Транспорт{v.vehicle?.name ? ` (${v.vehicle.name})` : ""}
                      </span>
                      <span className="mono-num text-ink-2">
                        +{formatMoneyRub(v.subtotalRub ?? "0")}
                      </span>
                    </div>
                  ))}
                </>
              )}
              {hasTransport && !hasMultiVehicles && (
                <div className="flex justify-between">
                  <span className="text-ink-2">
                    Доставка / транспорт{booking.vehicle?.name ? ` (${booking.vehicle.name})` : ""}
                  </span>
                  <span className="mono-num text-ink-2">+{formatMoneyRub(transport)}</span>
                </div>
              )}
              <div className="flex justify-between border-t border-border pt-1.5 font-semibold">
                <span className="text-ink">Сумма брони</span>
                <span className="mono-num text-ink">{formatMoneyRub(booking.finalAmount ?? "0")}</span>
              </div>
              {drifted && (
                <div className="mt-1 rounded bg-amber-soft border border-amber-border px-2 py-1 text-xs text-amber">
                  Смета пересчитана после изменений — итог брони ({formatMoneyRub(finalNum)}) актуальнее
                  суммы в снапшоте сметы ниже ({formatMoneyRub(recomposed)}).
                </div>
              )}
            </div>
          );
        })()}

        {/* CTA row (desktop) */}
        <div className="hidden md:flex flex-wrap gap-2">
          {/* Записать платёж: SA всегда; WH при ISSUED|RETURNED. Не для архивных. */}
          {!isArchived && (userRole === "SUPER_ADMIN" ||
            (userRole === "WAREHOUSE" &&
              (booking.status === "ISSUED" || booking.status === "RETURNED") &&
              (booking.amountOutstanding == null || Number(booking.amountOutstanding) > 0))
          ) && (
            <button
              className="rounded bg-accent-bright text-white px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity"
              onClick={() => dispatch({ type: "openPayment" })}
            >
              + Записать платёж
            </button>
          )}

          {/* Отменить с депозитом (SA only) */}
          {userRole === "SUPER_ADMIN" &&
            ["DRAFT", "PENDING_APPROVAL", "CONFIRMED"].includes(booking.status) &&
            Number(booking.amountPaid ?? "0") > 0 && (
              <button
                className="rounded border border-rose px-3 py-2 text-sm text-rose hover:bg-rose-soft transition-colors"
                onClick={() => dispatch({ type: "openCancelDeposit" })}
              >
                Отменить бронь
              </button>
          )}

          {/* Счёт PDF — legacy */}
          {booking.legacyFinance !== false && (
            <button
              className="rounded border border-border px-3 py-2 text-sm hover:bg-surface-subtle transition-colors"
              onClick={() => onDownload(`/api/bookings/${booking.id}/invoice.pdf`, `Счёт_${booking.id}.pdf`)}
            >
              📄 Скачать счёт PDF
            </button>
          )}

          {/* Акт PDF */}
          {(() => {
            const canAct = booking.status === "RETURNED" && Number(booking.amountOutstanding ?? "0") === 0;
            const actHint = "Акт доступен после возврата оборудования и закрытия долга";
            return (
              <button
                className={`rounded border px-3 py-2 text-sm transition-colors ${
                  canAct
                    ? "border-border hover:bg-surface-subtle"
                    : "border-border text-ink-3 cursor-not-allowed opacity-50"
                }`}
                title={canAct ? "Скачать акт PDF" : actHint}
                aria-label={canAct ? "Скачать акт PDF" : actHint}
                disabled={!canAct}
                onClick={canAct ? () => onDownload(`/api/bookings/${booking.id}/act.pdf`, `Акт_${booking.id}.pdf`) : undefined}
              >
                📄 Скачать акт PDF
              </button>
            );
          })()}
        </div>

        {/* Счета (Phase 2, post-cutoff) */}
        {booking.legacyFinance === false && userRole === "SUPER_ADMIN" && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="eyebrow">Счета</p>
              <button
                onClick={() => dispatch({ type: "openCreateInvoice" })}
                className="text-[11px] px-2 py-1 bg-accent-bright text-white rounded hover:opacity-90"
              >
                + Создать счёт
              </button>
            </div>
            {invoicesError ? (
              <div className="text-xs text-rose py-2">
                Не удалось загрузить счета.{" "}
                <button type="button" onClick={() => onReloadInvoices()} className="underline hover:text-rose/80">
                  Повторить
                </button>
              </div>
            ) : invoices.length === 0 ? (
              <div className="text-xs text-ink-3 py-2">Счетов пока нет</div>
            ) : (
              <div className="border border-border rounded-lg overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-surface-subtle border-b border-border text-ink-2">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">№</th>
                      <th className="text-left px-3 py-2 font-medium">Тип</th>
                      <th className="text-right px-3 py-2 font-medium">Сумма</th>
                      <th className="text-right px-3 py-2 font-medium">Срок</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((inv) => {
                      const invStatusVariant = (
                        inv.status === "DRAFT" ? "view" :
                        inv.status === "ISSUED" ? "info" :
                        inv.status === "PARTIAL_PAID" ? "warn" :
                        inv.status === "PAID" ? "ok" :
                        inv.status === "OVERDUE" ? "alert" : "none"
                      ) as "view" | "info" | "warn" | "ok" | "alert" | "none";
                      const invStatusLabel = {
                        DRAFT: "Черновик", ISSUED: "Выставлен", PARTIAL_PAID: "Частично",
                        PAID: "Оплачен", OVERDUE: "Просрочен", VOID: "Аннулирован",
                      }[inv.status] ?? inv.status;
                      const kindLabel = { FULL: "Полный", DEPOSIT: "Предоплата", BALANCE: "Остаток", CORRECTION: "Корректировка" }[inv.kind] ?? inv.kind;
                      return (
                        <tr key={inv.id} className="border-t border-border">
                          <td className="px-3 py-2 font-mono text-ink-2">{inv.number ?? "—"}</td>
                          <td className="px-3 py-2 text-ink-2">{kindLabel}</td>
                          <td className="px-3 py-2 text-right mono-num">{formatMoneyRub(inv.total)}</td>
                          <td className="px-3 py-2 text-right text-ink-3">
                            {inv.dueDate ? new Date(inv.dueDate).toLocaleDateString("ru-RU") : "—"}
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-1.5 justify-end">
                              <StatusPill variant={invStatusVariant} label={invStatusLabel} />
                              {inv.number && (
                                <button
                                  onClick={() => onDownloadInvoicePdf(inv)}
                                  className="text-ink-3 hover:text-accent px-1"
                                  title="PDF"
                                  aria-label="Скачать PDF счёта"
                                >
                                  📄
                                </button>
                              )}
                              {["ISSUED", "PARTIAL_PAID", "PAID"].includes(inv.status) && (
                                <button
                                  onClick={() => dispatch({ type: "openRefund", invoiceId: inv.id })}
                                  className="text-amber hover:underline"
                                >
                                  ↩ Возврат
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <button
              onClick={() => dispatch({ type: "openCreditNote" })}
              className="mt-2 text-[11px] text-accent hover:underline"
            >
              Кредит-ноты клиента →
            </button>
          </div>
        )}

        {/* Платежи */}
        {(booking.payments ?? []).length > 0 && (
          <div>
            <p className="eyebrow mb-2">Платежи</p>
            <div className="divide-y divide-border">
              {(booking.payments ?? []).map((p) => {
                // Аннулирование пишет voidedAt (paymentService.voidPayment);
                // direction остаётся INCOME — никакого значения "VOID" в
                // enum PaymentDirection нет. Сервер исключает voided из
                // сумм (recomputeBookingFinance), здесь — только отображение.
                const isVoided = Boolean(p.voidedAt);
                return (
                  <div
                    key={p.id}
                    className={`flex items-center justify-between gap-2 py-2.5 text-sm ${isVoided ? "opacity-60" : ""}`}
                  >
                    <div className="min-w-0">
                      <span className={isVoided ? "line-through" : ""}>
                        <span className={`font-semibold mono-num ${isVoided ? "text-ink-3" : "text-emerald"}`}>
                          +{formatMoneyRub(p.amount)}
                        </span>
                        <span className="text-ink-3 mx-1.5">·</span>
                        <span className={isVoided ? "text-ink-3" : "text-ink-2"}>{paymentMethodLabel(p.method)}</span>
                        {p.note && <span className="text-xs text-ink-3 ml-1.5 truncate">{p.note}</span>}
                      </span>
                      <div className="text-xs text-ink-3 mt-0.5">
                        {p.receivedAt ? new Date(p.receivedAt).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" }) : "—"}
                      </div>
                      {isVoided && (
                        <div className="text-xs text-rose mt-0.5">
                          Аннулирован{p.voidReason ? `: ${p.voidReason}` : ""}
                        </div>
                      )}
                    </div>
                    {!isVoided && userRole === "SUPER_ADMIN" && (
                      <div className="flex gap-1.5 shrink-0">
                        <button
                          className="text-xs text-rose border border-rose-border rounded px-2 py-0.5 hover:bg-rose-soft transition-colors"
                          onClick={() => dispatch({ type: "openVoidPayment", paymentId: p.id })}
                        >
                          ⊘ Аннулировать
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Хронология денег (SA only, collapsible) */}
        {userRole === "SUPER_ADMIN" && (
          <details className="group">
            <summary className="cursor-pointer flex items-center justify-between px-3 py-2.5 bg-surface-muted rounded-lg text-sm font-medium text-ink list-none hover:bg-surface-subtle transition-colors">
              <span>📊 Хронология денег</span>
              <span className="text-ink-3 group-open:rotate-180 transition-transform text-xs">▾</span>
            </summary>
            <div className="pt-3 px-1">
              <FinanceTimeline bookingId={booking.id} />
            </div>
          </details>
        )}

        {/* Связанные расходы (SA only, collapsible) */}
        {userRole === "SUPER_ADMIN" && (
          <details className="group">
            <summary className="cursor-pointer flex items-center justify-between px-3 py-2.5 bg-surface-muted rounded-lg text-sm font-medium text-ink list-none hover:bg-surface-subtle transition-colors">
              <span>🛒 Связанные расходы</span>
              <span className="text-ink-3 group-open:rotate-180 transition-transform text-xs">▾</span>
            </summary>
            <div className="pt-3 px-1">
              <RelatedExpenses bookingId={booking.id} />
            </div>
          </details>
        )}

        {/* WAREHOUSE finance note */}
        {userRole === "WAREHOUSE" && (
          <div className="text-xs text-ink-3 bg-accent-soft border border-accent-border rounded-lg px-3 py-2">
            <strong className="text-accent-bright">Доступ склада:</strong> только наличные/карта · до 100 000 ₽ за операцию
          </div>
        )}
      </div>
    </div>
  );
}
