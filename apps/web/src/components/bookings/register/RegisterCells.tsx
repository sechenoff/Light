"use client";
import { useEffect, useRef } from "react";
import Link from "next/link";
import { type BookingRegisterRow as Row } from "@light-rental/shared";
import { PaymentBreakdown } from "./RegisterPayment";
export { PaymentState } from "./RegisterPayment";
import { formatRub } from "../../../lib/format";
import {
  bookingStatusLabel,
  bookingStatusVariant,
} from "../../../lib/bookingConstants";
import { StatusPill } from "../../StatusPill";
import { registerDate } from "./model";
import { button } from "./RegisterFilters";
export function RentalState({ row: r, onIssues }: { row: Row; onIssues?: () => void }) {
  return (
    <div className="space-y-1">
      <StatusPill
        variant={bookingStatusVariant(r.status)}
        label={bookingStatusLabel(r.status)}
      />
      {r.onHand > 0 && (
        <p className="text-xs text-ink-2">На руках: {r.onHand} ед.</p>
      )}
      {r.projectSummary && (
        <p className="text-xs text-ink-3">
          Доборы: {r.projectSummary.plannedQuantity} ед.
        </p>
      )}
      {r.returnOverdue && (
        <p className="text-xs font-medium text-rose">Задержан возврат</p>
      )}
      {r.issues ? (
        <div className="flex flex-col items-center gap-1">
          {r.issues.missingQuantity > 0 && <button type="button" onClick={onIssues} className="rounded border border-amber/20 bg-amber-soft px-2 py-1.5 text-xs font-medium text-amber underline decoration-dotted underline-offset-2 hover:decoration-solid" aria-label={`Недостача: ${r.issues.missingQuantity} шт. · ${r.projectName}`}>Недостача: {r.issues.missingQuantity} шт.</button>}
          {r.issues.damageQuantity > 0 && <button type="button" onClick={onIssues} className="rounded border border-amber/20 bg-amber-soft px-2 py-1.5 text-xs font-medium text-amber underline decoration-dotted underline-offset-2 hover:decoration-solid" aria-label={`Повреждения: ${r.issues.damageQuantity} шт. · ${r.projectName}`}>Повреждения: {r.issues.damageQuantity} шт.</button>}
          {r.issues.overdueCases > 0 && <p className="text-xs text-rose">Срок решения просрочен</p>}
          {!r.issues.openCases && r.issues.closedCases > 0 && <button type="button" onClick={onIssues} className="min-h-8 text-xs text-ink-3 underline decoration-dotted underline-offset-2">История проблем: {r.issues.closedCases}</button>}
        </div>
      ) : r.openProblems > 0 ? <button type="button" onClick={onIssues} className="min-h-8 text-xs text-amber underline">Проблемы: {r.openProblems}</button> : null}
      {r.needsReview && !r.returnOverdue && !r.openProblems && !r.issues?.openCases && (
        <p className="text-xs text-amber">{r.status === "CANCELLED" ? "Проверить расчёты при отмене" : "Даты прошли · проверьте статус"}</p>
      )}
    </div>
  );
}
export function RentalDates({ row: r }: { row: Row }) {
  return (
    <div className="space-y-1 whitespace-nowrap text-xs text-ink-2">
      <p>
        <span className="mr-1 text-ink-3">с</span>{" "}
        {registerDate(r.startDate, r.mode !== "PROJECT")}
      </p>
      <p>
        <span className="mr-1 text-ink-3">по</span>{" "}
        {registerDate(r.endDate, r.mode !== "PROJECT")}
      </p>
      {r.projectSummary && (
        <p className="text-indigo">
          Периодов закрыто: {r.projectSummary.periodCount}
        </p>
      )}
    </div>
  );
}
export function DueDate({ row: r }: { row: Row }) {
  const overdue = Number(r.overdueAmount) > 0;
  return (
    <div className="space-y-1 text-xs">
      <p className="text-ink-2">
        {Number(r.amountOutstanding) > 0
          ? registerDate(r.expectedPaymentDate, true)
          : "Долга нет"}
      </p>
      {overdue && (
        <>
          <p className="font-medium text-rose">
            {r.overdueDays > 0
              ? `Просрочено ${r.overdueDays} дн.`
              : "Срок истёк сегодня"}
          </p>
          {r.mode === "PROJECT" && (
            <p className="text-rose">{formatRub(r.overdueAmount)} просрочено</p>
          )}
        </>
      )}
      {r.projectSummary?.nextCloseDate && (
        <p className="text-ink-3">
          Период до {registerDate(r.projectSummary.nextCloseDate)}
        </p>
      )}
    </div>
  );
}
export function RegisterDetail({
  row: r,
  close,
  pay,
  primary,
  primaryLabel,
  onIssues,
}: {
  row: Row;
  close: () => void;
  pay?: () => void;
  primary: () => void;
  primaryLabel: string;
  onIssues: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      className="fixed inset-y-0 left-auto right-0 m-0 h-dvh max-h-none w-full max-w-md border-l border-border bg-surface p-0 text-ink shadow-xl backdrop:bg-scrim/40"
    >
      <div className="flex min-h-full flex-col p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="eyebrow text-ink-3">
              Быстрый просмотр · {r.docNumber ?? r.id.slice(-6)}
            </p>
            <h2 className="mt-2 break-words text-xl font-semibold">
              {r.projectName || "Без названия"}
            </h2>
            <p className="mt-1 text-ink-2">{r.client.name}</p>
          </div>
          <button
            onClick={close}
            className={button}
            aria-label="Закрыть просмотр"
          >
            ×
          </button>
        </div>
        <div className="my-5 space-y-5 divide-y divide-border">
          <section>
            <RentalState row={r} onIssues={onIssues} />
            <div className="mt-3">
              <RentalDates row={r} />
            </div>
            <p className="mt-1 text-xs text-ink-3">
              {r.mode === "PROJECT"
                ? "Даты проекта включительно; время доборов уточняется в карточке."
                : "Время по Москве"}
            </p>
          </section>
          <section className="pt-4">
            <p className="eyebrow mb-2">Расчёты</p>
            <PaymentBreakdown row={r} pay={pay} />
            <div className="mt-3"><DueDate row={r} /></div>
          </section>
          {r.projectSummary && (
            <section className="pt-4 text-sm">
              <p>Закрыто периодов: {r.projectSummary.periodCount}</p>
              <p className="mt-1 text-ink-2">
                Начисления по {registerDate(r.projectSummary.closedThrough)}
              </p>
              {r.projectSummary.unclosedBilling && (
                <p className="mt-2 text-amber">
                  Есть аренда или услуги за пределами закрытых периодов. Итог
                  проекта ещё может измениться.
                </p>
              )}
            </section>
          )}
          <section className="pt-4 text-xs text-ink-3">
            <p>Создано: {registerDate(r.createdAt, true)}</p>
            <p className="mt-1">Обновлено: {registerDate(r.updatedAt, true)}</p>
          </section>
        </div>
        <div className="mt-auto grid gap-2">
          <button className={button} onClick={onIssues}>Проблемы и ремонты →</button>
          <button
            className={`${button} !bg-accent !text-white`}
            onClick={primary}
          >
            {primaryLabel}
          </button>
          <Link href={`/bookings/${r.id}`} className={button}>
            Состав, документы и история →
          </Link>
          {r.mode === "STANDARD" &&
            ["CONFIRMED", "ISSUED"].includes(r.status) && (
              <Link
                className={button}
                href={`/warehouse/scan?booking=${encodeURIComponent(r.id)}`}
              >
                Открыть на складе
              </Link>
            )}
        </div>
      </div>
    </dialog>
  );
}
