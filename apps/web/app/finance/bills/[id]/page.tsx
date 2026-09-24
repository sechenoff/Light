"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";

import { useRequireRole } from "../../../../src/hooks/useRequireRole";
import { FinanceTabNav } from "../../../../src/components/finance/FinanceTabNav";
import { BillEditor } from "../../../../src/components/finance/BillEditor";

/** Карточка выставленного счёта: печать, статус, правка. */
function BillPage() {
  const params = useParams<{ id: string }>();
  return (
    <div>
      <FinanceTabNav />
      <BillEditor mode="edit" billId={params.id} />
    </div>
  );
}

export default function BillRoute() {
  const { authorized, loading } = useRequireRole(["SUPER_ADMIN"]);
  if (loading || !authorized) return null;
  return (
    <Suspense fallback={<div className="p-6 text-sm text-ink-3">Загрузка…</div>}>
      <BillPage />
    </Suspense>
  );
}
