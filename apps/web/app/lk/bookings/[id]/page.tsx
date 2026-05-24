"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { lkApi } from "../../../../src/lib/lkApi";
import type { LkBookingDetail, LkBookingStatus } from "../../../../src/lib/lkTypes";
import { formatRub } from "../../../../src/lib/format";

const STATUS_LABEL: Record<LkBookingStatus, string> = {
  PENDING_APPROVAL: "На согласовании",
  CONFIRMED: "Подтверждена",
  ISSUED: "В работе",
  RETURNED: "Возвращена",
  CANCELLED: "Отменена",
};

const STATUS_CLASS: Record<LkBookingStatus, string> = {
  PENDING_APPROVAL: "text-amber",
  CONFIRMED: "text-teal",
  ISSUED: "text-accent-bright",
  RETURNED: "text-ink-2",
  CANCELLED: "text-ink-3",
};

export default function LkBookingDetailPage() {
  const params = useParams<{ id: string }>();
  const [b, setB] = useState<LkBookingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await lkApi.booking(params.id);
        if (!cancelled) setB(r);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Ошибка загрузки");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.id]);

  if (error) {
    return (
      <div className="space-y-4">
        <Link href="/lk/bookings" className="text-sm text-ink-2 hover:text-ink transition-colors">
          ← Все заказы
        </Link>
        <p className="text-rose">Не удалось загрузить заказ: {error}</p>
      </div>
    );
  }

  if (!b) {
    return (
      <div className="space-y-4">
        <div className="h-4 w-24 bg-surface-2 rounded animate-pulse" />
        <div className="h-8 w-64 bg-surface-2 rounded animate-pulse" />
        <div className="h-4 w-48 bg-surface-2 rounded animate-pulse" />
        <div className="mt-4 bg-surface-2 border border-border rounded-lg h-48 animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Link href="/lk/bookings" className="text-sm text-ink-2 hover:text-ink transition-colors">
        ← Все заказы
      </Link>

      <header className="space-y-1">
        <p className="eyebrow">Заказ {b.bookingNo}</p>
        <h1 className="text-2xl font-medium">{b.projectName || "Без названия"}</h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-2 mt-1">
          <span>
            {new Date(b.startDate).toLocaleDateString("ru-RU")}
            {" — "}
            {new Date(b.endDate).toLocaleDateString("ru-RU")}
          </span>
          <span>·</span>
          <span>{b.shifts} {b.shifts === 1 ? "смена" : b.shifts >= 2 && b.shifts <= 4 ? "смены" : "смен"}</span>
          <span>·</span>
          <span className={STATUS_CLASS[b.status]}>{STATUS_LABEL[b.status]}</span>
        </div>
      </header>

      <section aria-label="Позиции заказа" className="bg-surface-2 border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <p className="eyebrow">Позиции</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[480px]">
            <thead>
              <tr className="text-left text-ink-2">
                <th className="px-4 py-2 font-normal">Категория</th>
                <th className="px-4 py-2 font-normal">Название</th>
                <th className="px-4 py-2 font-normal text-right">Кол-во</th>
                <th className="px-4 py-2 font-normal text-right">Цена / смена</th>
                <th className="px-4 py-2 font-normal text-right">Сумма</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {b.items.map((it, i) => (
                <tr key={i} className="hover:bg-surface transition-colors">
                  <td className="px-4 py-2 text-ink-2">{it.categorySnapshot}</td>
                  <td className="px-4 py-2">{it.nameSnapshot}</td>
                  <td className="px-4 py-2 text-right mono-num">{it.quantity}</td>
                  <td className="px-4 py-2 text-right mono-num">{formatRub(Number(it.unitPrice))}</td>
                  <td className="px-4 py-2 text-right mono-num">{formatRub(Number(it.lineSum))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-label="Финансовая сводка" className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-surface-2 border border-border rounded-lg p-3">
          <p className="eyebrow">Итого</p>
          <p className="mono-num text-lg mt-1">{formatRub(Number(b.totalAfterDiscount))}</p>
        </div>
        <div className="bg-surface-2 border border-border rounded-lg p-3">
          <p className="eyebrow">Скидка</p>
          <p className="mono-num text-lg mt-1">{formatRub(Number(b.discountAmount))}</p>
        </div>
        <div className="bg-surface-2 border border-border rounded-lg p-3">
          <p className="eyebrow">Оплачено</p>
          <p className="mono-num text-lg mt-1">{formatRub(Number(b.amountPaid))}</p>
        </div>
        <div className="bg-surface-2 border border-border rounded-lg p-3">
          <p className="eyebrow">Остаток</p>
          <p className={`mono-num text-lg mt-1 ${Number(b.amountOutstanding) > 0 ? "text-rose" : ""}`}>
            {formatRub(Number(b.amountOutstanding))}
          </p>
        </div>
      </section>

      {(b.comment || b.optionalNote) && (
        <section aria-label="Комментарии" className="bg-surface-2 border border-border rounded-lg p-4 space-y-2">
          {b.comment && (
            <div>
              <p className="eyebrow mb-1">Комментарий</p>
              <p className="text-sm text-ink-2">{b.comment}</p>
            </div>
          )}
          {b.optionalNote && (
            <div>
              <p className="eyebrow mb-1">Примечание</p>
              <p className="text-sm text-ink-2">{b.optionalNote}</p>
            </div>
          )}
        </section>
      )}

      {(b.hasConfirmedEstimate || b.hasAct) && (
        <section aria-label="Документы" className="flex flex-wrap gap-2">
          {b.hasConfirmedEstimate && (
            <a
              href={`/api/lk/bookings/${b.id}/estimate.pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 border border-border rounded-md text-sm hover:bg-surface-2 transition-colors"
            >
              <span aria-hidden="true">📄</span>
              Смета PDF
            </a>
          )}
          {b.hasAct && (
            <a
              href={`/api/lk/bookings/${b.id}/act.pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 border border-border rounded-md text-sm hover:bg-surface-2 transition-colors"
            >
              <span aria-hidden="true">📋</span>
              Акт PDF
            </a>
          )}
        </section>
      )}
    </div>
  );
}
