"use client";

import Link from "next/link";
import { StatusBadge } from "./StatusBadge";

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
      className="block bg-white border border-slate-200 rounded-lg p-3 hover:border-slate-300 hover:shadow-sm transition-all"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-sm text-slate-900 truncate">
            {booking.projectName}
          </p>
          <p className="text-xs text-slate-500 truncate">{booking.clientName}</p>
        </div>
        <StatusBadge status={booking.status} />
      </div>

      <p className="mt-1.5 text-xs text-slate-600">
        {formatTime(booking.startDate)} — {formatTime(booking.endDate)}
      </p>

      {booking.itemCount > 0 && (
        <p className="mt-1 text-xs text-slate-500 truncate">
          {formatItemsPreview(booking.items, booking.itemCount)}
        </p>
      )}
    </Link>
  );
}
