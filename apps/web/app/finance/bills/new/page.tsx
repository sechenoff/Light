"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { useRequireRole } from "../../../../src/hooks/useRequireRole";
import { FinanceTabNav } from "../../../../src/components/finance/FinanceTabNav";
import { BillEditor } from "../../../../src/components/finance/BillEditor";

/** Новый счёт на оплату; `?bookingId=` — заготовка строк по брони. */
function NewBillPage() {
  const params = useSearchParams();
  const bookingId = params.get("bookingId");
  return (
    <div className="min-h-screen bg-surface-subtle">
      <FinanceTabNav />
      <BillEditor mode="create" bookingId={bookingId} />
    </div>
  );
}

export default function NewBillRoute() {
  const { authorized, loading } = useRequireRole(["SUPER_ADMIN"]);
  if (loading || !authorized) return null;
  return (
    <Suspense fallback={<div className="p-6 text-sm text-ink-3">Загрузка…</div>}>
      <NewBillPage />
    </Suspense>
  );
}
