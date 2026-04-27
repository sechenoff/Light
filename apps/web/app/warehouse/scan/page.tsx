"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { apiFetch } from "../../../src/lib/api";
import { pluralRu } from "../../../src/lib/pluralRu";
import { RecordPaymentModal } from "../../../src/components/finance/RecordPaymentModal";
import { useCurrentUser } from "../../../src/lib/auth";

const Html5QrcodePlugin = dynamic<{ onScan: (text: string) => void }>(
  () => import("./Html5QrcodePlugin"),
  { ssr: false },
);

// ── Types ─────────────────────────────────────────────────────────────────────

type Operation = "ISSUE" | "RETURN";

type WorkerNamesResponse = { names: string[] };

type AuthResponse = { token: string; name: string; expiresAt: string };

type BookingRow = {
  id: string;
  projectName: string;
  startDate: string;
  endDate: string;
  client: { id: string; name: string };
  items: { id: string }[];
};

type BookingsResponse = { bookings: BookingRow[] };

type SessionResponse = {
  session: {
    id: string;
    bookingId: string;
    operation: Operation;
    status: string;
  };
};

type BookingItem = {
  id: string;
  quantity: number;
  scanMode: "UNIT" | "COUNT";
  scannedCount: number;
  equipment: { id: string; name: string };
  units?: {
    id: string;
    barcode: string;
    reservedButUnavailable?: boolean;
    scanned?: boolean;
  }[];
};

type SessionDetailResponse = {
  session: {
    id: string;
    bookingId: string;
    operation: Operation;
    status: string;
    scans?: Array<{
      id: string;
      equipmentUnitId: string;
      scannedAt: string;
      equipmentUnit: {
        id: string;
        equipmentId: string;
        equipment: { name: string };
      };
    }>;
  };
  bookingItems: BookingItem[];
};

type ScanResult = {
  status: "ok" | "error";
  message?: string;
  unitId?: string;
  itemId?: string;
};

type ReconciliationSummary = {
  sessionId: string;
  operation: Operation;
  scannedCount: number;
  expectedCount: number;
  missingItems: { id: string; name: string; barcode: string }[];
  substitutedItems: { id: string; name: string; barcode: string }[];
};

type RepairUrgency = "NOT_URGENT" | "NORMAL" | "URGENT";

interface BrokenUnit {
  equipmentUnitId: string;
  reason: string;
  urgency: RepairUrgency;
  name: string; // для отображения
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function warehouseFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token =
    typeof window !== "undefined" ? sessionStorage.getItem("warehouse_token") : null;
  return apiFetch<T>(path, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
  } catch {
    return iso;
  }
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function Toast({ message, type }: { message: string; type: "success" | "error" }) {
  return (
    <div
      className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl text-white text-sm font-medium shadow-lg max-w-xs w-full text-center ${
        type === "success" ? "bg-ok" : "bg-rose"
      }`}
    >
      {message}
    </div>
  );
}

// ── Step 1: Login ─────────────────────────────────────────────────────────────

function LoginStep({ onSuccess }: { onSuccess: () => void }) {
  const [names, setNames] = useState<string[]>([]);
  const [selectedName, setSelectedName] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingNames, setLoadingNames] = useState(true);

  useEffect(() => {
    apiFetch<WorkerNamesResponse>("/api/warehouse/workers/names")
      .then((data) => {
        setNames(data.names);
        if (data.names.length > 0) setSelectedName(data.names[0]);
      })
      .catch(() => setError("Не удалось загрузить список сотрудников"))
      .finally(() => setLoadingNames(false));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedName || pin.length < 4) {
      setError("Введите имя и PIN (минимум 4 цифры)");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const data = await apiFetch<AuthResponse>("/api/warehouse/auth", {
        method: "POST",
        body: JSON.stringify({ name: selectedName, pin }),
      });
      sessionStorage.setItem("warehouse_token", data.token);
      onSuccess();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Ошибка входа";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-[calc(100vh-56px)] flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h2 className="text-2xl font-bold text-ink mb-6 text-center">Вход на склад</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-ink mb-1.5">Сотрудник</label>
            {loadingNames ? (
              <div className="h-12 bg-surface-subtle rounded-lg animate-pulse" />
            ) : (
              <select
                value={selectedName}
                onChange={(e) => setSelectedName(e.target.value)}
                className="w-full h-12 px-3 border border-border rounded-lg text-base bg-surface focus:outline-none focus:ring-2 focus:ring-accent-bright"
                required
              >
                <option value="">— выберите сотрудника —</option>
                {names.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-ink mb-1.5">PIN-код</label>
            <input
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              minLength={4}
              maxLength={8}
              placeholder="••••"
              className="w-full h-12 px-3 border border-border rounded-lg text-base focus:outline-none focus:ring-2 focus:ring-accent-bright"
              required
            />
          </div>

          {error && (
            <div className="text-rose text-sm bg-rose-soft border border-rose-border rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full h-14 bg-accent-bright hover:bg-accent disabled:opacity-50 text-white text-base font-semibold rounded-xl transition-colors"
          >
            {loading ? "Вход..." : "Войти"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ── Step 2: Operation Selection ───────────────────────────────────────────────

function OperationStep({ onSelect }: { onSelect: (op: Operation) => void }) {
  return (
    <div className="min-h-[calc(100vh-56px)] flex flex-col items-center justify-center px-4 gap-6">
      <h2 className="text-2xl font-bold text-ink">Выберите операцию</h2>
      <div className="w-full max-w-sm space-y-4">
        <button
          onClick={() => onSelect("ISSUE")}
          className="w-full h-20 bg-accent-bright hover:bg-accent text-white text-xl font-semibold rounded-2xl transition-colors flex items-center justify-center gap-3"
        >
          <span>📤</span>
          Выдача
        </button>
        <button
          onClick={() => onSelect("RETURN")}
          className="w-full h-20 bg-emerald hover:bg-ok text-white text-xl font-semibold rounded-2xl transition-colors flex items-center justify-center gap-3"
        >
          <span>📥</span>
          Возврат
        </button>
      </div>
    </div>
  );
}

// ── Step 3: Booking Selection ─────────────────────────────────────────────────

function BookingStep({
  operation,
  onSelect,
  onUnauth,
  onBack,
}: {
  operation: Operation;
  onSelect: (sessionId: string) => void;
  onUnauth: () => void;
  onBack: () => void;
}) {
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);

  useEffect(() => {
    warehouseFetch<BookingsResponse>(`/api/warehouse/bookings?operation=${operation}`)
      .then((data) => setBookings(data.bookings))
      .catch((err: unknown) => {
        const e = err as { status?: number; message?: string };
        if (e?.status === 401) {
          onUnauth();
          return;
        }
        setError(e?.message ?? "Ошибка загрузки бронирований");
      })
      .finally(() => setLoading(false));
  }, [operation, onUnauth]);

  async function handleSelect(bookingId: string) {
    setCreating(bookingId);
    try {
      const data = await warehouseFetch<SessionResponse>("/api/warehouse/sessions", {
        method: "POST",
        body: JSON.stringify({ bookingId, operation }),
      });
      onSelect(data.session.id);
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      if (e?.status === 401) {
        onUnauth();
        return;
      }
      setError(e?.message ?? "Ошибка создания сессии");
    } finally {
      setCreating(null);
    }
  }

  const opLabel = operation === "ISSUE" ? "Выдача" : "Возврат";

  return (
    <div className="px-4 py-6">
      <button
        onClick={onBack}
        className="mb-4 text-sm text-slate-500 hover:text-slate-700 transition-colors"
      >
        ← Назад
      </button>
      <h2 className="text-xl font-bold text-slate-800 mb-4">{opLabel}: выберите бронирование</h2>

      {loading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 bg-slate-100 rounded-xl animate-pulse" />
          ))}
        </div>
      )}

      {error && (
        <div className="text-rose bg-rose-soft border border-rose-border rounded-xl px-4 py-3 text-sm">
          {error}
        </div>
      )}

      {!loading && !error && bookings.length === 0 && (
        <div className="text-slate-500 text-center py-12">Нет доступных бронирований</div>
      )}

      <div className="space-y-3">
        {bookings.map((b) => {
          const itemCount = b.items.length;
          const isBusy = creating === b.id;
          return (
            <button
              key={b.id}
              onClick={() => handleSelect(b.id)}
              disabled={!!creating}
              className="w-full text-left bg-white border border-slate-200 rounded-xl px-4 py-4 hover:border-accent-bright hover:shadow-sm transition-all disabled:opacity-60 min-h-[80px]"
            >
              <div className="font-semibold text-slate-800 text-base">
                {b.client.name}
              </div>
              <div className="text-slate-600 text-sm mt-0.5">{b.projectName}</div>
              <div className="text-slate-400 text-xs mt-1">
                {formatDate(b.startDate)} — {formatDate(b.endDate)} · {itemCount}{" "}
                {itemCount === 1 ? "позиция" : itemCount < 5 ? "позиции" : "позиций"}
              </div>
              {isBusy && (
                <div className="text-accent-bright text-xs mt-1">Создание сессии...</div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Step 4: Scanning ──────────────────────────────────────────────────────────

function ScanStep({
  sessionId,
  operation,
  onDone,
  onCancel,
  onUnauth,
}: {
  sessionId: string;
  operation: Operation;
  onDone: () => void;
  onCancel: () => void;
  onUnauth: () => void;
}) {
  const [detail, setDetail] = useState<SessionDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const [manualInput, setManualInput] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScanRef = useRef<{ value: string; ts: number }>({ value: "", ts: 0 });
  const scanningRef = useRef(false);

  function showToast(message: string, type: "success" | "error") {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ message, type });
    toastTimerRef.current = setTimeout(() => setToast(null), 2500);
  }

  function playBeep(success: boolean) {
    try {
      navigator.vibrate?.(success ? 100 : [50, 50, 50]);
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = success ? 880 : 440;
      gain.gain.value = 0.3;
      osc.start();
      osc.stop(ctx.currentTime + (success ? 0.15 : 0.3));
    } catch {}
  }

  const loadDetail = useCallback(async () => {
    try {
      const data = await warehouseFetch<SessionDetailResponse>(
        `/api/warehouse/sessions/${sessionId}`,
      );
      setDetail(data);
    } catch (err: unknown) {
      const e = err as { status?: number };
      if (e?.status === 401) onUnauth();
    } finally {
      setLoading(false);
    }
  }, [sessionId, onUnauth]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  const handleScan = useCallback(
    async (barcodePayload: string) => {
      const now = Date.now();
      if (barcodePayload === lastScanRef.current.value && now - lastScanRef.current.ts < 3000) return;
      lastScanRef.current = { value: barcodePayload, ts: now };
      if (scanningRef.current) return;
      scanningRef.current = true;
      try {
        const result = await warehouseFetch<ScanResult>(
          `/api/warehouse/sessions/${sessionId}/scan`,
          {
            method: "POST",
            body: JSON.stringify({ barcodePayload }),
          },
        );
        if (result.status === "ok") {
          playBeep(true);
          showToast("Отсканировано успешно", "success");
          await loadDetail();
        } else {
          playBeep(false);
          showToast(result.message ?? "Ошибка сканирования", "error");
        }
      } catch (err: unknown) {
        const e = err as { status?: number; message?: string };
        if (e?.status === 401) {
          onUnauth();
          return;
        }
        playBeep(false);
        showToast(e?.message ?? "Ошибка сканирования", "error");
      } finally {
        scanningRef.current = false;
      }
    },
    [sessionId, onUnauth, loadDetail],
  );

  async function handleManualSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!manualInput.trim()) return;
    const val = manualInput.trim();
    setManualInput("");
    await handleScan(val);
  }

  async function handleCancelConfirm() {
    setCancelling(true);
    try {
      await warehouseFetch(`/api/warehouse/sessions/${sessionId}/cancel`, {
        method: "POST",
      });
      onCancel();
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      if (e?.status === 401) {
        onUnauth();
        return;
      }
      showToast(e?.message ?? "Ошибка отмены", "error");
    } finally {
      setCancelling(false);
      setConfirmCancel(false);
    }
  }

  if (loading) {
    return (
      <div className="px-4 py-6 space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-16 bg-slate-100 rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  if (!detail) return null;

  const unitItems = detail.bookingItems.filter((item) => item.scanMode === "UNIT");
  const countItems = detail.bookingItems.filter((item) => item.scanMode === "COUNT");
  const opLabel = operation === "ISSUE" ? "выдачи" : "возврата";

  return (
    <div className="px-4 py-4 pb-32">
      <h2 className="text-xl font-bold text-slate-800 mb-4">Сканирование для {opLabel}</h2>

      {/* Camera scanner */}
      <div className="mb-4 rounded-xl overflow-hidden border border-slate-200">
        <Html5QrcodePlugin onScan={handleScan} />
      </div>

      {/* Manual input */}
      <form onSubmit={handleManualSubmit} className="flex gap-2 mb-6">
        <input
          type="text"
          value={manualInput}
          onChange={(e) => setManualInput(e.target.value)}
          placeholder="Введите штрихкод вручную"
          className="flex-1 h-12 px-3 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-accent-bright"
        />
        <button
          type="submit"
          className="h-12 px-4 bg-slate-700 text-white text-sm font-medium rounded-lg hover:bg-slate-800 transition-colors"
        >
          Ввести
        </button>
      </form>

      {/* UNIT items checklist */}
      {unitItems.length > 0 && (
        <div className="mb-4">
          <h3 className="text-sm font-semibold text-slate-600 uppercase tracking-wide mb-2">
            Позиции с поштучным сканированием
          </h3>
          <div className="space-y-2">
            {unitItems.map((item) => {
              const scanned = item.scannedCount ?? 0;
              const total = item.quantity;
              const done = scanned >= total;
              return (
                <div
                  key={item.id}
                  className={`flex items-center justify-between px-4 py-3 rounded-xl border ${
                    done ? "bg-emerald-soft border-emerald-border" : "bg-white border-slate-200"
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-800 truncate">
                      {item.equipment.name}
                    </div>
                    {item.units?.some((u) => u.reservedButUnavailable) && (
                      <div className="text-xs text-amber mt-0.5">
                        ⚠ Часть единиц недоступна
                      </div>
                    )}
                  </div>
                  <div className={`text-sm font-semibold ml-3 ${done ? "text-emerald" : "text-slate-700"}`}>
                    {scanned} / {total}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* COUNT items (greyed out) */}
      {countItems.length > 0 && (
        <div className="mb-4">
          <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wide mb-2">
            Без сканирования (количество)
          </h3>
          <div className="space-y-2">
            {countItems.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between px-4 py-3 rounded-xl border border-slate-100 bg-slate-50"
              >
                <div className="text-sm text-slate-400 truncate">{item.equipment.name}</div>
                <div className="text-sm text-slate-400 ml-3">{item.quantity} шт.</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Bottom actions */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border px-4 py-4 space-y-2">
        <button
          onClick={onDone}
          className="w-full h-14 bg-accent-bright hover:bg-accent text-white text-base font-semibold rounded-xl transition-colors"
        >
          Завершить и просмотреть итог
        </button>
        <button
          onClick={() => setConfirmCancel(true)}
          className="w-full h-12 text-rose border border-rose-border rounded-xl text-sm font-medium hover:bg-rose-soft transition-colors"
        >
          Отменить сессию
        </button>
      </div>

      {/* Toast */}
      {toast && <Toast message={toast.message} type={toast.type} />}

      {/* Cancel confirmation dialog */}
      {confirmCancel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm">
            <h3 className="text-lg font-bold text-ink mb-2">Отменить сессию?</h3>
            <p className="text-sm text-ink-2 mb-6">
              Сессия сканирования будет отменена. Записи сканирования сохранятся для аудита.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmCancel(false)}
                className="flex-1 h-12 border border-border rounded-xl text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
              >
                Отмена
              </button>
              <button
                onClick={handleCancelConfirm}
                disabled={cancelling}
                className="flex-1 h-12 bg-rose hover:bg-rose/80 disabled:opacity-50 text-white rounded-xl text-sm font-semibold transition-colors"
              >
                {cancelling ? "Отмена..." : "Да, отменить"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Step 5: Summary ───────────────────────────────────────────────────────────

// ── Модалка отметки поломки ────────────────────────────────────────────────

function BrokenUnitModal({
  unitId,
  unitName,
  onConfirm,
  onCancel,
}: {
  unitId: string;
  unitName: string;
  onConfirm: (reason: string, urgency: RepairUrgency) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const [urgency, setUrgency] = useState<RepairUrgency>("NORMAL");
  const [err, setErr] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 5) {
      setErr("Укажите причину (минимум 5 символов)");
      return;
    }
    onConfirm(reason.trim(), urgency);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-white rounded-2xl p-6 w-full max-w-sm space-y-4">
        <h3 className="text-lg font-bold text-slate-800">Отметить поломку</h3>
        <p className="text-sm text-slate-600">{unitName}</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Причина поломки</label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-accent-bright"
              placeholder="Опишите повреждение..."
              required
            />
            {err && <p className="text-xs text-rose mt-1">{err}</p>}
          </div>
          <div>
            <p className="text-sm font-medium text-slate-700 mb-2">Срочность</p>
            <div className="space-y-1">
              {([["URGENT", "Срочно"], ["NORMAL", "Обычно"], ["NOT_URGENT", "Не срочно"]] as [RepairUrgency, string][]).map(
                ([val, label]) => (
                  <label key={val} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="urgency"
                      value={val}
                      checked={urgency === val}
                      onChange={() => setUrgency(val)}
                      className="text-accent-bright"
                    />
                    <span className="text-sm text-slate-700">{label}</span>
                  </label>
                ),
              )}
            </div>
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 h-12 border border-border rounded-xl text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
            >
              Отмена
            </button>
            <button
              type="submit"
              className="flex-1 h-12 bg-rose hover:bg-rose/80 text-white rounded-xl text-sm font-semibold transition-colors"
            >
              Отметить
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Step 5: Summary ───────────────────────────────────────────────────────────

function SummaryStep({
  sessionId,
  operation,
  onComplete,
  onUnauth,
}: {
  sessionId: string;
  operation: Operation;
  /** B6: bookingId added so parent can offer payment recording post-issue/return */
  onComplete: (createdRepairIds: string[], failedBrokenUnits: Array<{ unitId: string; reason: string; error: string }>, bookingId?: string) => void;
  onUnauth: () => void;
}) {
  const [summary, setSummary] = useState<ReconciliationSummary | null>(null);
  const [sessionDetail, setSessionDetail] = useState<SessionDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [brokenUnits, setBrokenUnits] = useState<BrokenUnit[]>([]);
  const [brokenModal, setBrokenModal] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    Promise.all([
      warehouseFetch<ReconciliationSummary>(`/api/warehouse/sessions/${sessionId}/summary`),
      warehouseFetch<SessionDetailResponse>(`/api/warehouse/sessions/${sessionId}`),
    ])
      .then(([s, d]) => {
        setSummary(s);
        setSessionDetail(d);
      })
      .catch((err: unknown) => {
        const e = err as { status?: number; message?: string };
        if (e?.status === 401) {
          onUnauth();
          return;
        }
        setError(e?.message ?? "Ошибка загрузки итогов");
      })
      .finally(() => setLoading(false));
  }, [sessionId, onUnauth]);

  function markBroken(unitId: string, name: string) {
    setBrokenModal({ id: unitId, name });
  }

  function confirmBroken(reason: string, urgency: RepairUrgency) {
    if (!brokenModal) return;
    setBrokenUnits((prev) => {
      // Заменить существующую запись если есть
      const filtered = prev.filter((b) => b.equipmentUnitId !== brokenModal.id);
      return [...filtered, { equipmentUnitId: brokenModal.id, reason, urgency, name: brokenModal.name }];
    });
    setBrokenModal(null);
  }

  function removeBroken(unitId: string) {
    setBrokenUnits((prev) => prev.filter((b) => b.equipmentUnitId !== unitId));
  }

  async function handleComplete() {
    setCompleting(true);
    try {
      const body: { brokenUnits?: Omit<BrokenUnit, "name">[] } = {};
      if (brokenUnits.length > 0) {
        body.brokenUnits = brokenUnits.map(({ equipmentUnitId, reason, urgency }) => ({
          equipmentUnitId, reason, urgency,
        }));
      }
      const result = await warehouseFetch<{
        createdRepairIds: string[];
        failedBrokenUnits: Array<{ unitId: string; reason: string; error: string }>;
      }>(`/api/warehouse/sessions/${sessionId}/complete`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      onComplete(result.createdRepairIds ?? [], result.failedBrokenUnits ?? [], sessionDetail?.session.bookingId);
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      if (e?.status === 401) {
        onUnauth();
        return;
      }
      setError(e?.message ?? "Ошибка завершения");
    } finally {
      setCompleting(false);
    }
  }

  const opLabel = operation === "ISSUE" ? "выдачу" : "возврат";
  const opLabelCap = operation === "ISSUE" ? "Выдача" : "Возврат";

  // Все отсканированные единицы из сессии (для RETURN — список поштучных)
  const scannedUnits = sessionDetail?.session.scans ?? [];

  if (loading) {
    return (
      <div className="px-4 py-6 space-y-4">
        <div className="h-8 bg-slate-100 rounded-lg animate-pulse" />
        <div className="h-32 bg-slate-100 rounded-xl animate-pulse" />
      </div>
    );
  }

  return (
    <div className="px-4 py-6 pb-32">
      <h2 className="text-xl font-bold text-slate-800 mb-4">Итог: {opLabelCap}</h2>

      {error && (
        <div className="text-rose bg-rose-soft border border-rose-border rounded-xl px-4 py-3 text-sm mb-4">
          {error}
        </div>
      )}

      {summary && (
        <>
          {/* Summary stats */}
          <div className="grid grid-cols-2 gap-3 mb-6">
            <div className="bg-emerald-soft border border-emerald-border rounded-xl px-4 py-4 text-center">
              <div className="text-3xl font-bold text-emerald">{summary.scannedCount}</div>
              <div className="text-xs text-ok mt-1">Отсканировано</div>
            </div>
            <div className="bg-surface-subtle border border-border rounded-xl px-4 py-4 text-center">
              <div className="text-3xl font-bold text-slate-700">{summary.expectedCount}</div>
              <div className="text-xs text-slate-500 mt-1">Ожидалось</div>
            </div>
          </div>

          {/* RETURN: список единиц с кнопкой поломки */}
          {operation === "RETURN" && scannedUnits.length > 0 && (
            <div className="mb-4">
              <h3 className="text-sm font-semibold text-slate-600 uppercase tracking-wide mb-2">
                Принятые единицы
              </h3>
              <div className="space-y-2">
                {scannedUnits.map((scan) => {
                  const broken = brokenUnits.find((b) => b.equipmentUnitId === scan.equipmentUnitId);
                  return (
                    <div
                      key={scan.equipmentUnitId}
                      className={`flex items-center justify-between px-3 py-2.5 rounded-xl border ${
                        broken
                          ? "bg-rose-soft border-rose-border"
                          : "bg-white border-slate-200"
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-slate-800 truncate">
                          {scan.equipmentUnit.equipment.name}
                        </div>
                        {broken && (
                          <div className="text-xs text-rose mt-0.5">Поломка отмечена</div>
                        )}
                      </div>
                      {broken ? (
                        <button
                          onClick={() => removeBroken(scan.equipmentUnitId)}
                          className="ml-2 text-xs text-slate-400 hover:text-rose transition-colors"
                        >
                          Отменить
                        </button>
                      ) : (
                        <button
                          onClick={() => markBroken(scan.equipmentUnitId, scan.equipmentUnit.equipment.name)}
                          className="ml-2 text-xs text-amber border border-amber-border rounded-lg px-2 py-1 hover:bg-amber-soft transition-colors whitespace-nowrap"
                        >
                          🔧 Поломка
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Missing items */}
          {summary.missingItems.length > 0 && (
            <div className="mb-4">
              <h3 className="text-sm font-semibold text-rose mb-2">
                Не найдено ({summary.missingItems.length})
              </h3>
              <div className="space-y-1">
                {summary.missingItems.map((item) => (
                  <div
                    key={item.id}
                    className="text-sm text-rose bg-rose-soft border border-rose-border rounded-lg px-3 py-2"
                  >
                    {item.name} — <span className="font-mono text-xs">{item.barcode}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Substituted items */}
          {summary.substitutedItems.length > 0 && (
            <div className="mb-4">
              <h3 className="text-sm font-semibold text-amber mb-2">
                Замены ({summary.substitutedItems.length})
              </h3>
              <div className="space-y-1">
                {summary.substitutedItems.map((item) => (
                  <div
                    key={item.id}
                    className="text-sm text-amber bg-amber-soft border border-amber-border rounded-lg px-3 py-2"
                  >
                    {item.name} — <span className="font-mono text-xs">{item.barcode}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {summary.missingItems.length === 0 && summary.substitutedItems.length === 0 && scannedUnits.length === 0 && (
            <div className="text-center text-emerald bg-emerald-soft border border-emerald-border rounded-xl px-4 py-6 mb-4">
              <div className="text-2xl mb-1">✓</div>
              <div className="font-semibold">Всё в порядке</div>
              <div className="text-sm text-ok mt-1">Все позиции совпадают</div>
            </div>
          )}
        </>
      )}

      {/* Bottom action */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border px-4 py-4">
        {brokenUnits.length > 0 && (
          <p className="text-xs text-amber mb-2 text-center">
            {brokenUnits.length} {brokenUnits.length === 1 ? "единица" : "единицы"} отмечено как поломка
          </p>
        )}
        <button
          onClick={handleComplete}
          disabled={completing || !summary}
          className="w-full h-14 bg-accent-bright hover:bg-accent disabled:opacity-50 text-white text-base font-semibold rounded-xl transition-colors"
        >
          {completing ? "Подтверждение..." : `Подтвердить ${opLabel}`}
        </button>
      </div>

      {/* Модалка поломки */}
      {brokenModal && (
        <BrokenUnitModal
          unitId={brokenModal.id}
          unitName={brokenModal.name}
          onConfirm={confirmBroken}
          onCancel={() => setBrokenModal(null)}
        />
      )}
    </div>
  );
}

// ── Main page component ───────────────────────────────────────────────────────

type Step = "login" | "operation" | "booking" | "scan" | "summary";

export default function WarehouseScanPage() {
  const { user } = useCurrentUser();
  const hasMainSession = user?.role === "SUPER_ADMIN" || user?.role === "WAREHOUSE";

  const [step, setStep] = useState<Step>("login");
  const [operation, setOperation] = useState<Operation>("ISSUE");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [completionToast, setCompletionToast] = useState<string | null>(null);
  const [errorToast, setErrorToast] = useState<string | null>(null);
  // B6: payment modal after issue/return (T2 third call-site)
  const [paymentBookingId, setPaymentBookingId] = useState<string | null>(null);

  // Когда main session загрузилась — пропустить LoginStep
  useEffect(() => {
    if (hasMainSession && step === "login") {
      setStep("operation");
    }
  }, [hasMainSession, step]);

  const goToLogin = useCallback(() => {
    sessionStorage.removeItem("warehouse_token");
    // Если у пользователя есть main session — не возвращать на PIN,
    // а оставаться на operation (PIN уже не нужен)
    if (hasMainSession) {
      setStep("operation");
    } else {
      setStep("login");
    }
  }, [hasMainSession]);

  function handleLoginSuccess() {
    setStep("operation");
  }

  function handleOperationSelect(op: Operation) {
    setOperation(op);
    setStep("booking");
  }

  function handleBookingSelect(sid: string) {
    setSessionId(sid);
    setStep("scan");
  }

  function handleScanDone() {
    setStep("summary");
  }

  function handleScanCancel() {
    setSessionId(null);
    setStep("operation");
  }

  function handleSummaryComplete(
    createdRepairIds: string[],
    failedBrokenUnits: Array<{ unitId: string; reason: string; error: string }>,
    bookingId?: string,
  ) {
    setSessionId(null);
    setStep("operation");
    const n = createdRepairIds.length;
    if (n > 0) {
      setCompletionToast(`Создано ${n} ${pluralRu(n, ["карточка", "карточки", "карточек"])} ремонта`);
      setTimeout(() => setCompletionToast(null), 5000);
    }
    if (failedBrokenUnits.length > 0) {
      const m = failedBrokenUnits.length;
      setErrorToast(`Не удалось создать ${m} ${pluralRu(m, ["карточку", "карточки", "карточек"])} — обратитесь к администратору`);
      setTimeout(() => setErrorToast(null), 8000);
    }
    // B6: T2 — offer payment recording after session complete (spec: warehouse/scan post-issue)
    if (bookingId) {
      setPaymentBookingId(bookingId);
    }
  }

  return (
    <>
      {step === "login" && <LoginStep onSuccess={handleLoginSuccess} />}

      {step === "operation" && <OperationStep onSelect={handleOperationSelect} />}

      {step === "booking" && (
        <BookingStep
          operation={operation}
          onSelect={handleBookingSelect}
          onUnauth={goToLogin}
          onBack={() => setStep("operation")}
        />
      )}

      {step === "scan" && sessionId && (
        <ScanStep
          sessionId={sessionId}
          operation={operation}
          onDone={handleScanDone}
          onCancel={handleScanCancel}
          onUnauth={goToLogin}
        />
      )}

      {step === "summary" && sessionId && (
        <SummaryStep
          sessionId={sessionId}
          operation={operation}
          onComplete={handleSummaryComplete}
          onUnauth={goToLogin}
        />
      )}

      {/* Toast: карточки ремонта созданы */}
      {completionToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl bg-slate-800 text-white text-sm font-medium shadow-lg max-w-xs w-full text-center">
          {completionToast}
          {" · "}
          <a href="/repair" className="underline text-accent-border">
            Открыть мастерскую
          </a>
        </div>
      )}

      {/* Toast: ошибка создания карточек ремонта */}
      {errorToast && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl bg-rose-600 text-white text-sm font-medium shadow-lg max-w-xs w-full text-center">
          {errorToast}
        </div>
      )}

      {/* B6: T2 — RecordPaymentModal on /warehouse/scan post-issue/return */}
      <RecordPaymentModal
        open={paymentBookingId !== null}
        defaultBookingId={paymentBookingId ?? undefined}
        onClose={() => setPaymentBookingId(null)}
        onCreated={() => setPaymentBookingId(null)}
      />
    </>
  );
}
