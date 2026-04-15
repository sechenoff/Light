"use client";

import { useState } from "react";
import {
  useFloating,
  useHover,
  useInteractions,
  offset,
  flip,
  shift,
  FloatingPortal,
} from "@floating-ui/react";
import { format, parseISO } from "date-fns";
import { ru } from "date-fns/locale";
import Link from "next/link";

type BookingRef = {
  id: string;
  projectName: string;
  clientName: string;
  start: string;
  end: string;
  quantity: number;
  status: string;
};

type CalendarTooltipProps = {
  children: React.ReactNode;
  equipmentName: string;
  date: string; // YYYY-MM-DD
  occupiedCount: number;
  totalCount: number;
  bookings: BookingRef[];
};

function statusDotClass(status: string): string {
  if (status === "CONFIRMED") return "bg-accent-bright";
  if (status === "ISSUED") return "bg-amber";
  return "bg-slate-border";
}

function formatTimeRange(start: string, end: string): string {
  const startDate = parseISO(start);
  const endDate = parseISO(end);
  const startStr = format(startDate, "HH:mm");
  const endStr = format(endDate, "HH:mm");

  // Проверяем, заканчивается ли бронь на следующий день относительно начала
  const startDay = start.slice(0, 10);
  const endDay = end.slice(0, 10);
  const nextDay = startDay !== endDay ? " (+1д)" : "";

  return `${startStr} — ${endStr}${nextDay}`;
}

export function CalendarTooltip({
  children,
  equipmentName,
  date,
  occupiedCount,
  totalCount,
  bookings,
}: CalendarTooltipProps) {
  const [isOpen, setIsOpen] = useState(false);

  const { refs, floatingStyles, context } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    middleware: [offset(8), flip(), shift({ padding: 8 })],
    placement: "top",
  });

  const hover = useHover(context, { delay: { open: 200, close: 100 } });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover]);

  // Форматируем дату на русском: "Вторник, 8 апреля"
  const formattedDate = format(parseISO(date), "EEEE, d MMMM", { locale: ru });
  const capitalizedDate =
    formattedDate.charAt(0).toUpperCase() + formattedDate.slice(1);

  return (
    <>
      <span ref={refs.setReference} {...getReferenceProps()}>
        {children}
      </span>
      {isOpen && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            className="z-50 w-64 rounded-lg border border-border bg-surface shadow-sm text-sm"
          >
            {/* Заголовок */}
            <div className="px-3 pt-3 pb-2">
              <p className="font-semibold text-ink truncate">{equipmentName}</p>
              <p className="eyebrow mt-0.5">{capitalizedDate}</p>
              <p className="text-xs text-ink-2 mt-1">
                Занято:{" "}
                <span className="font-medium mono-num">
                  {occupiedCount} из {totalCount}
                </span>
              </p>
            </div>

            {/* Разделитель */}
            <div className="border-t border-border" />

            {/* Список бронирований */}
            <div className="px-3 py-2 space-y-2 max-h-48 overflow-y-auto">
              {bookings.length === 0 ? (
                <p className="text-xs text-ink-3">Нет бронирований</p>
              ) : (
                bookings.map((booking) => (
                  <div key={booking.id} className="space-y-0.5">
                    <div className="flex items-start gap-1.5">
                      <span
                        className={`mt-1 flex-shrink-0 w-2 h-2 rounded-full ${statusDotClass(booking.status)}`}
                      />
                      <div className="min-w-0">
                        <p className="text-ink truncate font-medium text-xs">
                          {booking.clientName}
                        </p>
                        <p className="text-ink-3 text-xs">
                          {formatTimeRange(booking.start, booking.end)} · {booking.quantity} шт.
                        </p>
                      </div>
                    </div>
                    <Link
                      href={`/bookings/${booking.id}`}
                      className="text-xs text-accent-bright hover:text-accent pl-3.5 block"
                    >
                      Открыть бронь →
                    </Link>
                  </div>
                ))
              )}
            </div>
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
