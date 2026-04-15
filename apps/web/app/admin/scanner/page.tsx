"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { Html5QrcodeSupportedFormats } from "html5-qrcode";
import type { BarcodeScannerProps } from "@/components/BarcodeScanner";
import { StatusPill, type StatusPillVariant } from "../../../src/components/StatusPill";
import { apiFetch } from "../../../src/lib/api";

const BarcodeScanner = dynamic<BarcodeScannerProps>(
  () => import("@/components/BarcodeScanner"),
  { ssr: false },
);

// ── Types ─────────────────────────────────────────────────────────────────────

type ScanMode = "lookup" | "assign" | "batch";

type EquipmentItem = {
  id: string;
  name: string;
  category: string;
  brand: string | null;
  model: string | null;
  stockTrackingMode: string;
};

type LookupResult = {
  unit: {
    id: string;
    barcode: string | null;
    status: string;
    serialNumber: string | null;
  };
  equipment: {
    id: string;
    name: string;
    category: string;
    brand: string | null;
    model: string | null;
  };
  hmacVerified: boolean;
};

type UnitResult = {
  id: string;
  barcode: string | null;
  barcodePayload: string | null;
  status: string;
  serialNumber: string | null;
};

type BatchItem = { unit: UnitResult; barcode: string };

// ── Constants ─────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  AVAILABLE: "Доступен",
  ISSUED: "Выдан",
  MAINTENANCE: "Обслуживание",
  RETIRED: "Списан",
  MISSING: "Утерян",
};

const STATUS_VARIANTS: Record<string, StatusPillVariant> = {
  AVAILABLE: "ok",
  ISSUED: "info",
  MAINTENANCE: "warn",
  RETIRED: "none",
  MISSING: "alert",
};

// ── Equipment Search List ─────────────────────────────────────────────────────

function EquipmentList({
  onSelect,
}: {
  onSelect: (item: EquipmentItem) => void;
}) {
  const [items, setItems] = useState<EquipmentItem[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ equipments: EquipmentItem[] }>("/api/equipment?limit=500")
      .then((data) => {
        // Only UNIT-mode equipment can have barcodes assigned
        setItems(
          data.equipments.filter((e) => e.stockTrackingMode === "UNIT"),
        );
      })
      .catch((err: unknown) => {
        const e = err as { message?: string };
        setError(e?.message ?? "Ошибка загрузки оборудования");
      })
      .finally(() => setLoading(false));
  }, []);

  const filtered = query
    ? items.filter(
        (item) =>
          item.name.toLowerCase().includes(query.toLowerCase()) ||
          item.category.toLowerCase().includes(query.toLowerCase()),
      )
    : items;

  if (loading) {
    return (
      <div className="space-y-2 p-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-14 bg-surface-muted rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-sm text-rose bg-rose-soft border border-rose-border rounded-xl mx-4">
        {error}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 px-4 pb-4">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Поиск оборудования..."
        className="w-full px-3 py-2.5 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-accent-bright"
      />
      {filtered.length === 0 ? (
        <p className="text-sm text-ink-3 text-center py-6">
          {query ? "Ничего не найдено" : "Нет оборудования в режиме UNIT"}
        </p>
      ) : (
        <div className="space-y-1.5 max-h-64 overflow-y-auto">
          {filtered.map((item) => (
            <button
              key={item.id}
              onClick={() => onSelect(item)}
              className="w-full text-left px-4 py-3 bg-surface border border-border rounded-xl hover:border-border-strong hover:shadow-sm transition-all"
            >
              <div className="text-sm font-medium text-ink truncate">
                {item.name}
              </div>
              <div className="text-xs text-ink-3 mt-0.5">{item.category}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Lookup Result Card ────────────────────────────────────────────────────────

function LookupCard({ result }: { result: LookupResult }) {
  const statusLabel = STATUS_LABELS[result.unit.status] ?? result.unit.status;
  const statusVariant: StatusPillVariant =
    STATUS_VARIANTS[result.unit.status] ?? "none";

  return (
    <div className="mx-4 mt-3 bg-surface border border-border rounded-2xl p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-ink text-base truncate">
            {result.equipment.name}
          </div>
          <div className="text-xs text-ink-3 mt-0.5">{result.equipment.category}</div>
        </div>
        <StatusPill
          variant={statusVariant}
          label={statusLabel}
          className="shrink-0"
        />
      </div>

      <div className="space-y-1.5 text-sm">
        {result.unit.barcode && (
          <div className="flex justify-between">
            <span className="text-ink-2">Штрихкод</span>
            <span className="font-mono text-ink">{result.unit.barcode}</span>
          </div>
        )}
        {result.unit.serialNumber && (
          <div className="flex justify-between">
            <span className="text-ink-2">Серийный №</span>
            <span className="font-mono text-ink">{result.unit.serialNumber}</span>
          </div>
        )}
        <div className="flex justify-between">
          <span className="text-ink-2">HMAC</span>
          <span
            className={result.hmacVerified ? "text-emerald font-medium" : "text-rose"}
          >
            {result.hmacVerified ? "Подтверждён" : "Не подтверждён"}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Main Scanner Component ────────────────────────────────────────────────────

function ScannerApp() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [mode, setMode] = useState<ScanMode>("lookup");
  const [online, setOnline] = useState(true);

  // Flash state for camera border
  const [flashColor, setFlashColor] = useState<"green" | "red" | "amber" | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Lookup mode state
  const [lookupResult, setLookupResult] = useState<LookupResult | null>(null);
  const [lookupNotFound, setLookupNotFound] = useState(false);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupManual, setLookupManual] = useState("");

  // ── Assign mode state
  const [assignEquipment, setAssignEquipment] = useState<EquipmentItem | null>(null);
  const [assignManual, setAssignManual] = useState("");
  const [assignResult, setAssignResult] = useState<UnitResult | null>(null);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [assignLoading, setAssignLoading] = useState(false);

  // ── Batch mode state
  const [batchEquipment, setBatchEquipment] = useState<EquipmentItem | null>(null);
  const [batchManual, setBatchManual] = useState("");
  const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
  const [batchLoading, setBatchLoading] = useState(false);

  // Deduplicate scan calls
  const lastScanRef = useRef<{ value: string; ts: number }>({ value: "", ts: 0 });
  const scanningRef = useRef(false);

  // Online status
  useEffect(() => {
    setOnline(navigator.onLine);
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  // Cleanup flash timer on unmount
  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  // Pre-select equipment from URL ?equipmentId= (assign mode)
  useEffect(() => {
    const equipmentId = searchParams.get("equipmentId");
    if (equipmentId) {
      setMode("assign");
      apiFetch<{ equipment: EquipmentItem }>(`/api/equipment/${equipmentId}`)
        .then((data) => setAssignEquipment(data.equipment))
        .catch(() => {});
    }
  }, [searchParams]);

  function flash(color: "green" | "red" | "amber") {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    setFlashColor(color);
    flashTimerRef.current = setTimeout(() => setFlashColor(null), 600);
  }

  function vibrate(pattern: number | number[]) {
    try {
      navigator.vibrate?.(pattern);
    } catch {}
  }

  // ── Lookup handler ────────────────────────────────────────────────────────

  const handleLookup = useCallback(
    async (barcode: string) => {
      const now = Date.now();
      if (barcode === lastScanRef.current.value && now - lastScanRef.current.ts < 2000) return;
      lastScanRef.current = { value: barcode, ts: now };

      setLookupLoading(true);
      setLookupResult(null);
      setLookupNotFound(false);
      try {
        const result = await apiFetch<LookupResult>(
          `/api/equipment-units/lookup?barcode=${encodeURIComponent(barcode)}`,
        );
        setLookupResult(result);
        flash("green");
        vibrate(100);
      } catch (err: unknown) {
        const e = err as { status?: number };
        if (e?.status === 404) {
          setLookupNotFound(true);
          flash("red");
          vibrate([50, 50, 50]);
        } else {
          flash("red");
          vibrate([50, 50, 50]);
        }
      } finally {
        setLookupLoading(false);
      }
    },
    [],
  );

  function handleLookupManualSubmit(e: React.FormEvent) {
    e.preventDefault();
    const val = lookupManual.trim();
    if (!val) return;
    setLookupManual("");
    handleLookup(val);
  }

  // ── Assign handler ────────────────────────────────────────────────────────

  const handleAssign = useCallback(
    async (barcode: string) => {
      if (!assignEquipment) return;
      if (scanningRef.current) return;
      const now = Date.now();
      if (barcode === lastScanRef.current.value && now - lastScanRef.current.ts < 2000) return;
      lastScanRef.current = { value: barcode, ts: now };
      scanningRef.current = true;

      setAssignLoading(true);
      setAssignResult(null);
      setAssignError(null);
      try {
        // Check if there's an existing unit without barcode
        const unitsData = await apiFetch<{ units: UnitResult[] }>(
          `/api/equipment/${assignEquipment.id}/units`,
        );
        const freeUnit = unitsData.units.find((u) => u.barcode === null);

        let result: UnitResult;
        if (freeUnit) {
          // Assign barcode to the existing free unit
          const data = await apiFetch<{ unit: UnitResult }>(
            `/api/equipment/${assignEquipment.id}/units/${freeUnit.id}/assign-barcode`,
            {
              method: "POST",
              body: JSON.stringify({ barcode }),
            },
          );
          result = data.unit;
        } else {
          // Create new unit with barcode
          const data = await apiFetch<{ unit: UnitResult }>(
            `/api/equipment/${assignEquipment.id}/units/batch-assign`,
            {
              method: "POST",
              body: JSON.stringify({ barcode }),
            },
          );
          result = data.unit;
        }

        setAssignResult(result);
        flash("green");
        vibrate(100);
      } catch (err: unknown) {
        const e = err as { status?: number; message?: string };
        setAssignError(e?.message ?? "Ошибка привязки");
        flash("red");
        vibrate([50, 50, 50]);
      } finally {
        setAssignLoading(false);
        scanningRef.current = false;
      }
    },
    [assignEquipment],
  );

  function handleAssignManualSubmit(e: React.FormEvent) {
    e.preventDefault();
    const val = assignManual.trim();
    if (!val) return;
    setAssignManual("");
    handleAssign(val);
  }

  // ── Batch assign handler ──────────────────────────────────────────────────

  const handleBatch = useCallback(
    async (barcode: string) => {
      if (!batchEquipment) return;
      if (scanningRef.current) return;
      const now = Date.now();
      if (barcode === lastScanRef.current.value && now - lastScanRef.current.ts < 2000) return;
      lastScanRef.current = { value: barcode, ts: now };
      scanningRef.current = true;

      // Check for duplicate within this session
      const isDuplicate = batchItems.some((item) => item.barcode === barcode);
      if (isDuplicate) {
        flash("amber");
        vibrate([50, 50, 50]);
        scanningRef.current = false;
        return;
      }

      setBatchLoading(true);
      try {
        const data = await apiFetch<{ unit: UnitResult }>(
          `/api/equipment/${batchEquipment.id}/units/batch-assign`,
          {
            method: "POST",
            body: JSON.stringify({ barcode }),
          },
        );
        setBatchItems((prev) => [{ unit: data.unit, barcode }, ...prev]);
        flash("green");
        vibrate(100);
      } catch (err: unknown) {
        const e = err as { status?: number; message?: string };
        if (e?.status === 409) {
          // Already assigned elsewhere — amber flash
          flash("amber");
          vibrate([50, 50, 50]);
        } else {
          flash("red");
          vibrate([50, 50, 50]);
        }
      } finally {
        setBatchLoading(false);
        scanningRef.current = false;
      }
    },
    [batchEquipment, batchItems],
  );

  async function handleBatchDelete(item: BatchItem) {
    if (!batchEquipment) return;
    try {
      await apiFetch(
        `/api/equipment/${batchEquipment.id}/units/${item.unit.id}`,
        { method: "DELETE" },
      );
      setBatchItems((prev) => prev.filter((i) => i.unit.id !== item.unit.id));
    } catch (err: any) {
      if (err?.status === 404) {
        // Already deleted server-side, remove from list
        setBatchItems((prev) => prev.filter((i) => i.unit.id !== item.unit.id));
      } else {
        flash("red");
        vibrate([50, 50, 50]);
      }
    }
  }

  function handleBatchManualSubmit(e: React.FormEvent) {
    e.preventDefault();
    const val = batchManual.trim();
    if (!val) return;
    setBatchManual("");
    handleBatch(val);
  }

  // ── Active scan handler by mode ───────────────────────────────────────────

  const activeScanHandler =
    mode === "lookup"
      ? handleLookup
      : mode === "assign" && assignEquipment
        ? handleAssign
        : mode === "batch" && batchEquipment
          ? handleBatch
          : undefined;

  // Reset deduplicate ref on mode change
  function switchMode(m: ScanMode) {
    setMode(m);
    lastScanRef.current = { value: "", ts: 0 };
    setAssignResult(null);
    setAssignError(null);
  }

  return (
    <div className="flex flex-col h-screen bg-accent overflow-hidden">
      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-3 bg-accent z-10 shrink-0">
        <h1 className="text-white text-lg font-semibold">Сканер</h1>
        <div className="flex items-center gap-3">
          {/* Online status dot */}
          <span
            className={`w-2.5 h-2.5 rounded-full ${online ? "bg-emerald" : "bg-rose"}`}
            title={online ? "Онлайн" : "Офлайн"}
          />
          {/* Close → /admin */}
          <button
            onClick={() => router.push("/admin")}
            className="text-ink-3 hover:text-white text-2xl leading-none pb-0.5"
            aria-label="Закрыть"
          >
            ×
          </button>
        </div>
      </div>

      {/* ── Camera region ─────────────────────────────────────────────────── */}
      <div className="h-[60vh] shrink-0 relative bg-black">
        {activeScanHandler ? (
          <BarcodeScanner
            onScan={activeScanHandler}
            formats={[Html5QrcodeSupportedFormats.CODE_128]}
            flashColor={flashColor}
            enableTorch
          />
        ) : (
          <div className="flex items-center justify-center h-full">
            <p className="text-ink-3 text-sm text-center px-8">
              {mode === "assign"
                ? "Выберите оборудование ниже"
                : mode === "batch"
                  ? "Выберите оборудование ниже"
                  : ""}
            </p>
          </div>
        )}
      </div>

      {/* ── Bottom sheet ──────────────────────────────────────────────────── */}
      <div className="flex-1 bg-surface rounded-t-3xl overflow-y-auto">
        {/* Mode pills */}
        <div className="flex gap-2 px-4 pt-4 pb-3 shrink-0">
          {(
            [
              { id: "lookup", label: "Поиск" },
              { id: "assign", label: "Привязка" },
              { id: "batch", label: "Быстрая привязка" },
            ] as { id: ScanMode; label: string }[]
          ).map(({ id, label }) => (
            <button
              key={id}
              onClick={() => switchMode(id)}
              className={`flex-1 py-2 text-sm font-medium rounded-xl transition-colors ${
                mode === id
                  ? "bg-accent-bright text-white"
                  : "bg-surface text-ink-2 border border-border hover:bg-surface-muted"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* ── Lookup mode ──────────────────────────────────────────────────── */}
        {mode === "lookup" && (
          <div>
            {/* Manual input */}
            <form
              onSubmit={handleLookupManualSubmit}
              className="flex gap-2 px-4 pb-3"
            >
              <input
                type="text"
                value={lookupManual}
                onChange={(e) => setLookupManual(e.target.value)}
                placeholder="Штрихкод вручную"
                className="flex-1 h-11 px-3 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-accent-bright"
              />
              <button
                type="submit"
                className="h-11 px-4 bg-accent-bright text-white text-sm font-medium rounded-xl"
              >
                Ввести
              </button>
            </form>

            {lookupLoading && (
              <div className="mx-4 h-24 bg-surface-muted rounded-2xl animate-pulse" />
            )}

            {lookupNotFound && !lookupLoading && (
              <div className="mx-4 mt-2 px-4 py-4 bg-rose-soft border border-rose-border rounded-2xl text-center text-sm text-rose">
                Штрихкод не найден
              </div>
            )}

            {lookupResult && !lookupLoading && (
              <LookupCard result={lookupResult} />
            )}
          </div>
        )}

        {/* ── Assign mode ──────────────────────────────────────────────────── */}
        {mode === "assign" && (
          <div>
            {!assignEquipment ? (
              <EquipmentList onSelect={(item) => setAssignEquipment(item)} />
            ) : (
              <div className="px-4 pb-4">
                {/* Selected equipment header */}
                <div className="flex items-center justify-between mb-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-ink truncate">
                      {assignEquipment.name}
                    </div>
                    <div className="text-xs text-ink-3">{assignEquipment.category}</div>
                  </div>
                  <button
                    onClick={() => {
                      setAssignEquipment(null);
                      setAssignResult(null);
                      setAssignError(null);
                    }}
                    className="text-xs text-ink-3 hover:text-ink ml-2 underline"
                  >
                    Сменить
                  </button>
                </div>

                {/* Manual input */}
                <form onSubmit={handleAssignManualSubmit} className="flex gap-2 mb-3">
                  <input
                    type="text"
                    value={assignManual}
                    onChange={(e) => setAssignManual(e.target.value)}
                    placeholder="Штрихкод вручную"
                    className="flex-1 h-11 px-3 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-accent-bright"
                  />
                  <button
                    type="submit"
                    disabled={assignLoading}
                    className="h-11 px-4 bg-accent-bright text-white text-sm font-medium rounded-xl disabled:opacity-50"
                  >
                    Ввести
                  </button>
                </form>

                {assignLoading && (
                  <div className="h-16 bg-surface-muted rounded-xl animate-pulse" />
                )}

                {assignError && !assignLoading && (
                  <div className="text-sm text-rose bg-rose-soft border border-rose-border rounded-xl px-4 py-3">
                    {assignError}
                  </div>
                )}

                {assignResult && !assignLoading && (
                  <div className="bg-emerald-soft border border-emerald-border rounded-xl px-4 py-3">
                    <p className="text-sm font-medium text-emerald mb-1">
                      Привязано успешно
                    </p>
                    <p className="text-xs text-emerald font-mono">{assignResult.barcode}</p>
                    <p className="text-xs text-ink-2 mt-2">Сканируйте следующий</p>
                  </div>
                )}

                {!assignLoading && !assignError && !assignResult && (
                  <p className="text-sm text-ink-3 text-center py-2">
                    Наведите камеру на штрихкод или введите вручную
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Batch mode ───────────────────────────────────────────────────── */}
        {mode === "batch" && (
          <div>
            {!batchEquipment ? (
              <EquipmentList onSelect={(item) => setBatchEquipment(item)} />
            ) : (
              <div className="px-4 pb-4">
                {/* Header with counter + equipment name + done button */}
                <div className="flex items-center justify-between mb-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-ink truncate">
                      {batchEquipment.name}
                    </div>
                    <div className="text-xs text-emerald font-medium">
                      Привязано: {batchItems.length}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      setBatchEquipment(null);
                      setBatchItems([]);
                    }}
                    className="ml-2 px-3 py-1.5 text-xs font-medium bg-accent text-white rounded-lg"
                  >
                    Готово
                  </button>
                </div>

                {/* Manual input */}
                <form onSubmit={handleBatchManualSubmit} className="flex gap-2 mb-3">
                  <input
                    type="text"
                    value={batchManual}
                    onChange={(e) => setBatchManual(e.target.value)}
                    placeholder="Штрихкод вручную"
                    className="flex-1 h-11 px-3 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-accent-bright"
                  />
                  <button
                    type="submit"
                    disabled={batchLoading}
                    className="h-11 px-4 bg-accent-bright text-white text-sm font-medium rounded-xl disabled:opacity-50"
                  >
                    Ввести
                  </button>
                </form>

                {/* Assigned items list */}
                {batchItems.length > 0 ? (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {batchItems.map((item) => (
                      <div
                        key={item.unit.id}
                        className="flex items-center justify-between px-3 py-2.5 bg-surface border border-border rounded-xl"
                      >
                        <span className="text-xs font-mono text-ink-2 truncate">
                          {item.barcode}
                        </span>
                        <button
                          onClick={() => handleBatchDelete(item)}
                          className="ml-2 text-ink-3 hover:text-rose text-lg leading-none shrink-0"
                          aria-label="Удалить"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-ink-3 text-center py-2">
                    Наведите камеру на штрихкод или введите вручную
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

// Доступ защищён middleware.ts + сессией пользователя.
export default function AdminScannerPage() {
  return (
    <Suspense fallback={null}>
      <ScannerApp />
    </Suspense>
  );
}
