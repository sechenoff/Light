"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";

import { InventoryPage } from "../../../../src/components/inventory/InventoryPage";

function InventoryByParam() {
  const params = useParams<{ id: string }>();
  const id = Array.isArray(params?.id) ? params.id[0] : params?.id;
  if (!id) return null;
  return <InventoryPage id={id} />;
}

// useSearchParams внутри страницы (вид и категория в URL) требует Suspense в Next 14.
export default function InventoryDetailRoute() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[200px] items-center justify-center p-6">
          <span className="text-sm text-ink-3">Загрузка…</span>
        </div>
      }
    >
      <InventoryByParam />
    </Suspense>
  );
}
