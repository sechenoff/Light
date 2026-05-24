"use client";

import { Suspense } from "react";
import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { EquipmentStatsPage } from "../../../src/components/equipment-stats/EquipmentStatsPage";

export default function Page() {
  const { authorized, loading } = useRequireRole(["SUPER_ADMIN"]);
  if (loading || !authorized) return null;
  return (
    <Suspense fallback={<div className="py-12 text-center text-ink-3">Загружаем…</div>}>
      <EquipmentStatsPage />
    </Suspense>
  );
}
