"use client";

/**
 * Карточка ремонта.
 *
 * Порядок блоков задан одним вопросом: чинить или искать замену. Поэтому риск
 * стоит выше всего остального — даже выше причины поломки. Слева контекст и
 * работа (что видел кладовщик, что делал техник), справа сроки, история
 * позиции и деньги.
 *
 * Роли: техник чинит и не видит ни сумм, ни списания; руководитель видит всё;
 * кладовщик не чинит, но именно он ищет подмену и ждёт прибор обратно —
 * раньше карточка была для него тупиком, теперь у него есть свои действия.
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";

import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { apiFetch } from "../../../src/lib/api";
import { formatRub } from "../../../src/lib/format";
import { toMoscowDateString } from "../../../src/lib/moscowDate";
import { toast } from "../../../src/components/ToastProvider";
import {
  BTN_MINI,
  BTN_MINI_ROSE,
  BTN_OK,
  BTN_PRIMARY,
  CARD,
  CARD_ZONE,
  daysText,
} from "../../../src/components/repair/cardChrome";
import {
  QuantityTag,
  RepairIcon,
  RepairRiskBadge,
  RepairStatusPill,
  TitleSourceTag,
  UrgencyPill,
} from "../../../src/components/repair/RepairRiskBadge";
import {
  RepairPhotoStrip,
  photoStripCaption,
  type RepairPhoto,
} from "../../../src/components/repair/RepairPhotoStrip";
import {
  RepairHistoryBlock,
  type RepairHistory,
} from "../../../src/components/repair/RepairHistoryBlock";
import {
  RepairEtaCard,
  type EtaPatch,
} from "../../../src/components/repair/RepairEtaCard";
import {
  RepairCloseModal,
  REPAIR_HOURLY_RATE,
} from "../../../src/components/repair/RepairCloseModal";
import {
  WorkLogComposer,
  WorkLogList,
  workLogSummary,
  type RepairWorkLogEntry,
  type WorkLogDraft,
} from "../../../src/components/repair/WorkLogComposer";
import {
  QUIET_DAYS,
  daysAgo,
  formatDayMonth,
  isQuiet,
  lastActivityAt,
  type RepairListItem,
} from "../../../src/components/repair/types";

// ── Типы ─────────────────────────────────────────────────────────────────────

/** Ответ `GET /api/repairs/:id` — строка списка плюс то, что есть только в деталях. */
type RepairDetail = RepairListItem & {
  workLog: RepairWorkLogEntry[];
  photos: RepairPhoto[];
  history: RepairHistory;
};

// ── Константы ────────────────────────────────────────────────────────────────

const ALL_ROLES = ["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"] as const;
const CLOSED_STATUSES = ["CLOSED", "WROTE_OFF"];

// ── Хелперы ──────────────────────────────────────────────────────────────────

/** «5 августа» — для строки «заведён …». */
function formatLongDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    timeZone: "Europe/Moscow",
  });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  });
}

/** Сколько прибор уже лежит в мастерской. Точная дата стоит выше, в надстрочнике. */
function ageText(repair: RepairDetail): string {
  const d = daysAgo(repair.createdAt);
  if (d <= 0) return "поступил сегодня";
  if (d === 1) return "в мастерской со вчера";
  return `в мастерской ${daysText(d)}`;
}

function activityText(repair: RepairDetail): string {
  if (repair.workLogCount === 0) return "записей ещё нет";
  const d = daysAgo(lastActivityAt(repair));
  if (d <= 0) return "последняя запись сегодня";
  if (d === 1) return "последняя запись вчера";
  return `последняя запись ${daysText(d)} назад`;
}

// ── Страница ─────────────────────────────────────────────────────────────────

export default function RepairDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const router = useRouter();
  const searchParams = useSearchParams();
  // dd-08 / repair-action-param-dead: ?action=take|write-off с /day должен сразу
  // запустить действие, а не открывать просто карточку. Флаг — чтобы сработало 1 раз.
  const actionHandledRef = useRef(false);

  const { user, loading: authLoading } = useRequireRole(
    ALL_ROLES as unknown as ("SUPER_ADMIN" | "WAREHOUSE" | "TECHNICIAN")[],
  );

  const [repair, setRepair] = useState<RepairDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [showWriteOffConfirm, setShowWriteOffConfirm] = useState(false);

  const loadRepair = useCallback(async () => {
    const data = await apiFetch<{ repair: RepairDetail }>(`/api/repairs/${id}`);
    setRepair(data.repair);
  }, [id]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    apiFetch<{ repair: RepairDetail }>(`/api/repairs/${id}`)
      .then((data) => {
        if (!cancelled) setRepair(data.repair);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Ошибка загрузки");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user, id]);

  const handleAction = useCallback(
    async (fn: () => Promise<void>, successMsg: string) => {
      setActionLoading(true);
      try {
        await fn();
        toast.success(successMsg);
        await loadRepair();
      } catch (err: unknown) {
        toast.error(err instanceof Error ? err.message : "Не удалось выполнить действие");
      } finally {
        setActionLoading(false);
      }
    },
    [loadRepair],
  );

  const handleTakeToWork = useCallback(async () => {
    await handleAction(async () => {
      await apiFetch(`/api/repairs/${id}/take`, { method: "POST" });
    }, "Ремонт взят в работу");
  }, [handleAction, id]);

  // dd-08: после загрузки ремонта применяем ?action один раз и чистим query.
  useEffect(() => {
    if (!repair || actionHandledRef.current) return;
    const action = searchParams.get("action");
    if (!action) return;
    actionHandledRef.current = true;
    const isActiveRepair = !CLOSED_STATUSES.includes(repair.status);
    if (
      action === "take" &&
      repair.status === "WAITING_REPAIR" &&
      (user?.role === "SUPER_ADMIN" || user?.role === "TECHNICIAN")
    ) {
      void handleTakeToWork();
    } else if (
      action === "write-off" &&
      user?.role === "SUPER_ADMIN" &&
      isActiveRepair &&
      repair.unit
    ) {
      setShowWriteOffConfirm(true);
    }
    router.replace(`/repair/${id}`);
  }, [repair, searchParams, user, id, router, handleTakeToWork]);

  async function handleStatusChange(status: "IN_REPAIR" | "WAITING_PARTS") {
    await handleAction(
      async () => {
        await apiFetch(`/api/repairs/${id}/status`, {
          method: "PATCH",
          body: JSON.stringify({ status }),
        });
      },
      status === "IN_REPAIR" ? "Снова в работе" : "Ждём запчасти",
    );
  }

  async function closeRepair(workValuation: number) {
    await handleAction(async () => {
      // Расход и закрытие — ОДИН запрос: бэкенд создаёт расход в той же
      // транзакции, что и close. При ошибке ничего не записано — повтор не
      // создаёт расход-дубль.
      const parts = parseFloat(repair?.partsCost ?? "0") || 0;
      const amount = parts + workValuation;
      const body =
        amount > 0
          ? { expense: { amount, description: `Ремонт ${repair?.title ?? ""}`.trim() } }
          : {};
      await apiFetch(`/api/repairs/${id}/close`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    }, "Ремонт закрыт, единица вернулась в парк");
    setShowCloseModal(false);
  }

  async function handleWriteOff() {
    await handleAction(async () => {
      await apiFetch(`/api/repairs/${id}/write-off`, { method: "POST" });
    }, "Единица списана");
    setShowWriteOffConfirm(false);
  }

  async function handleAddWorkLog(draft: WorkLogDraft) {
    await apiFetch(`/api/repairs/${id}/work-log`, {
      method: "POST",
      body: JSON.stringify(draft),
    });
    await loadRepair();
    toast.success("Запись добавлена");
  }

  async function handleEtaPatch(patch: EtaPatch) {
    try {
      // Сервер возвращает карточку с ПЕРЕСЧИТАННЫМ риском: «срывает бронь»
      // превращается в «успеваем, запас 4 дня» ровно в этот момент.
      const data = await apiFetch<{ repair: RepairDetail }>(`/api/repairs/${id}/eta`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      // Ответ /eta — карточка списка: в ней нет ни журнала, ни фото, ни
      // истории. Переносим их из текущего состояния явно, чтобы случайное
      // изменение серверного сериализатора не стёрло полстраницы.
      setRepair((prev) =>
        prev
          ? {
              ...prev,
              ...data.repair,
              workLog: prev.workLog,
              photos: prev.photos,
              history: prev.history,
            }
          : prev,
      );
      toast.success(patch.expectedReadyAt === null ? "Срок снят" : "Срок сохранён");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Не удалось сохранить срок");
      throw err;
    }
  }

  if (authLoading || !user) {
    return (
      <div className="flex min-h-[200px] items-center justify-center p-6">
        <span className="text-sm text-ink-3">Загрузка…</span>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-3 p-4 lg:p-6">
        <div className="h-16 animate-pulse rounded-lg bg-surface-muted" />
        <div className="h-10 animate-pulse rounded-lg bg-surface-muted" />
        <div className="grid gap-3.5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          <div className="h-64 animate-pulse rounded-lg bg-surface-muted" />
          <div className="h-64 animate-pulse rounded-lg bg-surface-muted" />
        </div>
      </div>
    );
  }

  if (error || !repair) {
    return (
      <div className="p-4 lg:p-6">
        <div className="rounded-lg border border-rose-border bg-rose-soft px-4 py-3 text-sm text-rose">
          {error ?? "Ремонт не найден"}
        </div>
      </div>
    );
  }

  // ── Роли ───────────────────────────────────────────────────────────────────
  const role = user.role;
  const isSuperAdmin = role === "SUPER_ADMIN";
  const isTechnician = role === "TECHNICIAN";
  const isWarehouse = role === "WAREHOUSE";
  const isAssignedToMe = user.userId ? repair.assignedTo === user.userId : false;
  const isActive = !CLOSED_STATUSES.includes(repair.status);
  const unclaimed = repair.status === "WAITING_REPAIR" && repair.assignedTo === null;

  /** Деньги — только руководителю. У техника и кладовщика сумм на экране нет. */
  const showMoney = isSuperAdmin;
  /** Писать в журнал: ничейную карточку любой техник берёт первой же записью. */
  const canWork = isActive && (isSuperAdmin || (isTechnician && (isAssignedToMe || unclaimed)));
  /** Закрывать и ставить на паузу — только тому, кто карточку уже держит. */
  const canFinish = isActive && (isSuperAdmin || (isTechnician && isAssignedToMe));
  const canSetEta = isActive && (isSuperAdmin || isTechnician);
  const canWriteOff = isActive && isSuperAdmin && repair.unit !== null;
  const canSeeBooking = isSuperAdmin || isWarehouse;

  const swapHref = repair.risk.booking
    ? `/calendar?date=${toMoscowDateString(new Date(repair.risk.booking.startDate))}`
    : null;
  const riskPressing = repair.risk.level === "BLOCKS" || repair.risk.level === "TIGHT";

  const quiet = isActive && isQuiet(repair);

  const roleHint = isSuperAdmin
    ? "Списание необратимо: единица уходит из парка навсегда."
    : isTechnician
      ? "Списывает руководитель — этой кнопки и сумм на экране у вас нет."
      : "Ремонт ведёт техник. Ваше отсюда — подобрать подмену и следить за сроком.";

  return (
    <div className="p-4 lg:p-6">
      <Link
        href="/repair"
        className="text-xs font-semibold text-accent-bright hover:text-accent hover:underline"
      >
        ← Мастерская
      </Link>

      {/* ── Шапка ── */}
      <header className="mt-2.5 flex flex-wrap items-start justify-between gap-5 border-b border-border pb-3">
        <div className="min-w-0">
          <p className="eyebrow">
            Ремонт · заведён {formatLongDate(repair.createdAt)}
            {repair.sourceBooking && canSeeBooking
              ? ` с приёмки «${repair.sourceBooking.projectName}»`
              : ""}
          </p>
          <h1 className="mt-0.5 font-cond text-[27px] font-bold leading-[1.15] tracking-[-0.012em]">
            {repair.title}
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
            <RepairStatusPill status={repair.status} />
            <UrgencyPill urgency={repair.urgency} />
            <QuantityTag quantity={repair.quantity} />
            <TitleSourceTag source={repair.titleSource} />
            <span className="text-border-strong">·</span>
            {repair.assignedToName ? (
              <span className="inline-flex items-center gap-1">
                чинит <b className="font-semibold text-ink">{repair.assignedToName}</b>
              </span>
            ) : (
              <span className="text-ink-3">исполнитель не назначен</span>
            )}
            <span className="text-border-strong">·</span>
            <span>{ageText(repair)}</span>
            <span className="text-border-strong">·</span>
            <span className={quiet ? "font-semibold text-amber" : ""}>{activityText(repair)}</span>
          </div>
        </div>

        <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto lg:max-w-[520px] lg:justify-end">
          {canFinish && (
            <button
              type="button"
              onClick={() => setShowCloseModal(true)}
              disabled={actionLoading}
              className={BTN_OK}
            >
              <RepairIcon name="check" />
              Починил — вернуть в парк
            </button>
          )}
          {canFinish && repair.status === "IN_REPAIR" && (
            <button
              type="button"
              onClick={() => handleStatusChange("WAITING_PARTS")}
              disabled={actionLoading}
              className={BTN_MINI}
            >
              <RepairIcon name="pause" />
              Пауза — нужна запчасть
            </button>
          )}
          {canFinish && repair.status === "WAITING_PARTS" && (
            <button
              type="button"
              onClick={() => handleStatusChange("IN_REPAIR")}
              disabled={actionLoading}
              className={BTN_MINI}
            >
              <RepairIcon name="wrench" />
              Снова в работу
            </button>
          )}
          {isActive && isTechnician && unclaimed && (
            <button
              type="button"
              onClick={handleTakeToWork}
              disabled={actionLoading}
              className={BTN_PRIMARY}
            >
              <RepairIcon name="user" />
              Взять в работу
            </button>
          )}
          {/* Кладовщик не чинит — но именно он ищет подмену. Раньше карточка
              не давала ему ни одного действия. */}
          {isWarehouse && swapHref && (
            <Link href={swapHref} className={BTN_PRIMARY}>
              <RepairIcon name="box" />
              Подобрать подмену
            </Link>
          )}
          {canSeeBooking && repair.sourceBooking && (
            <Link href={`/bookings/${repair.sourceBooking.id}`} className={BTN_MINI}>
              Бронь приёмки
            </Link>
          )}
          {canWriteOff && (
            <button
              type="button"
              onClick={() => setShowWriteOffConfirm(true)}
              disabled={actionLoading}
              className={BTN_MINI_ROSE}
            >
              <RepairIcon name="x" />
              Не чинится — списать
            </button>
          )}
          <p className="basis-full text-[11px] leading-[1.45] text-ink-3 lg:text-right">
            {roleHint}
          </p>
        </div>
      </header>

      {/* ── Риск: он определяет, чинить или искать замену ── */}
      <div className="mt-3.5">
        <RepairRiskBadge repair={repair} />
        {riskPressing && swapHref && (
          <p className="mt-1 text-right">
            <Link
              href={swapHref}
              className="text-[11.5px] font-semibold text-rose underline hover:no-underline"
            >
              Подобрать замену на {formatDayMonth(repair.risk.booking!.startDate)} →
            </Link>
          </p>
        )}
      </div>

      <div className="mt-3.5 grid items-start gap-3.5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        {/* ── Левая колонка ── */}
        <div className="flex min-w-0 flex-col gap-3.5">
          {/* Что видел кладовщик на приёмке */}
          <section className={CARD}>
            <div className={CARD_ZONE}>
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <span className="eyebrow inline-flex items-center gap-1.5">
                  <RepairIcon name="cam" />
                  Что видел кладовщик на приёмке
                </span>
                {repair.photos.length > 0 && (
                  <span className="ml-auto text-[11px] text-ink-3">
                    {photoStripCaption(repair.photos.length, repair.createdAt, repair.createdByName)}
                  </span>
                )}
              </div>
              <p className="mb-2 text-[13px] leading-[1.5] text-ink">«{repair.reason}»</p>
              <RepairPhotoStrip photos={repair.photos} />
              {repair.sourceBooking && canSeeBooking && (
                <p className="mt-1.5 text-[11px] text-ink-3">
                  Приехал с брони{" "}
                  <Link
                    href={`/bookings/${repair.sourceBooking.id}`}
                    className="font-semibold text-accent-bright hover:underline"
                  >
                    {repair.sourceBooking.client.name} · {repair.sourceBooking.projectName}
                  </Link>{" "}
                  ({formatDayMonth(repair.sourceBooking.startDate)} —{" "}
                  {formatDayMonth(repair.sourceBooking.endDate)})
                </p>
              )}
            </div>
          </section>

          {/* Журнал работ */}
          <section className={CARD}>
            <div className={CARD_ZONE}>
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <span className="eyebrow inline-flex items-center gap-1.5">
                  <RepairIcon name="wrench" />
                  Журнал работ
                </span>
                <span className="ml-auto text-[11px] text-ink-3">
                  {workLogSummary(
                    repair.workLog.length,
                    repair.totalTimeHours,
                    repair.partsCost,
                    showMoney,
                  )}
                </span>
              </div>

              <WorkLogList entries={repair.workLog} showMoney={showMoney} />

              {/* Директива вместо констатации: молчание видно и без нас, а вот
                  что с ним делать — нет. */}
              {quiet && repair.risk.booking && (
                <p className="mt-2 flex items-start gap-1.5 rounded border border-amber-border bg-amber-soft px-2.5 py-1.5 text-xs leading-[1.45] text-amber">
                  <RepairIcon name="clock" className="mt-0.5" />
                  <span>
                    Молчит {daysText(daysAgo(lastActivityAt(repair)))}, а бронь{" "}
                    {formatDayMonth(repair.risk.booking.startDate)}. Напишите, что происходит —
                    иначе о срыве узнают последними.
                  </span>
                </p>
              )}
              {quiet && !repair.risk.booking && (
                <p className="mt-2 flex items-start gap-1.5 rounded border border-amber-border bg-amber-soft px-2.5 py-1.5 text-xs leading-[1.45] text-amber">
                  <RepairIcon name="clock" className="mt-0.5" />
                  <span>
                    Ни одной записи {QUIET_DAYS}+ дней. Со стороны это выглядит как «про ремонт
                    забыли».
                  </span>
                </p>
              )}

              {canWork ? (
                <WorkLogComposer
                  onSubmit={handleAddWorkLog}
                  showMoney={showMoney}
                  autoStarts={unclaimed}
                />
              ) : (
                isActive && (
                  <p className="mt-2.5 rounded border border-dashed border-border-strong bg-surface-muted px-3 py-2 text-[11.5px] leading-[1.45] text-ink-3">
                    {isWarehouse
                      ? "Записи в журнале ведёт техник."
                      : "Ремонт уже взял другой техник — записи ведёт он."}
                  </p>
                )
              )}
            </div>
          </section>
        </div>

        {/* ── Правая колонка ── */}
        <div className="flex min-w-0 flex-col gap-3.5">
          <RepairEtaCard repair={repair} editable={canSetEta} onPatch={handleEtaPatch} />

          <RepairHistoryBlock
            history={repair.history}
            currentReason={repair.reason}
            currentCost={repair.partsCost}
            showMoney={showMoney}
          />

          {showMoney && (
            <section className={CARD}>
              <div className={CARD_ZONE}>
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                  <span className="eyebrow inline-flex items-center gap-1.5">
                    <RepairIcon name="rub" />
                    Затраты по этому ремонту
                  </span>
                  <span className="ml-auto rounded-[3px] border border-indigo-border bg-indigo-soft px-1 font-cond text-[9.5px] font-semibold uppercase leading-[1.6] tracking-[0.06em] text-indigo">
                    только руководитель
                  </span>
                </div>
                <div className="space-y-1 text-xs text-ink-2">
                  <div className="flex justify-between">
                    <span>Запчасти по журналу</span>
                    <span className="mono-num text-ink">{formatRub(repair.partsCost)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>
                      Работа: {String(Number(repair.totalTimeHours)).replace(".", ",")} ч
                    </span>
                    <span className="mono-num text-ink-3">
                      ≈ {formatRub(Math.round(Number(repair.totalTimeHours) * REPAIR_HOURLY_RATE))}
                    </span>
                  </div>
                </div>
                <p className="mt-1.5 text-[11px] leading-[1.45] text-ink-3">
                  Оценка работы попадает в расход, только если галочка стоит в момент закрытия.
                  Ставка — {REPAIR_HOURLY_RATE} ₽/ч.
                </p>
              </div>
            </section>
          )}
        </div>
      </div>

      <p className="mt-3 text-[11px] text-ink-3">
        Заведён {formatDateTime(repair.createdAt)}
        {repair.closedAt && ` · закрыт ${formatDateTime(repair.closedAt)}`}
      </p>

      {showCloseModal && (
        <RepairCloseModal
          repair={repair}
          onConfirm={(workValuation) => void closeRepair(workValuation)}
          onSkip={() => void closeRepair(0)}
          onCancel={() => setShowCloseModal(false)}
        />
      )}

      {showWriteOffConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/50 px-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Списать единицу"
            className="w-full max-w-sm space-y-4 rounded-lg border border-border-strong bg-surface p-5 shadow-lg"
          >
            <h3 className="font-cond text-[17px] font-bold text-ink">Списать единицу?</h3>
            <p className="text-sm text-ink-2">
              {repair.title} уйдёт из парка навсегда. Это действие необратимо.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowWriteOffConfirm(false)}
                className={`${BTN_MINI} flex-1`}
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={handleWriteOff}
                disabled={actionLoading}
                className="inline-flex flex-1 items-center justify-center rounded border border-rose bg-rose px-3 py-1.5 text-xs font-semibold text-surface transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                Списать
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
