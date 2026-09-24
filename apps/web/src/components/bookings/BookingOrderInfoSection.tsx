"use client";

// Карточка «Данные заказа» (фаза 4.10, вынос из bookings/[id]/page.tsx,
// поведение 1:1): клиент (+кнопка смены для SA вне согласования/архива),
// проект, период, комментарий.

export type OrderInfoBooking = {
  projectName: string;
  startDate: string;
  endDate: string;
  comment?: string | null;
  client: { name: string };
};

export function BookingOrderInfoSection({
  booking,
  canChangeClient,
  onChangeClient,
}: {
  booking: OrderInfoBooking;
  canChangeClient: boolean;
  onChangeClient: () => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-surface-subtle">
        <p className="eyebrow">Данные заказа</p>
      </div>
      {/* Подписи и значения — двумя колонками: значения начинаются с одной
          вертикали, перенос длинного значения не уходит под подпись. */}
      <dl className="px-4 py-3 text-sm text-ink grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2 gap-y-2">
        <dt className="text-ink-3">Клиент:</dt>
        <dd className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 font-medium">
          <span className="min-w-0 break-words">{booking.client.name}</span>
          {canChangeClient && (
            <button
              type="button"
              aria-label="Сменить клиента"
              onClick={onChangeClient}
              className="inline-flex items-center min-h-8 rounded border border-border px-2.5 text-xs font-normal text-ink-3 hover:bg-surface-subtle hover:text-ink transition-colors"
            >
              Сменить
            </button>
          )}
        </dd>
        <dt className="text-ink-3">Проект:</dt>
        {booking.projectName?.trim() === "Проект" ? (
          <dd className="min-w-0 break-words font-medium text-ink-3">Без названия</dd>
        ) : (
          <dd className="min-w-0 break-words font-medium">{booking.projectName}</dd>
        )}
        <dt className="text-ink-3">Период:</dt>
        <dd className="min-w-0 break-words font-medium">
          {new Date(booking.startDate).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })} —{" "}
          {new Date(booking.endDate).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}
        </dd>
        {booking.comment ? (
          <>
            <dt className="text-ink-3">Комментарий:</dt>
            <dd className="min-w-0 break-words">{booking.comment}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}
