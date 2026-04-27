"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "../../../src/lib/api";
import { pluralRu } from "../../../src/lib/pluralRu";
import { RecordPaymentModal } from "../../../src/components/finance/RecordPaymentModal";
import { useCurrentUser } from "../../../src/lib/auth";
import { toast } from "../../../src/components/ToastProvider";

// ── Типы ─────────────────────────────────────────────────────────────────────────

type Operation = "ISSUE" | "RETURN";

type WorkerNamesResponse = { names: string[] };
type AuthResponse = { token: string; name: string; expiresAt: string };

type BookingRow = {
  id: string;
  projectName: string;
  startDate: string;
  endDate: string;
  status: string;
  client: { id: string; name: string };
  items: { id: string }[];
};

type BookingsResponse = { bookings: BookingRow[] };

type SessionResponse = {
  session: { id: string; bookingId: string; operation: Operation; status: string };
};

type ChecklistUnit = {
  unitId: string;
  barcode: string | null;
  checked: boolean;
  problemType: "BROKEN" | "LOST" | null;
};

type ChecklistItem = {
  bookingItemId: string;
  equipmentId: string | null;
  equipmentName: string;
  category: string;
  quantity: number;
  checkedQty: number;
  trackingMode: "COUNT" | "UNIT";
  isExtra: boolean;
  units?: ChecklistUnit[];
};

type ChecklistState = {
  sessionId: string;
  bookingId: string;
  operation: Operation;
  items: ChecklistItem[];
  progress: { checkedItems: number; totalItems: number };
};

type RepairUrgency = "NOT_URGENT" | "NORMAL" | "URGENT";

type ProblemUnit = {
  unitId: string;
  unitName: string;
  type: "BROKEN" | "LOST";
  reason: string;
  urgency?: RepairUrgency;
  lostLocation?: "ON_SITE" | "IN_TRANSIT" | "AT_CLIENT" | "UNKNOWN";
  chargeClient?: boolean;
};

type CatalogEquipment = {
  id: string;
  name: string;
  category: string;
  rentalRatePerShift: number | null;
  stockTrackingMode: string;
};

// ── warehouseFetch ────────────────────────────────────────────────────────────────

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

// ── Хелперы ───────────────────────────────────────────────────────────────────────

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
  } catch {
    return iso;
  }
}

function formatRub(n: number | null | undefined) {
  if (n == null) return "";
  return n.toLocaleString("ru-RU") + " ₽";
}

function statusLabel(status: string) {
  const map: Record<string, string> = {
    CONFIRMED: "Подтверждена",
    ISSUED: "Выдана",
    DRAFT: "Черновик",
    PENDING_APPROVAL: "На согласовании",
    RETURNED: "Возвращена",
    CANCELLED: "Отменена",
  };
  return map[status] ?? status;
}

function statusVariant(status: string): string {
  const map: Record<string, string> = {
    CONFIRMED: "bg-accent-soft text-accent-bright border border-accent-border",
    ISSUED: "bg-emerald-soft text-emerald border border-emerald-border",
    PENDING_APPROVAL: "bg-amber-soft text-amber border border-amber-border",
    DRAFT: "bg-surface-subtle text-ink-2 border border-border",
  };
  return map[status] ?? "bg-surface-subtle text-ink-3 border border-border";
}

// ── Step 1: Login ─────────────────────────────────────────────────────────────────

function LoginStep({ onSuccess }: { onSuccess: () => void }) {
  const [names, setNames] = useState<string[]>([]);
  const [selectedName, setSelectedName] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingNames, setLoadingNames] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiFetch<WorkerNamesResponse>("/api/warehouse/workers/names")
      .then((data) => {
        if (cancelled) return;
        setNames(data.names);
        if (data.names.length > 0) setSelectedName(data.names[0]);
      })
      .catch(() => { if (!cancelled) setError("Не удалось загрузить список сотрудников"); })
      .finally(() => { if (!cancelled) setLoadingNames(false); });
    return () => { cancelled = true; };
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
    <div className="min-h-screen flex items-center justify-center px-4 bg-surface-2">
      <div className="w-full max-w-[360px] bg-surface border border-border rounded-2xl p-6 shadow-xs">
        <div className="text-center mb-6">
          <div className="text-3xl mb-2">🏭</div>
          <h2 className="text-xl font-semibold text-ink">Вход на склад</h2>
          <p className="text-sm text-ink-3 mt-1">Выберите имя и введите PIN</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-ink-2 uppercase tracking-wide mb-1.5">Сотрудник</label>
            {loadingNames ? (
              <div className="h-12 bg-surface-subtle rounded-lg animate-pulse" />
            ) : (
              <select
                value={selectedName}
                onChange={(e) => setSelectedName(e.target.value)}
                className="w-full h-12 px-3 border border-border rounded-lg text-base bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-bright"
                required
              >
                <option value="">— выберите сотрудника —</option>
                {names.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink-2 uppercase tracking-wide mb-1.5">PIN-код</label>
            <input
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              minLength={4}
              maxLength={8}
              placeholder="••••"
              className="w-full h-12 px-3 border border-border rounded-lg text-base text-ink focus:outline-none focus:ring-2 focus:ring-accent-bright"
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

// ── Step 2: Operation Selection ───────────────────────────────────────────────────

function OperationStep({
  onSelect,
  workerName,
}: {
  onSelect: (op: Operation) => void;
  workerName: string;
}) {
  const today = new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "long" });

  return (
    <div className="min-h-screen bg-surface-2 flex flex-col">
      {/* Header */}
      <div className="bg-surface border-b border-border px-4 py-3 flex items-center gap-3">
        <div className="flex-1">
          <h2 className="text-[15px] font-semibold text-ink">Склад</h2>
          <div className="text-xs text-ink-3 mt-0.5">{workerName} · {today}</div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 p-4">
        <p className="text-xs font-semibold text-ink-2 uppercase tracking-wide mb-4">Что вы делаете сейчас?</p>

        <button
          onClick={() => onSelect("ISSUE")}
          className="w-full text-left border border-accent-border bg-accent-soft rounded-2xl p-[22px] mb-4 active:opacity-80 transition-opacity"
          style={{ background: "linear-gradient(135deg, var(--accent-soft) 0%, var(--surface) 70%)", borderColor: "var(--accent-bright)" }}
        >
          <span className="text-3xl block mb-2">📤</span>
          <span className="block font-bold text-accent-bright" style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif", fontSize: 22 }}>Выдача</span>
          <span className="block text-sm text-ink-2 mt-1">Загрузить оборудование клиенту</span>
        </button>

        <button
          onClick={() => onSelect("RETURN")}
          className="w-full text-left border rounded-2xl p-[22px] mb-4 active:opacity-80 transition-opacity"
          style={{ background: "linear-gradient(135deg, var(--teal-soft) 0%, var(--surface) 70%)", borderColor: "var(--teal)" }}
        >
          <span className="text-3xl block mb-2">📥</span>
          <span className="block font-bold" style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif", fontSize: 22, color: "var(--teal)" }}>Возврат</span>
          <span className="block text-sm text-ink-2 mt-1">Принять оборудование от клиента</span>
        </button>

        <div className="mt-4 p-3 bg-surface border border-dashed border-border-2 rounded-xl text-xs text-ink-2 text-center">
          Нужно зарегистрировать поломку без возврата?{" "}
          <a href="/repair" className="text-accent-bright font-medium">Открыть мастерскую →</a>
        </div>
      </div>
    </div>
  );
}

// ── Step 3: Booking Selection ─────────────────────────────────────────────────────

function BookingStep({
  operation,
  onSelect,
  onUnauth,
  onBack,
}: {
  operation: Operation;
  onSelect: (sessionId: string, bookingId: string, clientName: string) => void;
  onUnauth: () => void;
  onBack: () => void;
}) {
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"today" | "tomorrow" | "all">("today");

  useEffect(() => {
    let cancelled = false;
    warehouseFetch<BookingsResponse>(`/api/warehouse/bookings?operation=${operation}`)
      .then((data) => { if (!cancelled) setBookings(data.bookings); })
      .catch((err: unknown) => {
        const e = err as { status?: number; message?: string };
        if (cancelled) return;
        if (e?.status === 401) { onUnauth(); return; }
        setError(e?.message ?? "Ошибка загрузки бронирований");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [operation, onUnauth]);

  async function handleSelect(b: BookingRow) {
    setCreating(b.id);
    try {
      const data = await warehouseFetch<SessionResponse>("/api/warehouse/sessions", {
        method: "POST",
        body: JSON.stringify({ bookingId: b.id, operation }),
      });
      onSelect(data.session.id, b.id, b.client.name);
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      if (e?.status === 401) { onUnauth(); return; }
      setError(e?.message ?? "Ошибка создания сессии");
    } finally {
      setCreating(null);
    }
  }

  const opLabel = operation === "ISSUE" ? "Выдача" : "Возврат";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const filtered = bookings.filter((b) => {
    if (search) {
      const q = search.toLowerCase();
      if (!b.client.name.toLowerCase().includes(q) && !b.projectName.toLowerCase().includes(q)) {
        return false;
      }
    }
    if (tab === "today") {
      const sd = new Date(b.startDate);
      sd.setHours(0, 0, 0, 0);
      return sd.getTime() === today.getTime();
    }
    if (tab === "tomorrow") {
      const sd = new Date(b.startDate);
      sd.setHours(0, 0, 0, 0);
      return sd.getTime() <= tomorrow.getTime();
    }
    return true;
  });

  return (
    <div className="min-h-screen flex flex-col bg-surface">
      {/* Header */}
      <div className="bg-surface border-b border-border px-4 py-3 flex items-center gap-3">
        <button onClick={onBack} className="text-2xl text-ink-2 leading-none w-10 h-10 flex items-center justify-center" aria-label="Назад">←</button>
        <div className="flex-1 min-w-0">
          <h2 className="text-[15px] font-semibold text-ink truncate">{opLabel}</h2>
          <div className="text-xs text-ink-3">{today.toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border bg-surface">
        {(["today", "tomorrow", "all"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-2.5 text-[13px] font-medium border-b-2 transition-colors ${
              tab === t ? "text-accent-bright border-accent-bright font-semibold" : "text-ink-2 border-transparent"
            }`}
          >
            {t === "today" ? "Сегодня" : t === "tomorrow" ? "+ Завтра" : "Все"}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="px-4 py-2.5 border-b border-border bg-surface">
        <div className="relative">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Найти бронь или клиента..."
            className="w-full pl-8 pr-3 py-2 border border-border rounded-xl text-[13px] bg-surface-2 text-ink focus:outline-none focus:border-accent-bright"
          />
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3 text-sm">🔍</span>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto bg-surface">
        {loading && (
          <div className="space-y-0">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-[72px] border-b border-border px-4 py-3 animate-pulse bg-surface">
                <div className="h-3 bg-surface-subtle rounded w-24 mb-2" />
                <div className="h-4 bg-surface-subtle rounded w-40 mb-1.5" />
                <div className="h-3 bg-surface-subtle rounded w-32" />
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="m-4 text-rose bg-rose-soft border border-rose-border rounded-xl px-4 py-3 text-sm">{error}</div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="text-ink-3 text-center py-16 text-sm">
            {search ? "Ничего не найдено" : "Нет доступных бронирований"}
          </div>
        )}

        {filtered.map((b) => {
          const isBusy = creating === b.id;
          return (
            <button
              key={b.id}
              onClick={() => handleSelect(b)}
              disabled={!!creating}
              className="w-full text-left border-b border-border px-4 py-[14px] flex items-center gap-3 hover:bg-surface-2 active:bg-surface-2 disabled:opacity-60 transition-colors min-h-[72px]"
            >
              <div className="flex-1 min-w-0">
                <div className="text-[11px] text-ink-3 font-mono mb-0.5">
                  {b.projectName || "Бронь"}
                </div>
                <div className="text-[14px] font-medium text-ink mb-1">{b.client.name}</div>
                <div className="flex items-center gap-2 text-xs text-ink-2">
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${statusVariant(b.status)}`}>
                    {statusLabel(b.status)}
                  </span>
                  <span>{formatDate(b.startDate)} — {formatDate(b.endDate)}</span>
                  <span>· {b.items.length} {pluralRu(b.items.length, ["позиция", "позиции", "позиций"])}</span>
                </div>
              </div>
              <span className="text-ink-3 text-lg" aria-hidden="true">›</span>
              {isBusy && <div className="absolute inset-0 bg-surface/50 rounded" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Problem Modal ─────────────────────────────────────────────────────────────────

function ProblemModal({
  unit,
  onConfirm,
  onCancel,
}: {
  unit: { unitId: string; unitName: string; unitBarcode?: string | null };
  onConfirm: (problem: ProblemUnit) => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<"BROKEN" | "LOST">("BROKEN");
  const [reason, setReason] = useState("");
  const [urgency, setUrgency] = useState<RepairUrgency>("NORMAL");
  const [lostLocation, setLostLocation] = useState<"ON_SITE" | "IN_TRANSIT" | "AT_CLIENT" | "UNKNOWN">("ON_SITE");
  const [chargeClient, setChargeClient] = useState(true);
  const [err, setErr] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 5) {
      setErr("Опишите подробнее (минимум 5 символов)");
      return;
    }
    onConfirm({
      unitId: unit.unitId,
      unitName: unit.unitName,
      type,
      reason: reason.trim(),
      urgency: type === "BROKEN" ? urgency : undefined,
      lostLocation: type === "LOST" ? lostLocation : undefined,
      chargeClient: type === "LOST" ? chargeClient : undefined,
    });
  }

  const displayBarcode = unit.unitBarcode
    ? unit.unitBarcode.replace(/^LR-/i, "").substring(0, 12)
    : null;

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center p-6 bg-black/50">
      <div className="bg-surface rounded-2xl w-full max-w-[340px] overflow-hidden shadow-2xl">
        {/* Head */}
        <div className="px-[18px] pt-4 pb-2">
          <h3 className="text-[16px] font-semibold text-ink">Проблема с единицей</h3>
          <div className="text-xs text-ink-3 font-mono mt-1">
            {unit.unitName}{displayBarcode ? ` · ${displayBarcode}` : ""}
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="px-[18px] pb-4">
            {/* Type tabs */}
            <div className="grid grid-cols-2 gap-1 p-2 bg-surface-2 rounded-xl mb-4">
              <button
                type="button"
                onClick={() => setType("BROKEN")}
                className={`py-2 rounded-lg text-[13px] font-medium transition-all ${
                  type === "BROKEN"
                    ? "bg-surface text-rose font-semibold shadow-sm"
                    : "text-ink-3"
                }`}
              >
                🔧 Поломка
              </button>
              <button
                type="button"
                onClick={() => setType("LOST")}
                className={`py-2 rounded-lg text-[13px] font-medium transition-all ${
                  type === "LOST"
                    ? "bg-surface text-amber font-semibold shadow-sm"
                    : "text-ink-3"
                }`}
              >
                ⚠ Утеря
              </button>
            </div>

            {/* Reason */}
            <div className="mb-4">
              <label className="block text-xs text-ink-2 font-medium mb-1.5">
                {type === "BROKEN" ? "Что произошло?" : "Обстоятельства утери"}
              </label>
              <textarea
                value={reason}
                onChange={(e) => { setReason(e.target.value); setErr(""); }}
                rows={3}
                className={`w-full px-3 py-2.5 border rounded-lg text-[13px] text-ink bg-surface focus:outline-none resize-none ${
                  reason.trim().length >= 5 ? "border-accent-bright" : "border-border"
                }`}
                placeholder={type === "BROKEN" ? "Опишите повреждение..." : "Опишите обстоятельства..."}
              />
              {err && <p className="text-xs text-rose mt-1">{err}</p>}
              {reason.trim().length >= 5 && (
                <p className="text-xs text-emerald mt-1">✓ Достаточно подробно</p>
              )}
            </div>

            {type === "BROKEN" ? (
              <div className="mb-2">
                <label className="block text-xs text-ink-2 font-medium mb-2">Срочность</label>
                <div className="space-y-2">
                  {([
                    ["NOT_URGENT", "Не срочно", "14+ дней", "text-ink-2"],
                    ["NORMAL", "Обычная", "3–7 дней", "text-amber"],
                    ["URGENT", "Срочно", "≤ 24 часа", "text-rose"],
                  ] as const).map(([val, label, hint, color]) => (
                    <label
                      key={val}
                      onClick={() => setUrgency(val)}
                      className={`flex items-center gap-3 px-3 py-3 border rounded-xl cursor-pointer transition-colors ${
                        urgency === val
                          ? val === "URGENT"
                            ? "border-rose bg-rose-soft"
                            : val === "NORMAL"
                              ? "border-amber bg-amber-soft"
                              : "border-border bg-surface-2"
                          : "border-border"
                      }`}
                    >
                      <span className={`w-[18px] h-[18px] rounded-full border-2 flex-shrink-0 flex items-center justify-center ${
                        urgency === val
                          ? val === "URGENT"
                            ? "border-rose"
                            : val === "NORMAL"
                              ? "border-amber"
                              : "border-border-2"
                          : "border-border-2"
                      }`}>
                        {urgency === val && (
                          <span className={`w-2 h-2 rounded-full ${
                            val === "URGENT" ? "bg-rose" : val === "NORMAL" ? "bg-amber" : "bg-ink-2"
                          }`} />
                        )}
                      </span>
                      <span className="flex-1 text-[13px] font-medium text-ink">{label}</span>
                      <span className={`text-[11px] font-semibold uppercase tracking-wide ${color}`}>{hint}</span>
                    </label>
                  ))}
                </div>
                <div className="mt-3 px-3 py-2.5 bg-rose-soft rounded-lg text-xs text-rose">
                  Будет создан ремонт. Назначение техника — потом, в /repair.
                </div>
              </div>
            ) : (
              <div className="mb-2">
                <label className="block text-xs text-ink-2 font-medium mb-2">Где утеряна?</label>
                <div className="space-y-2">
                  {([
                    ["ON_SITE", "На площадке"],
                    ["IN_TRANSIT", "В транспорте"],
                    ["AT_CLIENT", "У клиента"],
                    ["UNKNOWN", "Неизвестно"],
                  ] as const).map(([val, label]) => (
                    <label
                      key={val}
                      onClick={() => setLostLocation(val)}
                      className={`flex items-center gap-3 px-3 py-3 border rounded-xl cursor-pointer transition-colors ${
                        lostLocation === val ? "border-amber bg-amber-soft" : "border-border"
                      }`}
                    >
                      <span className={`w-[18px] h-[18px] rounded-full border-2 flex-shrink-0 flex items-center justify-center ${
                        lostLocation === val ? "border-amber" : "border-border-2"
                      }`}>
                        {lostLocation === val && <span className="w-2 h-2 rounded-full bg-amber" />}
                      </span>
                      <span className="text-[13px] font-medium text-ink">{label}</span>
                    </label>
                  ))}
                </div>

                <label className="flex items-center gap-2 mt-3 px-3 py-2.5 border border-amber bg-amber-soft rounded-xl cursor-pointer">
                  <span
                    onClick={() => setChargeClient(!chargeClient)}
                    className={`w-[18px] h-[18px] border-2 rounded flex items-center justify-center flex-shrink-0 transition-colors ${
                      chargeClient ? "border-amber bg-amber" : "border-border-2 bg-surface"
                    }`}
                  >
                    {chargeClient && <span className="text-white text-[11px] font-bold">✓</span>}
                  </span>
                  <span className="text-[13px] text-ink">Добавить компенсацию в счёт</span>
                </label>

                <div className="mt-3 px-3 py-2.5 bg-amber-soft rounded-lg text-xs text-amber">
                  Единица будет списана (RETIRED). Восстановить — через админ-панель.
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex gap-2 px-[14px] pb-[14px] border-t border-border pt-3">
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 h-12 bg-surface border border-border rounded-xl text-[14px] font-medium text-ink"
            >
              Отмена
            </button>
            <button
              type="submit"
              className={`flex-1 h-12 rounded-xl text-[14px] font-semibold text-white ${
                type === "BROKEN" ? "bg-rose" : "bg-amber"
              }`}
            >
              {type === "BROKEN" ? "Зарегистрировать поломку" : "Зарегистрировать утерю"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── QuickAdd Sheet ────────────────────────────────────────────────────────────────

function QuickAddSheet({
  sessionId,
  onAdded,
  onClose,
  onUnauth,
}: {
  sessionId: string;
  onAdded: (name: string) => void;
  onClose: () => void;
  onUnauth: () => void;
}) {
  const [catalog, setCatalog] = useState<CatalogEquipment[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState<string | null>(null);
  const [activeItem, setActiveItem] = useState<CatalogEquipment | null>(null);
  const [qty, setQty] = useState(1);
  const [addedNames, setAddedNames] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    let cancelled = false;
    warehouseFetch<{ equipment: CatalogEquipment[] }>("/api/equipment")
      .then((d) => { if (!cancelled) setCatalog(d.equipment); })
      .catch((err: unknown) => {
        const e = err as { status?: number };
        if (cancelled) return;
        if (e?.status === 401) onUnauth();
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [onUnauth]);

  const filtered = search
    ? catalog.filter((e) =>
        e.name.toLowerCase().includes(search.toLowerCase()) ||
        e.category.toLowerCase().includes(search.toLowerCase()),
      )
    : catalog.slice(0, 30);

  async function handleAdd(item: CatalogEquipment, quantity: number) {
    setAdding(item.id);
    try {
      await warehouseFetch(`/api/warehouse/sessions/${sessionId}/items`, {
        method: "POST",
        body: JSON.stringify({ equipmentId: item.id, quantity }),
      });
      setAddedNames((prev) => [...prev, item.name]);
      onAdded(item.name);
      setActiveItem(null);
      setQty(1);
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      if (e?.status === 401) { onUnauth(); return; }
      toast.error(e?.message ?? "Ошибка добавления");
    } finally {
      setAdding(null);
    }
  }

  return (
    <div className="fixed inset-0 z-10">
      <div className="absolute inset-0 bg-black/45" onClick={onClose} />
      <div className="absolute bottom-0 left-0 right-0 bg-surface rounded-t-2xl shadow-2xl flex flex-col" style={{ maxHeight: "88%" }}>
        {/* Handle */}
        <div className="w-9 h-1 bg-border-2 rounded-full mx-auto mt-2 mb-1" />

        {/* Header */}
        <div className="flex items-center gap-2.5 px-4 pb-3 pt-2 border-b border-border">
          <h3 className="flex-1 text-[16px] font-semibold text-ink">Добавить позицию</h3>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center text-ink-2 text-xl" aria-label="Закрыть">✕</button>
        </div>

        {/* Search */}
        <div className="px-4 py-2.5 border-b border-border">
          <div className="relative">
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по названию или категории..."
              className="w-full pl-8 pr-3 py-2 border border-border rounded-xl text-[13px] bg-surface-2 text-ink focus:outline-none focus:border-accent-bright"
            />
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3 text-sm">🔍</span>
          </div>
        </div>

        {/* Catalog list */}
        <div className="flex-1 overflow-y-auto bg-surface-2">
          {loading && (
            <div className="space-y-0">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-16 border-b border-border bg-surface animate-pulse" />
              ))}
            </div>
          )}

          {!loading && filtered.length === 0 && (
            <div className="text-ink-3 text-center py-12 text-sm">Ничего не найдено</div>
          )}

          <div className="bg-surface">
            {filtered.map((item) => {
              const isAdded = addedNames.includes(item.name);
              const isActive = activeItem?.id === item.id;

              return (
                <div key={item.id}>
                  <div className={`flex items-center gap-3 px-4 py-3 border-t border-border ${isActive ? "bg-accent-soft" : "bg-surface"}`}>
                    <div className="flex-1 min-w-0">
                      <div className="text-[14px] font-medium text-ink mb-0.5 truncate">{item.name}</div>
                      <div className="flex gap-2 text-xs text-ink-3 flex-wrap">
                        <span>{item.category}</span>
                        {item.rentalRatePerShift != null && (
                          <span className="font-mono text-ink-2">от {item.rentalRatePerShift.toLocaleString()} ₽/смена</span>
                        )}
                      </div>
                      {isActive && (
                        <div className="text-[11px] text-accent-bright mt-1">Сколько добавить?</div>
                      )}
                    </div>

                    {isActive ? (
                      <div className="flex items-center gap-0 border border-accent-bright rounded-lg overflow-hidden flex-shrink-0">
                        <button
                          onClick={() => setQty((q) => Math.max(1, q - 1))}
                          className="w-8 h-8 bg-surface text-ink-2 text-base font-medium"
                          aria-label="Уменьшить"
                        >−</button>
                        <span className="w-9 text-center font-semibold font-mono text-ink text-[13px] border-x border-accent-border">
                          {qty}
                        </span>
                        <button
                          onClick={() => setQty((q) => q + 1)}
                          className="w-8 h-8 bg-surface text-ink-2 text-base font-medium"
                          aria-label="Увеличить"
                        >+</button>
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          if (isAdded) return;
                          setActiveItem(item);
                          setQty(1);
                        }}
                        disabled={isAdded || adding === item.id}
                        className={`h-9 px-3 rounded-lg text-[13px] font-semibold border flex-shrink-0 flex items-center gap-1 transition-colors ${
                          isAdded
                            ? "bg-accent-bright border-accent-bright text-white"
                            : "border-accent-bright text-accent-bright bg-surface hover:bg-accent-soft"
                        }`}
                      >
                        {isAdded ? "✓ Добавлено" : "+ Добавить"}
                      </button>
                    )}
                  </div>

                  {isActive && (
                    <div className="px-4 pb-3 bg-accent-soft">
                      <button
                        onClick={() => handleAdd(item, qty)}
                        disabled={adding === item.id}
                        className="w-full py-3 bg-accent-bright text-white rounded-xl text-[14px] font-semibold disabled:opacity-50"
                      >
                        {adding === item.id ? "Добавление..." : `Добавить ${qty} шт. в бронь`}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer summary */}
        {addedNames.length > 0 && (
          <div className="px-4 py-3 border-t border-border bg-surface flex items-center gap-2">
            <span className="bg-teal text-white text-xs font-bold rounded-full w-6 h-6 flex items-center justify-center flex-shrink-0">
              +{addedNames.length}
            </span>
            <span className="flex-1 text-xs text-teal truncate">
              Добавлено: {addedNames.join(", ")}
            </span>
            <button onClick={onClose} className="text-teal text-xs font-semibold whitespace-nowrap">
              Готово →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Step 4: Checklist ─────────────────────────────────────────────────────────────

function ChecklistStep({
  sessionId,
  operation,
  clientName,
  onDone,
  onBack,
  onUnauth,
}: {
  sessionId: string;
  operation: Operation;
  clientName: string;
  onDone: (countChecks: Map<string, number>, problems: ProblemUnit[]) => void;
  onBack: () => void;
  onUnauth: () => void;
}) {
  const [state, setState] = useState<ChecklistState | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [countChecks, setCountChecks] = useState<Map<string, number>>(new Map());
  const [problems, setProblems] = useState<ProblemUnit[]>([]);
  const [problemModal, setProblemModal] = useState<{ unitId: string; unitName: string; unitBarcode?: string | null } | null>(null);
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [confirmMissing, setConfirmMissing] = useState(false);

  const loadState = useCallback(async () => {
    try {
      const s = await warehouseFetch<ChecklistState>(`/api/warehouse/sessions/${sessionId}/state`);
      setState(s);
      // Initialize countChecks for COUNT items that haven't been touched yet
      setCountChecks((prev) => {
        const updated = new Map(prev);
        for (const item of s.items) {
          if (item.trackingMode === "COUNT" && !updated.has(item.bookingItemId)) {
            updated.set(item.bookingItemId, 0);
          }
        }
        return updated;
      });
    } catch (err: unknown) {
      const e = err as { status?: number };
      if (e?.status === 401) onUnauth();
    } finally {
      setLoading(false);
    }
  }, [sessionId, onUnauth]);

  useEffect(() => {
    loadState();
  }, [loadState]);

  async function handleUnitToggle(unitId: string, currentChecked: boolean) {
    // Optimistic update
    setState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        items: prev.items.map((item) => {
          if (!item.units) return item;
          const units = item.units.map((u) =>
            u.unitId === unitId ? { ...u, checked: !currentChecked } : u,
          );
          const checkedQty = units.filter((u) => u.checked).length;
          return { ...item, units, checkedQty };
        }),
      };
    });

    try {
      if (currentChecked) {
        await warehouseFetch(`/api/warehouse/sessions/${sessionId}/uncheck`, {
          method: "POST",
          body: JSON.stringify({ equipmentUnitId: unitId }),
        });
      } else {
        await warehouseFetch(`/api/warehouse/sessions/${sessionId}/check`, {
          method: "POST",
          body: JSON.stringify({ equipmentUnitId: unitId }),
        });
      }
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      if (e?.status === 401) { onUnauth(); return; }
      // Rollback
      setState((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          items: prev.items.map((item) => {
            if (!item.units) return item;
            const units = item.units.map((u) =>
              u.unitId === unitId ? { ...u, checked: currentChecked } : u,
            );
            const checkedQty = units.filter((u) => u.checked).length;
            return { ...item, units, checkedQty };
          }),
        };
      });
      toast.error(e?.message ?? "Ошибка при отметке");
    }
  }

  function handleCountToggle(bookingItemId: string, quantity: number) {
    setCountChecks((prev) => {
      const updated = new Map(prev);
      const current = updated.get(bookingItemId) ?? 0;
      // Toggle: 0 → quantity → 0
      updated.set(bookingItemId, current >= quantity ? 0 : quantity);
      return updated;
    });
  }

  function handleCountStep(bookingItemId: string, quantity: number, delta: number) {
    setCountChecks((prev) => {
      const updated = new Map(prev);
      const current = updated.get(bookingItemId) ?? 0;
      const next = Math.max(0, Math.min(quantity, current + delta));
      updated.set(bookingItemId, next);
      return updated;
    });
  }

  function handleCheckAll() {
    if (!state) return;
    // Mark all UNIT items
    for (const item of state.items) {
      if (item.units) {
        for (const unit of item.units) {
          if (!unit.checked && !hasProblem(unit.unitId)) {
            handleUnitToggle(unit.unitId, false);
          }
        }
      }
    }
    // Mark all COUNT items
    setCountChecks((prev) => {
      const updated = new Map(prev);
      for (const item of state.items) {
        if (item.trackingMode === "COUNT") {
          updated.set(item.bookingItemId, item.quantity);
        }
      }
      return updated;
    });
  }

  function hasProblem(unitId: string) {
    return problems.some((p) => p.unitId === unitId);
  }

  function handleConfirmProblem(problem: ProblemUnit) {
    setProblems((prev) => {
      const filtered = prev.filter((p) => p.unitId !== problem.unitId);
      return [...filtered, problem];
    });
    setProblemModal(null);
  }

  function handleRemoveProblem(unitId: string) {
    setProblems((prev) => prev.filter((p) => p.unitId !== unitId));
  }

  function handleDone() {
    if (!state) return;

    // Calculate total checked items
    const { totalCount, checkedCount } = calculateProgress();
    const hasMissing = checkedCount < totalCount;

    if (hasMissing && !confirmMissing) {
      setConfirmMissing(true);
      return;
    }
    setConfirmMissing(false);
    onDone(countChecks, problems);
  }

  function calculateProgress() {
    if (!state) return { totalCount: 0, checkedCount: 0 };
    let totalCount = 0;
    let checkedCount = 0;

    for (const item of state.items) {
      if (item.trackingMode === "UNIT" && item.units) {
        totalCount += item.units.length;
        checkedCount += item.units.filter((u) => u.checked || hasProblem(u.unitId)).length;
      } else if (item.trackingMode === "COUNT") {
        totalCount += 1;
        const checked = countChecks.get(item.bookingItemId) ?? 0;
        if (checked >= item.quantity) checkedCount += 1;
        else if (checked > 0) checkedCount += 0.5; // partial
      }
    }
    return { totalCount, checkedCount };
  }

  const { totalCount, checkedCount } = calculateProgress();
  const progressPct = totalCount > 0 ? (checkedCount / totalCount) * 100 : 0;
  const allDone = progressPct >= 100;

  const opLabel = operation === "ISSUE" ? "выдачу" : "возврат";
  const opProgress = operation === "ISSUE" ? "Выдано" : "Принято";

  // Filter items by search
  const filteredItems = state?.items.filter((item) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      item.equipmentName.toLowerCase().includes(q) ||
      item.category.toLowerCase().includes(q)
    );
  }) ?? [];

  // Group by category
  const categories = new Map<string, typeof filteredItems>();
  for (const item of filteredItems) {
    const cat = item.isExtra ? "Добавлено на месте" : item.category;
    if (!categories.has(cat)) categories.set(cat, []);
    categories.get(cat)!.push(item);
  }

  // Сортируем: «Добавлено на месте» всегда в конце
  const sortedCategories = [...categories.entries()].sort(([a], [b]) => {
    if (a === "Добавлено на месте") return 1;
    if (b === "Добавлено на месте") return -1;
    return a.localeCompare(b);
  });

  const missingCount = Math.ceil(totalCount - checkedCount);

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col bg-surface">
        <div className="h-14 border-b border-border animate-pulse bg-surface" />
        <div className="h-16 border-b border-border animate-pulse bg-surface-2" />
        <div className="flex-1 space-y-px">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-[60px] border-b border-border bg-surface animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-surface-2">
      {/* Sticky header */}
      <div className="bg-surface border-b border-border px-4 py-3 flex items-center gap-3">
        <button onClick={onBack} className="text-2xl text-ink-2 leading-none w-10 h-10 flex items-center justify-center flex-shrink-0" aria-label="Назад">←</button>
        <div className="flex-1 min-w-0">
          <h2 className="text-[15px] font-semibold text-ink truncate">{clientName}</h2>
          <div className="text-xs text-ink-3 truncate">
            {operation === "ISSUE" ? "выдача" : "возврат"}
          </div>
        </div>
        <button
          onClick={handleCheckAll}
          className="text-xs text-accent-bright font-medium px-2 py-1 flex-shrink-0"
        >
          ✓ Все
        </button>
      </div>

      {/* Progress */}
      <div className="bg-surface border-b border-border px-4 py-3">
        <div className="flex justify-between items-center mb-2 text-[13px]">
          <span className="text-ink-2">{opProgress}</span>
          <span className={`font-mono font-semibold ${allDone ? "text-emerald" : "text-ink"}`}>
            {Math.round(checkedCount)} / {Math.round(totalCount)} поз.
          </span>
        </div>
        <div className="h-1.5 bg-surface-2 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-200 ${allDone ? "bg-emerald" : "bg-accent-bright"}`}
            style={{ width: `${Math.min(100, progressPct)}%` }}
          />
        </div>
      </div>

      {/* Search */}
      <div className="px-4 py-2.5 bg-surface border-b border-border">
        <div className="relative">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по позициям..."
            className="w-full pl-8 pr-3 py-2 border border-border rounded-xl text-[13px] bg-surface-2 text-ink focus:outline-none focus:border-accent-bright"
          />
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3 text-sm">🔍</span>
        </div>
      </div>

      {/* Missing alert (RETURN) */}
      {operation === "RETURN" && missingCount > 0 && checkedCount > 0 && !allDone && (
        <div className="mx-4 mt-3 px-3 py-3 rounded-xl bg-rose-soft border border-rose-border flex items-start gap-2.5">
          <span className="text-xl">⚠</span>
          <div>
            <strong className="text-[13px] text-rose">
              {missingCount} {pluralRu(missingCount, ["позиция", "позиции", "позиций"])} не возвращена
            </strong>
          </div>
        </div>
      )}

      {/* Checklist body */}
      <div className="flex-1 overflow-y-auto pb-32">
        {sortedCategories.map(([cat, items]) => {
          const catTotal = items.reduce((s, item) => {
            if (item.trackingMode === "UNIT") return s + (item.units?.length ?? 0);
            return s + 1;
          }, 0);
          const catChecked = items.reduce((s, item) => {
            if (item.trackingMode === "UNIT") {
              return s + (item.units?.filter((u) => u.checked || hasProblem(u.unitId)).length ?? 0);
            }
            const checked = countChecks.get(item.bookingItemId) ?? 0;
            return s + (checked >= item.quantity ? 1 : 0);
          }, 0);
          const isExtraCat = cat === "Добавлено на месте";

          return (
            <div key={cat} className="bg-surface border-t border-border mt-2">
              {/* Category header */}
              <div className="flex justify-between items-baseline px-4 py-2.5">
                <span className={`text-xs font-semibold uppercase tracking-wide ${isExtraCat ? "text-teal" : "text-ink-2"}`}
                  style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}>
                  {cat}
                </span>
                <span className={`text-xs font-mono ${catChecked >= catTotal ? "text-emerald" : "text-ink-3"}`}>
                  {catChecked} / {catTotal}
                </span>
              </div>

              {/* Items */}
              {items.map((item) => {
                if (item.trackingMode === "UNIT" && item.units) {
                  return item.units.map((unit) => {
                    const prob = problems.find((p) => p.unitId === unit.unitId);
                    const isBroken = prob?.type === "BROKEN";
                    const isLost = prob?.type === "LOST";
                    const isChecked = unit.checked;
                    const displayBarcode = unit.barcode
                      ? unit.barcode.replace(/^LR-/i, "").substring(0, 10)
                      : null;

                    return (
                      <div
                        key={unit.unitId}
                        className={`flex items-center gap-3 px-4 py-3 border-t border-border min-h-[60px] cursor-pointer active:opacity-70 transition-opacity ${
                          isBroken ? "bg-rose-soft" : isLost ? "bg-amber-soft" : isChecked ? "bg-accent-soft" : isExtraCat ? "bg-teal-soft" : "bg-surface"
                        }`}
                        onClick={() => !prob && handleUnitToggle(unit.unitId, isChecked)}
                      >
                        {/* Checkbox */}
                        <span
                          className={`w-7 h-7 rounded-lg border-2 flex items-center justify-center flex-shrink-0 text-lg font-medium transition-all ${
                            prob
                              ? isBroken
                                ? "border-rose bg-rose-soft text-rose"
                                : "border-amber bg-amber-soft text-amber"
                              : isChecked
                                ? isExtraCat
                                  ? "border-teal bg-teal text-white"
                                  : "border-accent-bright bg-accent-bright text-white"
                                : "border-border-2 bg-surface text-transparent"
                          }`}
                          aria-label={isChecked ? "Отмечено" : "Не отмечено"}
                        >
                          {prob ? (isBroken ? "⚠" : "!") : (isChecked ? "✓" : "")}
                        </span>

                        {/* Info */}
                        <div className="flex-1 min-w-0">
                          <div className={`text-[14px] font-medium leading-tight ${isChecked || prob ? "text-ink-2" : "text-ink"}`}>
                            {item.equipmentName}
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            {displayBarcode && (
                              <span className="text-[10px] font-mono text-ink-3 bg-slate-soft px-1.5 py-0.5 rounded">
                                {displayBarcode}
                              </span>
                            )}
                            {prob && (
                              <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full ${
                                isBroken ? "bg-rose-soft text-rose" : "bg-amber-soft text-amber"
                              }`}>
                                {isBroken ? "🔧 в ремонт" : "⚠ утеряна"}
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Problem button (RETURN only) */}
                        {operation === "RETURN" && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (prob) {
                                handleRemoveProblem(unit.unitId);
                              } else {
                                setProblemModal({
                                  unitId: unit.unitId,
                                  unitName: item.equipmentName,
                                  unitBarcode: unit.barcode,
                                });
                              }
                            }}
                            className={`w-9 h-9 rounded-lg border flex items-center justify-center text-base flex-shrink-0 transition-colors ${
                              prob
                                ? "border-rose-border bg-rose-soft text-rose"
                                : "border-border text-ink-2"
                            }`}
                            aria-label="Зарегистрировать проблему"
                          >
                            {prob ? "⚙" : "🔧"}
                          </button>
                        )}
                      </div>
                    );
                  });
                }

                // COUNT item
                const checked = countChecks.get(item.bookingItemId) ?? 0;
                const isFullyChecked = checked >= item.quantity;
                const isPartial = checked > 0 && checked < item.quantity;

                return (
                  <div
                    key={item.bookingItemId}
                    className={`flex items-center gap-3 px-4 py-3 border-t border-border min-h-[60px] cursor-pointer active:opacity-70 transition-opacity ${
                      isFullyChecked
                        ? isExtraCat
                          ? "bg-teal-soft"
                          : "bg-accent-soft"
                        : isPartial
                          ? "bg-amber-soft"
                          : isExtraCat
                            ? "bg-teal-soft opacity-60"
                            : "bg-surface"
                    }`}
                    onClick={() => handleCountToggle(item.bookingItemId, item.quantity)}
                  >
                    {/* Checkbox */}
                    <span
                      className={`w-7 h-7 rounded-lg border-2 flex items-center justify-center flex-shrink-0 text-lg font-medium transition-all ${
                        isFullyChecked
                          ? isExtraCat
                            ? "border-teal bg-teal text-white"
                            : "border-accent-bright bg-accent-bright text-white"
                          : isPartial
                            ? "border-amber bg-amber-soft text-amber"
                            : "border-border-2 bg-surface text-transparent"
                      }`}
                      aria-label={isFullyChecked ? "Отмечено" : isPartial ? "Частично" : "Не отмечено"}
                    >
                      {isFullyChecked ? "✓" : isPartial ? "−" : ""}
                    </span>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className={`text-[14px] font-medium leading-tight ${isFullyChecked ? "text-ink-2" : "text-ink"}`}>
                        {item.equipmentName}
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <span className={`text-xs font-mono font-medium ${isPartial ? "text-amber" : "text-ink-2"}`}>
                          {isPartial ? `${checked} / ${item.quantity} шт.` : `${item.quantity} шт.`}
                        </span>
                        {isPartial && <span className="text-xs text-amber">· частично</span>}
                        {item.isExtra && (
                          <span className="text-[10px] font-semibold uppercase tracking-wide bg-teal-soft text-teal px-2 py-0.5 rounded-full">
                            + доп
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Partial stepper (shown only for partial) */}
                    {isPartial && (
                      <div
                        className="flex items-center border border-border-2 rounded-lg overflow-hidden flex-shrink-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          onClick={() => handleCountStep(item.bookingItemId, item.quantity, -1)}
                          className="w-8 h-8 bg-surface text-ink-2 text-base"
                          aria-label="Уменьшить"
                        >−</button>
                        <span className="w-9 text-center text-[13px] font-mono font-semibold text-ink border-x border-border h-8 flex items-center justify-center">
                          {checked}
                        </span>
                        <button
                          onClick={() => handleCountStep(item.bookingItemId, item.quantity, 1)}
                          className="w-8 h-8 bg-surface text-ink-2 text-base"
                          aria-label="Увеличить"
                        >+</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}

        {/* Bottom spacer */}
        <div className="h-24" />
      </div>

      {/* FAB (issue mode only) */}
      {operation === "ISSUE" && (
        <button
          onClick={() => setShowQuickAdd(true)}
          className="fixed right-4 text-white text-[14px] font-semibold flex items-center gap-2 px-[18px] h-[52px] rounded-[26px] shadow-lg"
          style={{
            bottom: 84,
            background: "var(--accent-bright)",
            boxShadow: "0 6px 16px rgba(29, 78, 216, 0.32)",
          }}
          aria-label="Добавить позицию"
        >
          <span className="text-lg leading-none">+</span>
          <span>Добавить позицию</span>
        </button>
      )}

      {/* Sticky CTA */}
      <div className="fixed bottom-0 left-0 right-0 bg-surface border-t border-border px-4 py-3 pb-safe shadow-lg">
        <button
          onClick={handleDone}
          disabled={checkedCount === 0 && problems.length === 0}
          className={`w-full py-[14px] text-[15px] font-semibold rounded-xl transition-colors ${
            allDone
              ? "bg-emerald text-white"
              : checkedCount > 0 || problems.length > 0
                ? "bg-accent-bright text-white"
                : "bg-surface-2 text-ink-3 cursor-not-allowed"
          }`}
        >
          Завершить {opLabel}
        </button>
        <div className="text-xs text-ink-3 text-center mt-1.5">
          {allDone
            ? `К ${opLabel === "выдачу" ? "выдаче" : "возврату"}: ${Math.round(totalCount)} поз.${problems.length > 0 ? ` · ${problems.length} с проблемой` : ""}`
            : checkedCount > 0
              ? `Отмечено ${Math.round(checkedCount)} из ${Math.round(totalCount)} позиций`
              : `Начните отмечать позиции`}
        </div>
      </div>

      {/* Confirm with missing modal */}
      {confirmMissing && (
        <div className="fixed inset-0 z-20 flex items-center justify-center p-6 bg-black/50">
          <div className="bg-surface rounded-2xl w-full max-w-[340px] overflow-hidden shadow-2xl">
            <div className="px-[18px] pt-4 pb-2">
              <h3 className="text-[16px] font-semibold text-ink">Закрыть с задолженностью?</h3>
              <div className="text-xs text-ink-2 mt-1">
                {missingCount} {pluralRu(missingCount, ["позиция", "позиции", "позиций"])} не {operation === "ISSUE" ? "выдана" : "возвращена"}
              </div>
            </div>
            <div className="px-[18px] py-3 text-[13px] text-ink-2">
              <div className="mt-2 p-2.5 bg-rose-soft rounded-lg text-xs text-rose">
                Незакрытые позиции останутся как задолженность.
              </div>
            </div>
            <div className="flex gap-2 px-[14px] pb-[14px] border-t border-border pt-3">
              <button
                onClick={() => setConfirmMissing(false)}
                className="flex-1 h-12 bg-surface border border-border rounded-xl text-[14px] font-medium text-ink"
              >
                Отмена
              </button>
              <button
                onClick={() => {
                  setConfirmMissing(false);
                  onDone(countChecks, problems);
                }}
                className="flex-1 h-12 bg-rose rounded-xl text-[14px] font-semibold text-white"
              >
                Закрыть с долгом
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Problem modal */}
      {problemModal && (
        <ProblemModal
          unit={problemModal}
          onConfirm={handleConfirmProblem}
          onCancel={() => setProblemModal(null)}
        />
      )}

      {/* Quick add sheet */}
      {showQuickAdd && (
        <QuickAddSheet
          sessionId={sessionId}
          onAdded={(name) => {
            toast.success(`+1 добавлено: ${name}`);
            loadState();
          }}
          onClose={() => {
            setShowQuickAdd(false);
            loadState();
          }}
          onUnauth={onUnauth}
        />
      )}
    </div>
  );
}

// ── Step 5: Summary ───────────────────────────────────────────────────────────────

function SummaryStep({
  sessionId,
  operation,
  clientName,
  countChecks,
  problems,
  onComplete,
  onBack,
  onUnauth,
}: {
  sessionId: string;
  operation: Operation;
  clientName: string;
  countChecks: Map<string, number>;
  problems: ProblemUnit[];
  onComplete: (bookingId?: string) => void;
  onBack: () => void;
  onUnauth: () => void;
}) {
  const [state, setState] = useState<ChecklistState | null>(null);
  const [loading, setLoading] = useState(true);
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    warehouseFetch<ChecklistState>(`/api/warehouse/sessions/${sessionId}/state`)
      .then((s) => { if (!cancelled) setState(s); })
      .catch((err: unknown) => {
        const e = err as { status?: number; message?: string };
        if (cancelled) return;
        if (e?.status === 401) { onUnauth(); return; }
        setError(e?.message ?? "Ошибка загрузки");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, onUnauth]);

  async function handleComplete() {
    setCompleting(true);
    setError(null);
    try {
      const brokenUnits = problems
        .filter((p) => p.type === "BROKEN")
        .map((p) => ({
          equipmentUnitId: p.unitId,
          reason: p.reason,
          urgency: p.urgency ?? "NORMAL",
        }));

      const lostUnits = problems
        .filter((p) => p.type === "LOST")
        .map((p) => ({
          equipmentUnitId: p.unitId,
          reason: p.reason,
          lostLocation: p.lostLocation ?? "UNKNOWN",
          chargeClient: p.chargeClient ?? false,
        }));

      const body: Record<string, unknown> = {};
      if (brokenUnits.length > 0) body.brokenUnits = brokenUnits;
      if (lostUnits.length > 0) body.lostUnits = lostUnits;

      await warehouseFetch(`/api/warehouse/sessions/${sessionId}/complete`, {
        method: "POST",
        body: JSON.stringify(body),
      });

      onComplete(state?.bookingId);
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      if (e?.status === 401) { onUnauth(); return; }
      setError(e?.message ?? "Ошибка завершения");
    } finally {
      setCompleting(false);
    }
  }

  const opLabel = operation === "ISSUE" ? "выдачу" : "возврат";

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col bg-surface-2">
        <div className="h-14 border-b border-border animate-pulse bg-surface" />
        <div className="flex-1 space-y-2 p-4">
          {[1, 2, 3].map((i) => <div key={i} className="h-16 bg-surface rounded-xl animate-pulse" />)}
        </div>
      </div>
    );
  }

  // Calculate totals
  const unitItems = state?.items.filter((i) => i.trackingMode === "UNIT") ?? [];
  const countItems = state?.items.filter((i) => i.trackingMode === "COUNT") ?? [];
  const extraItems = state?.items.filter((i) => i.isExtra) ?? [];

  const totalUnitChecked = unitItems.reduce((s, i) => s + (i.units?.filter((u) => u.checked).length ?? 0), 0);
  const totalCountChecked = countItems.reduce((s, i) => {
    const checked = countChecks.get(i.bookingItemId) ?? 0;
    return s + checked;
  }, 0);
  const totalChecked = totalUnitChecked + totalCountChecked;

  const brokenCount = problems.filter((p) => p.type === "BROKEN").length;
  const lostCount = problems.filter((p) => p.type === "LOST").length;

  // Group by category for display
  const categories = new Map<string, ChecklistItem[]>();
  if (state) {
    for (const item of state.items) {
      const cat = item.isExtra ? "Добавлено на месте" : item.category;
      if (!categories.has(cat)) categories.set(cat, []);
      categories.get(cat)!.push(item);
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-surface-2">
      {/* Header */}
      <div className="bg-surface border-b border-border px-4 py-3 flex items-center gap-3">
        <button onClick={onBack} className="text-2xl text-ink-2 leading-none w-10 h-10 flex items-center justify-center flex-shrink-0" aria-label="Назад">←</button>
        <div className="flex-1 min-w-0">
          <h2 className="text-[15px] font-semibold text-ink">Подтверждение {opLabel === "выдачу" ? "выдачи" : "возврата"}</h2>
          <div className="text-xs text-ink-3">{clientName}</div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto pb-32">
        {/* Total summary */}
        <div className="bg-surface border-b border-border px-4 py-3">
          <div className="text-xs text-ink-2 font-semibold uppercase tracking-wide mb-1">
            Готово к {opLabel === "выдачу" ? "выдаче" : "приёму"}
          </div>
          <div className="text-2xl font-bold text-emerald" style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}>
            {totalChecked} позиций
          </div>
          <div className="text-xs text-ink-3 mt-0.5">
            {totalUnitChecked > 0 && `${totalUnitChecked} штучных`}
            {totalUnitChecked > 0 && totalCountChecked > 0 && " + "}
            {totalCountChecked > 0 && `${totalCountChecked} шт. количественных`}
            {extraItems.length > 0 && ` · ${extraItems.length} добавлено на месте`}
          </div>
        </div>

        {error && (
          <div className="mx-4 mt-4 text-rose bg-rose-soft border border-rose-border rounded-xl px-4 py-3 text-sm">{error}</div>
        )}

        {/* Categories */}
        {[...categories.entries()].map(([cat, items]) => {
          const isExtraCat = cat === "Добавлено на месте";
          const catTotal = items.reduce((s, i) => {
            if (i.trackingMode === "UNIT") return s + (i.units?.filter((u) => u.checked).length ?? 0);
            return s + (countChecks.get(i.bookingItemId) ?? 0);
          }, 0);

          return (
            <div key={cat} className="bg-surface border-t border-border mt-2">
              <div className="flex justify-between items-baseline px-4 py-2">
                <span className={`text-xs font-semibold uppercase tracking-wide ${isExtraCat ? "text-teal" : "text-ink-2"}`}
                  style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}>
                  {cat} · {catTotal} шт.
                </span>
                <span className="text-[11px] text-emerald">✓</span>
              </div>

              {items.map((item) => {
                if (item.trackingMode === "UNIT" && item.units) {
                  return item.units
                    .filter((u) => u.checked || problems.some((p) => p.unitId === u.unitId))
                    .map((unit) => {
                      const prob = problems.find((p) => p.unitId === unit.unitId);
                      const displayBarcode = unit.barcode
                        ? unit.barcode.replace(/^LR-/i, "").substring(0, 10)
                        : null;
                      return (
                        <div key={unit.unitId} className={`flex items-center gap-2 px-4 py-2 border-t border-border min-h-0 ${
                          prob?.type === "BROKEN" ? "bg-rose-soft" : prob?.type === "LOST" ? "bg-amber-soft" : isExtraCat ? "bg-teal-soft" : ""
                        }`}>
                          <span className={`w-5 h-5 rounded flex items-center justify-center text-xs flex-shrink-0 ${
                            prob ? (prob.type === "BROKEN" ? "bg-rose-soft text-rose border border-rose-border" : "bg-amber-soft text-amber border border-amber-border") : "bg-accent-bright text-white"
                          }`}>
                            {prob ? "!" : "✓"}
                          </span>
                          <div className="flex-1 min-w-0">
                            <span className="text-[13px] text-ink">{item.equipmentName}</span>
                            {displayBarcode && (
                              <span className="ml-2 text-[10px] font-mono text-ink-3">{displayBarcode}</span>
                            )}
                          </div>
                          {prob && (
                            <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded-full ${
                              prob.type === "BROKEN" ? "bg-rose-soft text-rose" : "bg-amber-soft text-amber"
                            }`}>
                              {prob.type === "BROKEN" ? "ремонт" : "утеря"}
                            </span>
                          )}
                        </div>
                      );
                    });
                }

                const checked = countChecks.get(item.bookingItemId) ?? 0;
                if (checked === 0) return null;

                return (
                  <div key={item.bookingItemId} className={`flex items-center gap-2 px-4 py-2 border-t border-border ${isExtraCat ? "bg-teal-soft" : ""}`}>
                    <span className={`w-5 h-5 rounded flex items-center justify-center text-xs flex-shrink-0 ${isExtraCat ? "bg-teal text-white" : "bg-accent-bright text-white"}`}>✓</span>
                    <span className="text-[13px] text-ink flex-1">{item.equipmentName}</span>
                    <span className="text-xs font-mono text-ink-2">{checked} шт.</span>
                    {item.isExtra && (
                      <span className="text-[10px] font-semibold bg-teal-soft text-teal px-1.5 py-0.5 rounded-full">+ доп</span>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}

        {/* Problems summary */}
        {(brokenCount > 0 || lostCount > 0) && (
          <div className="bg-surface border-t border-border mt-2 px-4 py-3">
            <div className="text-xs font-semibold text-ink-2 uppercase tracking-wide mb-2">Проблемы</div>
            {problems.map((p) => (
              <div key={p.unitId} className={`flex items-center gap-2 py-1.5 text-[13px] ${p.type === "BROKEN" ? "text-rose" : "text-amber"}`}>
                <span>{p.type === "BROKEN" ? "🔧" : "⚠"}</span>
                <span className="flex-1">{p.unitName}</span>
                <span className="text-xs opacity-70">{p.type === "BROKEN" ? "ремонт" : "утеря"}</span>
              </div>
            ))}
          </div>
        )}

        <div className="h-8" />
      </div>

      {/* CTA */}
      <div className="fixed bottom-0 left-0 right-0 bg-surface border-t border-border px-4 py-3 pb-safe flex flex-col gap-2">
        <button
          onClick={handleComplete}
          disabled={completing}
          className="w-full py-[14px] bg-accent-bright text-white text-[15px] font-semibold rounded-xl disabled:opacity-50 transition-colors"
        >
          {completing ? "Подтверждение..." : `Подтвердить ${opLabel}`}
        </button>
        <button
          onClick={onBack}
          className="text-ink-2 text-[13px] text-center py-1.5"
        >
          ← Изменить список
        </button>
      </div>
    </div>
  );
}

// ── Main State Machine ────────────────────────────────────────────────────────────

type Step = "login" | "operation" | "booking" | "checklist" | "summary";

function WarehouseScanInner({ hasMainSession, workerName }: { hasMainSession: boolean; workerName: string }) {
  const router = useRouter();

  const [step, setStep] = useState<Step>(() => hasMainSession ? "operation" : "login");
  const [operation, setOperation] = useState<Operation>("ISSUE");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [bookingId, setBookingId] = useState<string | null>(null);
  const [clientName, setClientName] = useState("");
  const [countChecks, setCountChecks] = useState<Map<string, number>>(new Map());
  const [problems, setProblems] = useState<ProblemUnit[]>([]);
  const [paymentBookingId, setPaymentBookingId] = useState<string | null>(null);

  const goToLogin = useCallback(() => {
    sessionStorage.removeItem("warehouse_token");
    if (hasMainSession) {
      toast.error("Сессия истекла, войдите заново");
      router.push(`/login?from=${encodeURIComponent("/warehouse/scan")}`);
    } else {
      setStep("login");
    }
  }, [hasMainSession, router]);

  function handleLoginSuccess() {
    setStep("operation");
  }

  function handleOperationSelect(op: Operation) {
    setOperation(op);
    setStep("booking");
  }

  function handleBookingSelect(sid: string, bid: string, cname: string) {
    setSessionId(sid);
    setBookingId(bid);
    setClientName(cname);
    setStep("checklist");
  }

  function handleChecklistDone(checks: Map<string, number>, probs: ProblemUnit[]) {
    setCountChecks(checks);
    setProblems(probs);
    setStep("summary");
  }

  function handleSummaryComplete(bid?: string) {
    const n = problems.filter((p) => p.type === "BROKEN").length;
    if (n > 0) {
      toast.success(`Создано ${n} ${pluralRu(n, ["карточка", "карточки", "карточек"])} ремонта`);
    }
    setSessionId(null);
    setBookingId(null);
    setClientName("");
    setCountChecks(new Map());
    setProblems([]);
    setStep("operation");
    if (bid) setPaymentBookingId(bid);
  }

  return (
    <>
      {step === "login" && <LoginStep onSuccess={handleLoginSuccess} />}

      {step === "operation" && (
        <OperationStep onSelect={handleOperationSelect} workerName={workerName} />
      )}

      {step === "booking" && (
        <BookingStep
          operation={operation}
          onSelect={handleBookingSelect}
          onUnauth={goToLogin}
          onBack={() => setStep("operation")}
        />
      )}

      {step === "checklist" && sessionId && (
        <ChecklistStep
          sessionId={sessionId}
          operation={operation}
          clientName={clientName}
          onDone={handleChecklistDone}
          onBack={() => setStep("booking")}
          onUnauth={goToLogin}
        />
      )}

      {step === "summary" && sessionId && (
        <SummaryStep
          sessionId={sessionId}
          operation={operation}
          clientName={clientName}
          countChecks={countChecks}
          problems={problems}
          onComplete={handleSummaryComplete}
          onBack={() => setStep("checklist")}
          onUnauth={goToLogin}
        />
      )}

      <RecordPaymentModal
        open={paymentBookingId !== null}
        defaultBookingId={paymentBookingId ?? undefined}
        onClose={() => setPaymentBookingId(null)}
        onCreated={() => setPaymentBookingId(null)}
      />
    </>
  );
}

// ── Page Shell ────────────────────────────────────────────────────────────────────

export default function WarehouseScanPage() {
  const { user, loading } = useCurrentUser();

  if (loading) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <div className="text-ink-3 text-sm">Загрузка…</div>
      </div>
    );
  }

  const hasMainSession = user?.role === "SUPER_ADMIN" || user?.role === "WAREHOUSE";
  const workerName = user?.username ?? "Кладовщик";

  return <WarehouseScanInner hasMainSession={hasMainSession} workerName={workerName} />;
}
