"use client";

import { Suspense } from "react";
import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { PaymentsOverviewPage } from "../../../src/components/finance/PaymentsOverviewPage";

function PageGuard() {
  const { authorized, loading } = useRequireRole(["SUPER_ADMIN"]);

  if (loading || !authorized) return null;

  return (
    <Suspense
      fallback={
        <div className="p-6 flex items-center justify-center min-h-[200px]">
          <span className="text-sm text-ink-3">Загрузка…</span>
        </div>
      }
    >
      <PaymentsOverviewPage />
    </Suspense>
  );
}

export default function PaymentsOverviewRoute() {
  return <PageGuard />;
}
