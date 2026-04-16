"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, useParams } from "next/navigation";
import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { apiFetch } from "../../../src/lib/api";
import { formatRub } from "../../../src/lib/format";

// ── Типы ─────────────────────────────────────────────────────────────────────

type RepairStatus = "WAITING_REPAIR" | "IN_REPAIR" | "WAITING_PARTS" | "CLOSED" | "WROTE_OFF";
type RepairUrgency = "NOT_URGENT" | "NORMAL" | "URGENT";

interface WorkLogEntry {
  id: string;
  description: string;
  timeSpentHours: string;
  partCost: string;
  loggedBy: string;
  loggedAt: string;
}

interface RepairDetail {
  id: string;
  reason: string;
  urgency: RepairUrgency;
  status: RepairStatus;
  createdBy: string;
  assignedTo: string | null;
  partsCost: string;
  totalTimeHours: string;
  createdAt: string;
  closedAt: string | null;
  unit: {
    id: string;
    barcode: string | null;
    equipment: { name: string; category: string };
  };
  sourceBooking: {
    id: string;
    projectName: string;
    startDate: string;
    endDate: string;
    client: { name: string };
  } | null;
  workLog: WorkLogEntry[];
}

// ── Константы ─────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<RepairStatus, string> = {
  WAITING_REPAIR: "В очереди",
  IN_REPAIR:      "В работе",
  WAITING_PARTS:  "Ждёт запчасти",
  CLOSED:         "Закрыт",
  WROTE_OFF:      "Списан",
};

const STATUS_PILL_CLASSES: Record<RepairStatus, string> = {
  WAITING_REPAIR: "bg-rose-100 text-rose-700 border border-rose-200",
  IN_REPAIR:      "bg-amber-100 text-amber-700 border border-amber-200",
  WAITING_PARTS:  "bg-purple-100 text-purple-700 border border-purple-200",
  CLOSED:         "bg-emerald-100 text-emerald-700 border border-emerald-200",
  WROTE_OFF:      "bg-slate-100 text-slate-600 border border-slate-200",
};

const ALL_ROLES = ["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"] as const;

// ── Хелперы ───────────────────────────────────────────────────────────────────

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("ru-RU", {
    day: "2-digit", month: "2-digit", year: "numeric",
  });
}

// ── Модалка закрытия с расходом ──────────────────────────────────────────────

function CloseWithExpenseModal({
  repair,
  onConfirm,
  onSkip,
  onCancel,
}: {
  repair: RepairDetail;
  onConfirm: (createExpense: boolean, workValuation: number) => void;
  onSkip: () => void;
  onCancel: () => void;
}) {
  const HOURLY_RATE = 2000;
  const hours = parseFloat(repair.totalTimeHours) || 0;
  const parts = parseFloat(repair.partsCost) || 0;
  const defaultValuation = Math.round(hours * HOURLY_RATE);
  const [workVal, setWorkVal] = useState(String(defaultValuation));
  const [includeWork, setIncludeWork] = useState(defaultValuation > 0);

  const totalExpense = parts + (includeWork ? (parseFloat(workVal) || 0) : 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="bg-surface border border-border rounded-xl shadow-xl w-full max-w-md p-6 space-y-4">
        <h3 className="text-base font-semibold text-ink">Закрыть ремонт</h3>
        <p className="text-sm text-ink-2">
          Создать расход «Ремонт» на{" "}
          <span className="font-semibold text-ink">{formatRub(String(totalExpense))}</span>?
        </p>
        {parts > 0 && (
          <p className="text-xs text-ink-3">Запчасти: {formatRub(repair.partsCost)}</p>
        )}
        {hours > 0 && (
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="include-work"
              checked={includeWork}
              onChange={(e) => setIncludeWork(e.target.checked)}
              className="rounded border-border"
            />
            <label htmlFor="include-work" className="text-sm text-ink-2">
              Оценка работы:
            </label>
            <input
              type="number"
              min="0"
              value={workVal}
              onChange={(e) => setWorkVal(e.target.value)}
              disabled={!includeWork}
              className="w-24 px-2 py-1 border border-border rounded text-sm text-ink disabled:opacity-50"
            />
            <span className="text-xs text-ink-3">₽</span>
          </div>
        )}
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-ink-2 border border-border rounded-lg hover:bg-surface-2 transition-colors"
          >
            Отмена
          </button>
          <button
            onClick={() => onSkip()}
            className="px-4 py-2 text-sm text-ink-2 border border-border rounded-lg hover:bg-surface-2 transition-colors"
          >
            Закрыть без расхода
          </button>
          <button
            onClick={() => onConfirm(true, parseFloat(workVal) || 0)}
            className="px-4 py-2 text-sm font-medium text-white bg-accent rounded-lg hover:bg-accent-hover transition-colors"
          >
            Создать расход и закрыть
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Главная страница ──────────────────────────────────────────────────────────

export default function RepairDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const router = useRouter();

  const { user, loading: authLoading } = useRequireRole(ALL_ROLES as unknown as ("SUPER_ADMIN" | "WAREHOUSE" | "TECHNICIAN")[]);

  const [repair, setRepair] = useState<RepairDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [showWriteOffConfirm, setShowWriteOffConfirm] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Inline work log form state
  const [workDesc, setWorkDesc] = useState("");
  const [workHours, setWorkHours] = useState("");
  const [workPartCost, setWorkPartCost] = useState("");
  const [workLogSaving, setWorkLogSaving] = useState(false);
  const [workLogError, setWorkLogError] = useState<string | null>(null);

  const loadRepair = useCallback(() => {
    apiFetch<{ repair: RepairDetail }>(`/api/repairs/${id}`)
      .then((data) => setRepair(data.repair))
      .catch((err: any) => setError(err?.message ?? "Ошибка загрузки"))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    apiFetch<{ repair: RepairDetail }>(`/api/repairs/${id}`)
      .then((data) => { if (!cancelled) setRepair(data.repair); })
      .catch((err: any) => { if (!cancelled) setError(err?.message ?? "Ошибка загрузки"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [user, id]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  async function handleAction(fn: () => Promise<void>, successMsg: string) {
    setActionLoading(true);
    try {
      await fn();
      showToast(successMsg);
      await loadRepair();
    } catch (err: any) {
      showToast(err?.message ?? "Ошибка");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleTakeToWork() {
    await handleAction(async () => {
      await apiFetch(`/api/repairs/${id}/take`, { method: "POST" });
    }, "Ремонт взят в работу");
  }

  async function handleStatusChange(status: "IN_REPAIR" | "WAITING_PARTS") {
    await handleAction(async () => {
      await apiFetch(`/api/repairs/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
    }, status === "IN_REPAIR" ? "Снова в работе" : "Ожидание запчастей");
  }

  async function closeRepair(createExpense: boolean, workVal: number) {
    await handleAction(async () => {
      if (createExpense) {
        const parts = parseFloat(repair?.partsCost ?? "0") || 0;
        const amount = parts + workVal;
        if (amount > 0) {
          await apiFetch("/api/expenses", {
            method: "POST",
            body: JSON.stringify({
              date: new Date().toISOString(),
              category: "REPAIR",
              amount,
              description: `Ремонт ${repair?.unit.equipment.name ?? ""}`,
              linkedRepairId: id,
            }),
          });
        }
      }
      await apiFetch(`/api/repairs/${id}/close`, { method: "POST" });
    }, "Ремонт закрыт");
    setShowCloseModal(false);
  }

  async function handleWriteOff() {
    await handleAction(async () => {
      await apiFetch(`/api/repairs/${id}/write-off`, { method: "POST" });
    }, "Единица списана");
    setShowWriteOffConfirm(false);
  }

  async function handleAddWorkLog(e: React.FormEvent) {
    e.preventDefault();
    if (!workDesc.trim()) {
      setWorkLogError("Введите описание работ");
      return;
    }
    setWorkLogSaving(true);
    setWorkLogError(null);
    try {
      await apiFetch(`/api/repairs/${id}/work-log`, {
        method: "POST",
        body: JSON.stringify({
          description: workDesc.trim(),
          timeSpentHours: parseFloat(workHours) || 0,
          partCost: parseFloat(workPartCost) || 0,
        }),
      });
      setWorkDesc("");
      setWorkHours("");
      setWorkPartCost("");
      await loadRepair();
      showToast("Запись добавлена");
    } catch (err: any) {
      setWorkLogError(err?.message ?? "Ошибка сохранения");
    } finally {
      setWorkLogSaving(false);
    }
  }

  if (authLoading || !user) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[200px]">
        <span className="text-sm text-ink-3">Загрузка…</span>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-0">
        <div className="h-24 bg-slate-700 animate-pulse" />
        <div className="p-4 space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-20 bg-slate-100 rounded-lg animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (error || !repair) {
    return (
      <div className="p-6">
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-700">
          {error ?? "Ремонт не найден"}
        </div>
      </div>
    );
  }

  const role = user.role;
  const isSuperAdmin = role === "SUPER_ADMIN";
  const isTechnician = role === "TECHNICIAN";
  const isAssignedToMe = user.userId ? repair.assignedTo === user.userId : false;
  const isActive = !["CLOSED", "WROTE_OFF"].includes(repair.status);
  const hasWork = parseFloat(repair.partsCost) > 0 || parseFloat(repair.totalTimeHours) > 0;
  const canAddWorkLog = isActive && ((isTechnician && isAssignedToMe) || isSuperAdmin);

  return (
    <div className="min-h-screen bg-surface-2">
      {/* Тёмная шапка */}
      <div className="bg-[#0f172a] text-white px-4 py-4">
        <button
          onClick={() => router.push("/repair")}
          className="text-xs text-slate-400 hover:text-slate-200 transition-colors mb-3 block"
        >
          ← Мастерская
        </button>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-base font-semibold leading-tight">
              {repair.unit.equipment.name}
            </h1>
            {repair.unit.barcode && (
              <p className="text-xs text-slate-400 font-mono mt-0.5">{repair.unit.barcode}</p>
            )}
            <p className="text-xs text-slate-400 mt-1">
              Поломка №R-{repair.id.slice(-6)} · {repair.status === "WAITING_REPAIR" ? "поступила" : "взята в работу"} {formatDate(repair.createdAt)}
            </p>
          </div>
          <span className={`shrink-0 inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${STATUS_PILL_CLASSES[repair.status]}`}>
            {STATUS_LABELS[repair.status]}
          </span>
        </div>
      </div>

      {/* Тело страницы */}
      <div className="p-4 space-y-4 max-w-2xl">

        {/* Карточка: причина */}
        <div className="bg-surface border border-border rounded-lg p-4">
          <p className="eyebrow mb-2">Причина возврата</p>
          <p className="text-sm text-ink">
            <span className="font-medium">{repair.createdBy}</span>
            {", "}
            {formatDate(repair.createdAt)}
            {": «"}
            {repair.reason}
            {"»"}
          </p>
          {repair.sourceBooking && (role === "SUPER_ADMIN" || role === "WAREHOUSE") && (
            <div className="mt-2">
              <a
                href={`/bookings/${repair.sourceBooking.id}`}
                className="text-sm text-accent hover:underline"
              >
                {repair.sourceBooking.client.name} · {repair.sourceBooking.projectName}
              </a>
              <p className="text-xs text-ink-3 mt-0.5">
                {formatDate(repair.sourceBooking.startDate)} — {formatDate(repair.sourceBooking.endDate)}
              </p>
            </div>
          )}
        </div>

        {/* Карточка: история работ */}
        <div className="bg-surface border border-border rounded-lg p-4">
          <p className="eyebrow mb-3">История работ</p>

          {repair.workLog.length === 0 ? (
            <p className="text-xs text-ink-3 italic mb-3">+ добавьте запись о том, что сделали сегодня</p>
          ) : (
            <div className="space-y-0 mb-3">
              {repair.workLog.map((entry) => (
                <div key={entry.id} className="border-b border-border py-2.5 last:border-0">
                  <div className="flex gap-1.5 flex-wrap">
                    <span className="text-xs font-semibold text-ink mono-num">{formatDateTime(entry.loggedAt)} ·</span>
                    <span className="text-sm text-ink">{entry.description}</span>
                  </div>
                  <div className="flex gap-3 mt-1 text-xs text-ink-3">
                    {parseFloat(entry.timeSpentHours) > 0 && (
                      <span className="mono-num">{entry.timeSpentHours} ч</span>
                    )}
                    {parseFloat(entry.partCost) > 0 && (
                      <span className="mono-num">{formatRub(entry.partCost)}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Итого */}
          {hasWork && (
            <div className="flex gap-4 py-2 border-t border-border text-xs text-ink-3 mb-3">
              {parseFloat(repair.totalTimeHours) > 0 && (
                <span className="mono-num">Итого: {repair.totalTimeHours} ч</span>
              )}
              {parseFloat(repair.partsCost) > 0 && (
                <span className="mono-num">Запчасти: {formatRub(repair.partsCost)}</span>
              )}
            </div>
          )}

          {/* Инлайн-форма добавления записи */}
          {canAddWorkLog && (
            <form onSubmit={handleAddWorkLog} className="space-y-2 mt-2">
              <textarea
                value={workDesc}
                onChange={(e) => setWorkDesc(e.target.value)}
                placeholder="Что сделали, что выяснили, какие запчасти нужны…"
                style={{ height: "50px" }}
                className="w-full px-3 py-2 border border-border rounded-lg text-sm text-ink focus:outline-none focus:ring-1 focus:ring-accent resize-none"
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={workHours}
                  onChange={(e) => setWorkHours(e.target.value)}
                  placeholder="Часы работ"
                  className="px-3 py-2 border border-border rounded-lg text-sm text-ink focus:outline-none focus:ring-1 focus:ring-accent"
                />
                <input
                  type="number"
                  min="0"
                  value={workPartCost}
                  onChange={(e) => setWorkPartCost(e.target.value)}
                  placeholder="Расходы ₽"
                  className="px-3 py-2 border border-border rounded-lg text-sm text-ink focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
              {workLogError && (
                <p className="text-xs text-rose-600">{workLogError}</p>
              )}
              <button
                type="submit"
                disabled={workLogSaving}
                className="w-full h-9 border border-border text-ink-2 text-sm rounded-lg hover:bg-surface-2 disabled:opacity-50 transition-colors"
              >
                {workLogSaving ? "Сохранение…" : "+ Добавить запись"}
              </button>
            </form>
          )}
        </div>

        {/* Карточка: затраты (только если есть данные) */}
        {hasWork && (
          <div className="bg-surface border border-border rounded-lg p-4">
            <p className="eyebrow mb-2">Затраты (необязательно)</p>
            <div className="space-y-1 text-sm text-ink-2">
              {parseFloat(repair.totalTimeHours) > 0 && (
                <div className="flex justify-between">
                  <span>Часов работ</span>
                  <span className="mono-num text-ink">{repair.totalTimeHours} ч</span>
                </div>
              )}
              {parseFloat(repair.partsCost) > 0 && (
                <div className="flex justify-between">
                  <span>Стоимость запчастей</span>
                  <span className="mono-num text-ink">{formatRub(repair.partsCost)}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Кнопки действий — горизонтально */}
        {isActive && (
          <div className="flex gap-2 flex-wrap">
            {/* TECHNICIAN unassigned → взять в работу */}
            {isTechnician && !repair.assignedTo && (
              <button
                onClick={handleTakeToWork}
                disabled={actionLoading}
                className="flex-1 min-w-[140px] h-11 bg-accent text-white text-sm font-medium rounded-lg hover:bg-accent-hover disabled:opacity-50 transition-colors"
              >
                Взять в работу
              </button>
            )}

            {/* Починил — закрыть */}
            {((isTechnician && isAssignedToMe) || isSuperAdmin) && (
              <button
                onClick={() => hasWork ? setShowCloseModal(true) : closeRepair(false, 0)}
                disabled={actionLoading}
                className="flex-1 min-w-[160px] h-11 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors"
              >
                ✓ Починил — вернуть в парк
              </button>
            )}

            {/* Пауза — ждём запчасти */}
            {((isTechnician && isAssignedToMe) || isSuperAdmin) && repair.status === "IN_REPAIR" && (
              <button
                onClick={() => handleStatusChange("WAITING_PARTS")}
                disabled={actionLoading}
                className="flex-1 min-w-[160px] h-11 border border-purple-300 text-purple-700 text-sm font-medium rounded-lg hover:bg-purple-50 disabled:opacity-50 transition-colors"
              >
                ⏸ Пауза — ждём запчасти
              </button>
            )}

            {/* Снова в работу */}
            {((isTechnician && isAssignedToMe) || isSuperAdmin) && repair.status === "WAITING_PARTS" && (
              <button
                onClick={() => handleStatusChange("IN_REPAIR")}
                disabled={actionLoading}
                className="flex-1 min-w-[140px] h-11 border border-border text-ink text-sm font-medium rounded-lg hover:bg-surface-2 disabled:opacity-50 transition-colors"
              >
                Снова в работу
              </button>
            )}

            {/* Списать — только SUPER_ADMIN */}
            {isSuperAdmin && (
              <button
                onClick={() => setShowWriteOffConfirm(true)}
                disabled={actionLoading}
                className="flex-1 min-w-[160px] h-11 border border-rose-300 text-rose-700 text-sm font-medium rounded-lg hover:bg-rose-50 disabled:opacity-50 transition-colors"
              >
                ✗ Не чинится — списать
              </button>
            )}
          </div>
        )}

        {/* Дата создания */}
        <p className="text-xs text-ink-3 pb-4">
          Создан: {formatDateTime(repair.createdAt)}
          {repair.closedAt && ` · Закрыт: ${formatDateTime(repair.closedAt)}`}
        </p>
      </div>

      {/* Модалка закрытия с расходом */}
      {showCloseModal && (
        <CloseWithExpenseModal
          repair={repair}
          onConfirm={closeRepair}
          onSkip={() => { closeRepair(false, 0); setShowCloseModal(false); }}
          onCancel={() => setShowCloseModal(false)}
        />
      )}

      {/* Модалка подтверждения списания */}
      {showWriteOffConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-surface border border-border rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h3 className="text-base font-semibold text-ink">Списать единицу?</h3>
            <p className="text-sm text-ink-2">
              Единица {repair.unit.equipment.name} будет переведена в статус «Списано».
              Это действие необратимо.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowWriteOffConfirm(false)}
                className="flex-1 h-11 border border-border text-ink-2 text-sm rounded-lg hover:bg-surface-2 transition-colors"
              >
                Отмена
              </button>
              <button
                onClick={handleWriteOff}
                disabled={actionLoading}
                className="flex-1 h-11 bg-rose text-white text-sm font-medium rounded-lg hover:opacity-90 disabled:opacity-50 transition-colors"
              >
                Списать
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl bg-ink text-surface text-sm font-medium shadow-lg max-w-xs w-full text-center">
          {toast}
        </div>
      )}
    </div>
  );
}
