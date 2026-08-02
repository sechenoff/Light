"use client";

import Link from "next/link";
import { StatusPill } from "./StatusPill";

export type DashboardBooking = {
  id: string;
  projectName: string;
  clientName: string;
  startDate: string;
  endDate: string;
  status: string;
  itemCount: number;
  items: Array<{ equipmentName: string; quantity: number }>;
};

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function pluralizePosition(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "позиция";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "позиции";
  return "позиций";
}

function formatItemsPreview(
  items: DashboardBooking["items"],
  itemCount: number
): string {
  const preview = items
    .slice(0, 3)
    .map((i) => `${i.equipmentName} ×${i.quantity}`)
    .join(", ");
  return `${itemCount} ${pluralizePosition(itemCount)}: ${preview}${items.length > 3 ? "..." : ""}`;
}

export function DashboardOpsCard({ booking }: { booking: DashboardBooking }) {
  return (
    <Link
      href={`/bookings/${booking.id}`}
      className="block bg-surface border border-border rounded-lg p-3 hover:border-border-strong hover:shadow-sm transition-all"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-sm text-ink truncate">
            {booking.projectName}
          </p>
          <p className="text-xs text-ink-2 truncate">{booking.clientName}</p>
        </div>
        <StatusPill
          variant={
            booking.status === "CONFIRMED" || booking.status === "RETURNED" ? "full"
            : booking.status === "ISSUED" || booking.status === "DRAFT" ? "limited"
            : booking.status === "CANCELLED" ? "none"
            : "view"
          }
          label={
            booking.status === "CONFIRMED" ? "Подтверждено"
            : booking.status === "ISSUED" ? "Выдано"
            : booking.status === "RETURNED" ? "Возвращено"
            : booking.status === "DRAFT" ? "Черновик"
            : booking.status === "CANCELLED" ? "Отменено"
            : booking.status
          }
        />
      </div>

      <p className="mt-1.5 text-xs text-ink-2">
        {formatTime(booking.startDate)} — {formatTime(booking.endDate)}
      </p>

      {booking.itemCount > 0 && (
        <p className="mt-1 text-xs text-ink-2 truncate">
          {formatItemsPreview(booking.items, booking.itemCount)}
        </p>
      )}
    </Link>
  );
}
