"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { lkApi } from "../../../../src/lib/lkApi";
import { LK_STATUS_LABEL, type LkBookingDetail, type LkBookingStatus } from "../../../../src/lib/lkTypes";
import { formatRub, pluralize } from "../../../../src/lib/format";

// Общий словарь подписей статусов (дубль удалён, lk-dashboard-raw-status).
const STATUS_LABEL = LK_STATUS_LABEL;

// Локальное расширение LkBookingDetail: транспорт и счёт добавлены в ответ
// GET /api/lk/bookings/:id (routes/lk/bookings.ts) и нужны только на этой странице.
type LkBookingDetailExt = LkBookingDetail & {
  mode?: string;
  forecastTotal?: string;
  restDays?: number;
  restPercent?: number;
  periods?: Array<{ id: string; kind: string; number: string | null; fromDate: string; throughDate: string; amount: string }>;
  transportSubtotal: string;
  hasInvoice: boolean;
  invoiceNumber: string | null;
};

const STATUS_CLASS: Record<LkBookingStatus, string> = {
  CONFIRMED: "text-teal",
  ISSUED: "text-accent-bright",
  RETURNED: "text-ink-2",
  CANCELLED: "text-ink-3",
};

const SEGMENT =
  "relative ml-7 whitespace-nowrap before:absolute before:-left-4 before:content-['·'] before:text-ink-3";

export default function LkBookingDetailPage() {
  const params = useParams<{ id: string }>();
  const [b, setB] = useState<LkBookingDetailExt | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = (await lkApi.booking(params.id)) as LkBookingDetailExt;
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
        <Link href="/lk/bookings" className="inline-flex items-center min-h-10 sm:min-h-0 text-sm text-ink-2 hover:text-ink transition-colors">
          ← Все заказы
        </Link>
        <p className="text-rose">Не удалось загрузить заказ: {error}</p>
      </div>
    );
  }

  if (!b) {
    return (
      <div className="space-y-4">
        <div className="h-4 w-24 bg-surface-muted rounded animate-pulse" />
        <div className="h-8 w-64 bg-surface-muted rounded animate-pulse" />
        <div className="h-4 w-48 bg-surface-muted rounded animate-pulse" />
        <div className="mt-4 bg-surface-muted border border-border rounded-lg h-48 animate-pulse" />
      </div>
    );
  }

  // Транспорт — необязательная пятая карточка сводки: сетка под неё перестраивается,
  // чтобы «Остаток» не повисал один во втором ряду.
  const hasTransport = Number(b.transportSubtotal) > 0;

  return (
    <div className="space-y-6">
      <Link href="/lk/bookings" className="inline-flex items-center min-h-10 sm:min-h-0 text-sm text-ink-2 hover:text-ink transition-colors">
        ← Все заказы
      </Link>

      <header className="space-y-1">
        <p className="eyebrow">Заказ {b.bookingNo}</p>
        <h1 className="text-2xl font-medium">{b.projectName || "Без названия"}</h1>
        {/* Разделитель «·» — псевдоэлемент в левом отступе сегмента: переносится
            вместе с ним, а у сегмента в начале строки попадает в отрицательный
            отступ ряда и срезается overflow-hidden — ни висячей точки в конце
            строки, ни точки в начале новой. */}
        <div className="overflow-hidden text-sm text-ink-2 mt-1">
          <div className="-ml-7 flex flex-wrap items-center gap-y-1">
            <span className={SEGMENT}>
              {new Date(b.startDate).toLocaleDateString("ru-RU")}
              {" — "}
              {new Date(b.endDate).toLocaleDateString("ru-RU")}
            </span>
            <span className={SEGMENT}>{b.shifts} {pluralize(b.shifts, "смена", "смены", "смен")}</span>
            <span className={`${SEGMENT} ${STATUS_CLASS[b.status]}`}>{STATUS_LABEL[b.status]}</span>
          </div>
        </div>
        {b.mode === "PROJECT" && <p className="text-sm text-ink-2">Выходных: {b.restDays} по {b.restPercent}%. Расчёты фиксируются по периодам.</p>}
      </header>

      <section aria-label="Позиции заказа" className="bg-surface-muted border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <p className="eyebrow">{b.mode === "PROJECT" ? "Прогноз состава и стоимости проекта" : "Позиции"}</p>
        </div>
        {/* До sm — список: пять колонок в 340 px не помещаются. Сумма строки =
            цена × количество, поэтому подпись «N × цена» сходится с суммой.
            В режиме проекта цена — ставка за смену, а сумма — за весь период
            строки, поэтому к подписи дописано «/ смена».
            До xl категория (в режиме проекта — период) идёт подписью под названием:
            отдельной колонкой длинные категории рвались на 2–3 строки. */}
        <ul className="sm:hidden divide-y divide-border">
          {b.items.map((it, i) => (
            <li key={i} className="px-4 py-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm">{it.nameSnapshot}</p>
                <p className="text-xs text-ink-3 mt-0.5">{it.categorySnapshot}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className="mono-num text-sm whitespace-nowrap">{formatRub(Number(it.lineSum))}</p>
                <p className="mono-num text-xs text-ink-2 whitespace-nowrap">
                  {it.quantity} × {formatRub(Number(it.unitPrice))}{b.mode === "PROJECT" ? " / смена" : ""}
                </p>
              </div>
            </li>
          ))}
        </ul>
        <div className="hidden sm:block overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-subtle border-b border-border text-left text-ink-2">
              <tr>
                <th className="px-4 py-2 font-medium whitespace-nowrap hidden xl:table-cell">
                  {b.mode === "PROJECT" ? "Период" : "Категория"}
                </th>
                <th className="px-4 py-2 font-medium whitespace-nowrap">Название</th>
                <th className="px-4 py-2 font-medium whitespace-nowrap text-right">Кол-во</th>
                <th className="px-4 py-2 font-medium whitespace-nowrap text-right">Цена / смена</th>
                <th className="px-4 py-2 font-medium whitespace-nowrap text-right">Сумма</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {b.items.map((it, i) => (
                <tr key={i} className="hover:bg-surface transition-colors">
                  <td className="px-4 py-2 text-ink-2 hidden xl:table-cell">{it.categorySnapshot}</td>
                  <td className="px-4 py-2">
                    {it.nameSnapshot}
                    <span className="block text-xs text-ink-3 xl:hidden">{it.categorySnapshot}</span>
                  </td>
                  <td className="px-4 py-2 text-right mono-num whitespace-nowrap">{it.quantity}</td>
                  <td className="px-4 py-2 text-right mono-num whitespace-nowrap">{formatRub(Number(it.unitPrice))}</td>
                  <td className="px-4 py-2 text-right mono-num whitespace-nowrap">{formatRub(Number(it.lineSum))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* «Итого» = finalAmount (оборудование после скидки + транспорт) — та же
          база, от которой считаются «Оплачено» и «Остаток», иначе числа не бьются. */}
      <section
        aria-label="Финансовая сводка"
        className={`grid grid-cols-2 gap-3 ${hasTransport ? "sm:grid-cols-3 lg:grid-cols-5" : "sm:grid-cols-4"}`}
      >
        {/* flex-col + mt-auto: при переносе надстрочника суммы в ряду остаются на одной линии */}
        <div className="bg-surface-muted border border-border rounded-lg p-3 flex flex-col">
          <p className="eyebrow">{b.mode === "PROJECT" ? "Прогноз проекта" : "Скидка"}</p>
          <p className="mono-num text-lg mt-auto pt-1">{formatRub(Number(b.mode === "PROJECT" ? b.forecastTotal : b.discountAmount))}</p>
        </div>
        {hasTransport && (
          <div className="bg-surface-muted border border-border rounded-lg p-3 flex flex-col">
            <p className="eyebrow">Транспорт и доставка</p>
            <p className="mono-num text-lg mt-auto pt-1">{formatRub(Number(b.transportSubtotal))}</p>
          </div>
        )}
        <div className="bg-surface-muted border border-border rounded-lg p-3 flex flex-col">
          <p className="eyebrow">{b.mode === "PROJECT" ? "Начислено по периодам" : "Итого"}</p>
          <p className="mono-num text-lg mt-auto pt-1">{formatRub(Number(b.finalAmount))}</p>
        </div>
        <div className="bg-surface-muted border border-border rounded-lg p-3 flex flex-col">
          <p className="eyebrow">Оплачено</p>
          <p className="mono-num text-lg mt-auto pt-1">{formatRub(Number(b.amountPaid))}</p>
        </div>
        <div
          className={`bg-surface-muted border border-border rounded-lg p-3 flex flex-col ${
            hasTransport ? "col-span-2 lg:col-span-1" : ""
          }`}
        >
          <p className="eyebrow">Остаток</p>
          <p className={`mono-num text-lg mt-auto pt-1 ${Number(b.amountOutstanding) > 0 ? "text-rose" : ""}`}>
            {formatRub(Number(b.amountOutstanding))}
          </p>
        </div>
      </section>

      {b.periods && b.periods.length > 0 && <section aria-label="Расчёты по периодам" className="space-y-3"><h2 className="font-medium">Расчёты по периодам</h2>{b.periods.map(p => <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-border p-3 text-sm" key={p.id}><div><p>{p.kind === "CORRECTION" ? "Корректировка" : p.number} · {p.fromDate} — {p.throughDate}</p><p>{formatRub(Number(p.amount))}</p></div><div className="flex gap-3">{["pdf", "xlsx"].map(f => <a className="underline" key={f} href={`/api/lk/bookings/${b.id}/project-documents/${p.id}/${f}`} target="_blank" rel="noreferrer">{f.toUpperCase()}</a>)}</div></div>)}</section>}

      {(b.comment || b.optionalNote) && (
        <section aria-label="Комментарии" className="bg-surface-muted border border-border rounded-lg p-4 space-y-2">
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

      {(b.hasConfirmedEstimate || b.hasAct || b.hasInvoice) && (
        <section aria-label="Документы" className="flex flex-wrap gap-2">
          {b.hasInvoice && (
            <a
              href={`/api/lk/bookings/${b.id}/invoice.pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 border border-border rounded-md text-sm hover:bg-surface-muted transition-colors"
            >
              <span aria-hidden="true">🧾</span>
              Счёт {b.invoiceNumber ? `${b.invoiceNumber} ` : ""}PDF
            </a>
          )}
          {b.hasConfirmedEstimate && (
            <a
              href={`/api/lk/bookings/${b.id}/estimate.pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 border border-border rounded-md text-sm hover:bg-surface-muted transition-colors"
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
              className="inline-flex items-center gap-2 px-4 py-2 border border-border rounded-md text-sm hover:bg-surface-muted transition-colors"
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
