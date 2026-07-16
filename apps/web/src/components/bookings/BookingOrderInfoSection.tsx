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
      <div className="p-3 border-b border-border bg-surface-subtle">
        <p className="eyebrow">Данные заказа</p>
      </div>
      <div className="p-3 text-sm text-ink space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-ink-3">Клиент:</span>{" "}
          <span className="font-medium">{booking.client.name}</span>
          {canChangeClient && (
            <button
              type="button"
              aria-label="Сменить клиента"
              onClick={onChangeClient}
              className="ml-1 rounded border border-border px-2 py-0.5 text-xs text-ink-3 hover:bg-surface-soft hover:text-ink transition-colors"
            >
              Сменить
            </button>
          )}
        </div>
        <div>
          <span className="text-ink-3">Проект:</span>{" "}
          {booking.projectName?.trim() === "Проект" ? (
            <span className="font-medium text-ink-3">Без названия</span>
          ) : (
            <span className="font-medium">{booking.projectName}</span>
          )}
        </div>
        <div>
          <span className="text-ink-3">Период:</span>{" "}
          <span className="font-medium">
            {new Date(booking.startDate).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })} —{" "}
            {new Date(booking.endDate).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}
          </span>
        </div>
        {booking.comment ? (
          <div>
            <span className="text-ink-3">Комментарий:</span> <span>{booking.comment}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
