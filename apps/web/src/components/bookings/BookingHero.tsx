"use client";

import { StatusPill } from "../StatusPill";
import { formatMoneyRub } from "@/lib/format";
import {
  bookingStatusLabel as statusText,
  bookingStatusVariant as statusVariant,
  type BookingStatus,
} from "@/lib/bookingConstants";

// ───────── Hero + Finance strip + печатная шапка (фаза 4.10, вынос из
// bookings/[id]/page.tsx, поведение 1:1). По мокапу booking-detail-v2.html:
// крупный заголовок брони + полоса из 4 финансовых карточек — «лицо» страницы.
// В retro-edit режиме экранная часть скрывается (гейт showHero), печатная
// шапка рендерится всегда (видна только через @media print).

/** Минимальная форма брони для hero (структурно совместима с BookingDetail). */
export type HeroBooking = {
  id: string;
  status: BookingStatus;
  startDate: string;
  endDate: string;
  projectName: string;
  client: { name: string };
  paymentStatus?: string | null;
  finalAmount?: string | null;
  amountPaid?: string | null;
  amountOutstanding?: string | null;
  discountPercent?: string | null;
  discountAmount?: string | null;
  manualFinalAmount?: string | null;
};

export function BookingHero({ booking, showHero }: { booking: HeroBooking; showHero: boolean }) {
  return (
    <>
      {showHero && (() => {
        const startD = new Date(booking.startDate);
        const endD = new Date(booking.endDate);
        const tz = { timeZone: "Europe/Moscow" } as const;
        const heroDate = startD.toLocaleDateString("ru-RU", {
          day: "2-digit", month: "long", year: "numeric", ...tz,
        });
        const project =
          booking.projectName?.trim() && booking.projectName.trim() !== "Проект"
            ? booking.projectName.trim()
            : "Без названия";
        // Кол-во смен (приблизительно: целые сутки между startDate и endDate)
        const msPerDay = 24 * 60 * 60 * 1000;
        const shifts = Math.max(1, Math.ceil((endD.getTime() - startD.getTime()) / msPerDay));
        const periodStr =
          startD.toLocaleDateString("ru-RU", { day: "2-digit", month: "short", ...tz }) +
          " – " +
          endD.toLocaleDateString("ru-RU", { day: "2-digit", month: "short", ...tz });

        // Платёжный статус → пилка (отдельная функция)
        const payStatus = booking.paymentStatus ?? "NOT_PAID";
        const payLabel =
          payStatus === "PAID" ? "Оплачено"
          : payStatus === "PARTIALLY_PAID" ? "Частично"
          : payStatus === "OVERDUE" ? "Просрочено"
          : "Не оплачено";
        const payVariant: "ok" | "warn" | "alert" | "none" =
          payStatus === "PAID" ? "ok"
          : payStatus === "OVERDUE" ? "alert"
          : payStatus === "PARTIALLY_PAID" ? "warn"
          : "none";

        const total = booking.finalAmount ?? "0";
        const paid = booking.amountPaid ?? "0";
        const outstanding = booking.amountOutstanding ?? "0";
        const discountPct = booking.discountPercent ? Number(booking.discountPercent) : 0;
        const discountAmount = booking.discountAmount ?? "0";

        // Финансовые карточки — стили под мокап. Цветовая семантика:
        //  • Оплачено → emerald, если PAID; иначе нейтральный
        //  • Остаток → rose, если OVERDUE; иначе нейтральный
        //  • Итого / Скидка — нейтральные.
        const paidCardTone = payStatus === "PAID" ? "fin--ok" : "";
        const outstandingTone =
          payStatus === "OVERDUE" ? "fin--alert" : "";

        return (
          <>
            <section className="mb-5 no-print">
              <p className="eyebrow text-ink-3">Бронь · {heroDate}</p>
              <h1 className="mt-1 font-cond text-3xl md:text-4xl leading-tight tracking-tight text-ink">
                {project}
              </h1>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink-3">
                <StatusPill variant={statusVariant(booking.status)} label={statusText(booking.status)} />
                <StatusPill variant={payVariant} label={payLabel} />
                <span className="text-border-strong">·</span>
                <span>{booking.client.name}</span>
                <span className="text-border-strong">·</span>
                <span className="mono-num">
                  {periodStr} · {shifts} {shifts === 1 ? "смена" : shifts < 5 ? "смены" : "смен"}
                </span>
              </div>
            </section>

            <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5 no-print">
              <div className="rounded-lg border border-border bg-surface shadow-xs p-3">
                <p className="eyebrow">
                  Итого
                  {booking.manualFinalAmount != null && (
                    <span className="ml-1.5 align-middle inline-block bg-amber text-white text-[9px] px-1 py-0.5 rounded font-semibold tracking-wide">
                      РУЧНОЙ
                    </span>
                  )}
                </p>
                <p className="mt-1.5 font-cond text-2xl font-semibold mono-num text-ink">
                  {formatMoneyRub(total)}
                </p>
                <p className="mt-0.5 text-[11px] text-ink-3">
                  {booking.manualFinalAmount != null
                    ? "override SUPER_ADMIN'а — автомат не применяется"
                    : "оборудование + транспорт − скидка"}
                </p>
              </div>
              <div className={`rounded-lg border shadow-xs p-3 ${paidCardTone ? "border-emerald-border bg-gradient-to-b from-emerald-soft to-surface" : "border-border bg-surface"}`}>
                <p className="eyebrow">Оплачено</p>
                <p className={`mt-1.5 font-cond text-2xl font-semibold mono-num ${paidCardTone ? "text-emerald" : "text-ink"}`}>
                  {formatMoneyRub(paid)}
                </p>
                <p className="mt-0.5 text-[11px] text-ink-3">
                  {payStatus === "PAID" ? "100% оплачено" : "по платежам"}
                </p>
              </div>
              <div className={`rounded-lg border shadow-xs p-3 ${outstandingTone ? "border-rose-border bg-gradient-to-b from-rose-soft to-surface" : "border-border bg-surface"}`}>
                <p className="eyebrow">Остаток</p>
                <p className={`mt-1.5 font-cond text-2xl font-semibold mono-num ${outstandingTone ? "text-rose" : Number(outstanding) === 0 ? "text-ink-3" : "text-ink"}`}>
                  {formatMoneyRub(outstanding)}
                </p>
                <p className="mt-0.5 text-[11px] text-ink-3">
                  {payStatus === "OVERDUE" ? "просрочен" : Number(outstanding) === 0 ? "ничего не должны" : "к оплате"}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-surface shadow-xs p-3">
                <p className="eyebrow">Скидка</p>
                <p className="mt-1.5 font-cond text-2xl font-semibold mono-num text-rose">
                  {discountPct > 0 ? `−${discountPct}%` : "—"}
                </p>
                <p className="mt-0.5 text-[11px] text-ink-3">
                  {discountPct > 0 ? `−${formatMoneyRub(discountAmount)}` : "не применялась"}
                </p>
              </div>
            </section>
          </>
        );
      })()}

      {/*
        Печатная шапка-реквизиты. Видна ТОЛЬКО при печати через @media print
        (`.print-only-block { display:none }` по умолчанию → `display:block`
        в print-блоке ниже). На экране не должна занимать пиксели.
      */}
      <div className="print-only-block">
        <div className="print-header">
          <div className="print-header-inner">
            <div>
              <div className="print-org">Светобаза · аренда осветительного оборудования</div>
              <div className="print-org-sub">
                ИП Сеченов В.А. · ИНН 7700000000 · +7 (495) 123-45-67 · svetobazarent.ru
              </div>
            </div>
            <div className="print-doc">
              <div>Смета к броне</div>
              <div className="print-doc-num">
                № {booking.id.slice(0, 8)}… от {new Date().toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" })}
              </div>
            </div>
          </div>
          <div className="print-hero">
            <div className="print-eyebrow">
              Бронь · {new Date(booking.startDate).toLocaleDateString("ru-RU", { day: "2-digit", month: "long", year: "numeric", timeZone: "Europe/Moscow" })}
            </div>
            <h1 className="print-title">{booking.projectName}</h1>
            <div className="print-meta">
              <span>{statusText(booking.status)}</span>
              {booking.paymentStatus && <span> · {(() => {
                switch (booking.paymentStatus) {
                  case "PAID": return "Оплачено";
                  case "PARTIALLY_PAID": return "Частично оплачено";
                  case "OVERDUE": return "Просрочено";
                  default: return "Не оплачено";
                }
              })()}</span>}
              <span> · {booking.client.name}</span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
