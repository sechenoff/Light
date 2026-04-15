"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, useParams } from "next/navigation";
import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { useCurrentUser } from "../../../src/hooks/useCurrentUser";
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

const URGENCY_LABELS: Record<RepairUrgency, string> = {
  URGENT:     "Срочно",
  NORMAL:     "Обычно",
  NOT_URGENT: "Не срочно",
};

const URGENCY_CLASSES: Record<RepairUrgency, string> = {
  URGENT:     "bg-rose-100 text-rose-700 border border-rose-200",
  NORMAL:     "bg-amber-100 text-amber-700 border border-amber-200",
  NOT_URGENT: "bg-slate-100 text-slate-600 border border-slate-200",
};

const STATUS_LABELS: Record<RepairStatus, string> = {
  WAITING_REPAIR: "В очереди",
  IN_REPAIR:      "В работе",
  WAITING_PARTS:  "Ждёт запчасти",
  CLOSED:         "Закрыт",
  WROTE_OFF:      "Списан",
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

// ── Модалка добавления записи работ ─────────────────────────────────────────

function WorkLogModal({
  repairId,
  onClose,
  onAdded,
}: {
  repairId: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [description, setDescription] = useState("");
  const [hours, setHours] = useState("");
  const [partCost, setPartCost] = useState("0");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!description.trim()) {
      setError("Введите описание работ");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/api/repairs/${repairId}/work-log`, {
        method: "POST",
        body: JSON.stringify({
          description: description.trim(),
          timeSpentHours: parseFloat(hours) || 0,
          partCost: parseFloat(partCost) || 0,
        }),
      });
      onAdded();
      onClose();
    } catch (err: any) {
      setError(err?.message ?? "Ошибка сохранения");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="bg-surface border border-border rounded-xl shadow-xl w-full max-w-md p-6 space-y-4">
        <h3 className="text-base font-semibold text-ink">Добавить запись работ</h3>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Описание работ</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 border border-border rounded-lg text-sm text-ink focus:outline-none focus:ring-1 focus:ring-accent"
              placeholder="Что сделано..."
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">Часы работ</label>
              <input
                type="number"
                min="0"
                step="0.5"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                className="w-full px-3 py-2 border border-border rounded-lg text-sm text-ink focus:outline-none focus:ring-1 focus:ring-accent"
                placeholder="0"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">Стоимость запчастей (₽)</label>
              <input
                type="number"
                min="0"
                value={partCost}
                onChange={(e) => setPartCost(e.target.value)}
                className="w-full px-3 py-2 border border-border rounded-lg text-sm text-ink focus:outline-none focus:ring-1 focus:ring-accent"
                placeholder="0"
              />
            </div>
          </div>
          {error && (
            <p className="text-xs text-rose-600">{error}</p>
          )}
          <div className="flex gap-3 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-ink-2 border border-border rounded-lg hover:bg-surface-2 transition-colors"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-white bg-accent rounded-lg hover:bg-accent-hover disabled:opacity-50 transition-colors"
            >
              {saving ? "Сохранение…" : "Сохранить"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
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
  const [showWorkLog, setShowWorkLog] = useState(false);
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [showWriteOffConfirm, setShowWriteOffConfirm] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const loadRepair = useCallback(async () => {
    try {
      const data = await apiFetch<{ repair: RepairDetail }>(`/api/repairs/${id}`);
      setRepair(data.repair);
    } catch (err: any) {
      setError(err?.message ?? "Ошибка загрузки");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (user) loadRepair();
  }, [user, loadRepair]);

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

  if (authLoading || !user) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[200px]">
        <span className="text-sm text-ink-3">Загрузка…</span>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-16 bg-slate-100 rounded-lg animate-pulse" />
        ))}
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
  const isWarehouse = role === "WAREHOUSE";
  const isAssignedToMe = user.userId ? repair.assignedTo === user.userId : false;
  const isActive = !["CLOSED", "WROTE_OFF"].includes(repair.status);
  const hasWork = parseFloat(repair.partsCost) > 0 || parseFloat(repair.totalTimeHours) > 0;

  return (
    <div className="p-4 md:p-6 max-w-2xl space-y-6">
      {/* Назад */}
      <button
        onClick={() => router.push("/repair")}
        className="text-sm text-ink-2 hover:text-ink transition-colors"
      >
        ← Мастерская
      </button>

      {/* Заголовок */}
      <div className="space-y-1">
        <p className="eyebrow">Ремонт #{repair.id.slice(-6)}</p>
        <h1 className="text-lg font-semibold text-ink">{repair.unit.equipment.name}</h1>
        <p className="text-xs text-ink-3">{repair.unit.equipment.category}</p>
        {repair.unit.barcode && (
          <p className="mono-num text-xs text-ink-3">{repair.unit.barcode}</p>
        )}
      </div>

      {/* Статус + urgency */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-sm font-medium text-ink">{STATUS_LABELS[repair.status]}</span>
        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${URGENCY_CLASSES[repair.urgency]}`}>
          {URGENCY_LABELS[repair.urgency]}
        </span>
      </div>

      {/* Причина */}
      <div className="bg-surface border border-border rounded-lg p-4">
        <p className="eyebrow mb-1">Причина</p>
        <p className="text-sm text-ink">{repair.reason}</p>
      </div>

      {/* Источник брони — только для ролей с доступом к броням */}
      {repair.sourceBooking && (user?.role === "SUPER_ADMIN" || user?.role === "WAREHOUSE") && (
        <div className="bg-surface border border-border rounded-lg p-4">
          <p className="eyebrow mb-1">Источник</p>
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

      {/* Журнал работ */}
      <div className="bg-surface border border-border rounded-lg p-4 space-y-3">
        <p className="eyebrow">Журнал работ</p>
        {repair.workLog.length === 0 ? (
          <p className="text-xs text-ink-3 italic">Записей нет</p>
        ) : (
          <div className="space-y-3">
            {repair.workLog.map((entry) => (
              <div key={entry.id} className="border-b border-border pb-3 last:border-0 last:pb-0">
                <p className="text-sm text-ink">{entry.description}</p>
                <div className="flex gap-3 mt-1 text-xs text-ink-3">
                  <span className="mono-num">{entry.timeSpentHours} ч</span>
                  {parseFloat(entry.partCost) > 0 && (
                    <span className="mono-num">{formatRub(entry.partCost)}</span>
                  )}
                  <span>{formatDateTime(entry.loggedAt)}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Итого */}
        {(parseFloat(repair.totalTimeHours) > 0 || parseFloat(repair.partsCost) > 0) && (
          <div className="flex gap-4 pt-2 border-t border-border text-sm">
            {parseFloat(repair.totalTimeHours) > 0 && (
              <span className="mono-num text-ink-2">Итого: {repair.totalTimeHours} ч</span>
            )}
            {parseFloat(repair.partsCost) > 0 && (
              <span className="mono-num text-ink-2">Запчасти: {formatRub(repair.partsCost)}</span>
            )}
          </div>
        )}
      </div>

      {/* Кнопки действий */}
      {isActive && (
        <div className="space-y-2">
          {/* TECHNICIAN unassigned → взять в работу */}
          {isTechnician && !repair.assignedTo && (
            <button
              onClick={handleTakeToWork}
              disabled={actionLoading}
              className="w-full h-11 bg-accent text-white text-sm font-medium rounded-lg hover:bg-accent-hover disabled:opacity-50 transition-colors"
            >
              Взять в работу
            </button>
          )}

          {/* TECHNICIAN assigned: action buttons */}
          {(isTechnician && isAssignedToMe) || isSuperAdmin ? (
            <>
              <button
                onClick={() => setShowWorkLog(true)}
                disabled={actionLoading}
                className="w-full h-11 border border-border text-ink text-sm font-medium rounded-lg hover:bg-surface-2 disabled:opacity-50 transition-colors"
              >
                Добавить запись работ
              </button>

              {repair.status === "IN_REPAIR" && (
                <button
                  onClick={() => handleStatusChange("WAITING_PARTS")}
                  disabled={actionLoading}
                  className="w-full h-11 border border-amber-200 text-amber-700 text-sm font-medium rounded-lg hover:bg-amber-50 disabled:opacity-50 transition-colors"
                >
                  Жду запчасти
                </button>
              )}

              {repair.status === "WAITING_PARTS" && (
                <button
                  onClick={() => handleStatusChange("IN_REPAIR")}
                  disabled={actionLoading}
                  className="w-full h-11 border border-border text-ink text-sm font-medium rounded-lg hover:bg-surface-2 disabled:opacity-50 transition-colors"
                >
                  Снова в работу
                </button>
              )}

              <button
                onClick={() => hasWork ? setShowCloseModal(true) : closeRepair(false, 0)}
                disabled={actionLoading}
                className="w-full h-11 bg-ok text-white text-sm font-medium rounded-lg hover:opacity-90 disabled:opacity-50 transition-colors"
              >
                Закрыть ремонт
              </button>
            </>
          ) : null}

          {/* SUPER_ADMIN — списать */}
          {isSuperAdmin && (
            <button
              onClick={() => setShowWriteOffConfirm(true)}
              disabled={actionLoading}
              className="w-full h-11 bg-rose text-white text-sm font-medium rounded-lg hover:opacity-90 disabled:opacity-50 transition-colors"
            >
              Списать единицу
            </button>
          )}
        </div>
      )}

      {/* Дата создания */}
      <p className="text-xs text-ink-3">
        Создан: {formatDateTime(repair.createdAt)}
        {repair.closedAt && ` · Закрыт: ${formatDateTime(repair.closedAt)}`}
      </p>

      {/* Модалки */}
      {showWorkLog && (
        <WorkLogModal
          repairId={id}
          onClose={() => setShowWorkLog(false)}
          onAdded={loadRepair}
        />
      )}

      {showCloseModal && (
        <CloseWithExpenseModal
          repair={repair}
          onConfirm={closeRepair}
          onSkip={() => { closeRepair(false, 0); setShowCloseModal(false); }}
          onCancel={() => setShowCloseModal(false)}
        />
      )}

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
