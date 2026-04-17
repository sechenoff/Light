"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

import { apiFetch } from "../../../../src/lib/api";
import { BookingForm, type BookingDetail } from "../../../../src/components/bookings/BookingForm";
import { useCurrentUser } from "../../../../src/hooks/useCurrentUser";

export default function BookingEditPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useCurrentUser();

  const [loading, setLoading] = useState(true);
  const [booking, setBooking] = useState<BookingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ booking: BookingDetail }>(`/api/bookings/${id}`)
      .then((data) => { if (!cancelled) setBooking(data.booking); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Не удалось загрузить"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  if (loading) {
    return <div className="p-8 text-ink-3 text-center">Загрузка…</div>;
  }
  if (error || !booking) {
    return (
      <div className="p-8 text-center text-ink-2">
        Бронь не найдена.{" "}
        <Link href="/bookings" className="underline">
          К списку
        </Link>
      </div>
    );
  }

  // Permission check: SUPER_ADMIN can edit PENDING_APPROVAL, others only DRAFT/CONFIRMED
  const isSuperAdmin = user?.role === "SUPER_ADMIN";
  const editableStatuses = isSuperAdmin
    ? ["DRAFT", "CONFIRMED", "PENDING_APPROVAL"]
    : ["DRAFT", "CONFIRMED"];
  if (!editableStatuses.includes(booking.status)) {
    return (
      <div className="p-8 text-center text-ink-2">
        Редактирование недоступно для статуса «{booking.status}».{" "}
        <Link href={`/bookings/${id}`} className="underline">
          Открыть бронь
        </Link>
      </div>
    );
  }

  return <BookingForm mode="edit" initialBooking={booking} bookingId={id} />;
}
