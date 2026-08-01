"use client";

import { Suspense } from "react";

import { useRequireRole } from "../../src/hooks/useRequireRole";
import { VehiclesDashboard } from "../../src/components/vehicles/VehiclesDashboard";

export default function VehiclesPage() {
  const { authorized, loading } = useRequireRole([
    "SUPER_ADMIN",
    "WAREHOUSE",
    "TECHNICIAN",
  ]);
  if (loading || !authorized) return null;

  return (
    <Suspense fallback={<div className="p-8 text-ink-3">Загружаем автопарк…</div>}>
      <VehiclesDashboard />
    </Suspense>
  );
}
