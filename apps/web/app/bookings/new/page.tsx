'use client';
import { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { BookingForm } from '../../../src/components/bookings/BookingForm';
import { ProjectBookingForm } from '../../../src/components/bookings/project/ProjectBookingForm';
function NewBooking() {
  const params = useSearchParams();
  const project = params.get('mode') === 'PROJECT';
  return <><nav aria-label="Тип брони" className={`flex flex-wrap gap-2 px-4 pt-4 lg:px-6 ${project ? 'mx-auto w-full max-w-3xl' : 'bg-surface'}`}><Link className={`rounded px-4 py-2 text-sm ${!project ? 'bg-accent-soft text-accent-bright' : 'text-ink-3'}`} href="/bookings/new">Обычная бронь</Link><Link className={`rounded px-4 py-2 text-sm ${project ? 'bg-accent-soft text-accent-bright' : 'text-ink-3'}`} href="/bookings/new?mode=PROJECT">Длинный проект</Link></nav>{project ? <ProjectBookingForm /> : <BookingForm mode="create" />}</>;
}
export default function BookingNewPageWrapper() { return <Suspense fallback={<p className="p-4">Загрузка…</p>}><NewBooking /></Suspense>; }
