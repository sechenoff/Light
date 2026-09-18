"use client";
import { Suspense } from "react";
import { BookingRegister } from "../../src/components/bookings/register/BookingRegister";
export default function BookingsPage() {
  return (
    <Suspense
      fallback={<div className="p-8 text-ink-3">Загрузка бронирований…</div>}
    >
      <BookingRegister />
    </Suspense>
  );
}
