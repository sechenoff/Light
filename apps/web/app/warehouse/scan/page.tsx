"use client";

/**
 * Рабочий стол кладовщика v2 — страница-оркестратор.
 *
 * Вместо прежней step-машины «login → операция → бронь → чек-лист» —
 * постоянная навигация из 5 разделов (WorkstationShell):
 *   Смена · Выдача · Приёмка · В работе · Журнал (+ Поломки).
 *
 * Сохранено из v1 (контракты не менялись):
 *  - токен: sessionStorage "warehouse_token" (Bearer) через api.ts;
 *  - PIN-логин + bypass для main-сессии SA/WAREHOUSE (истёкшая — на /login);
 *  - deep-link `?booking=<id>` с карточки брони — сразу открывает чек-лист;
 *  - чек-листы IssueChecklist/ReturnChecklist как есть (свой state-хук внутри).
 *
 * Новое:
 *  - `?tab=` в URL — раздел переживает перезагрузку планшета;
 *  - страница держит одну activeSession: переключение таба размонтирует
 *    чек-лист, но сессия остаётся ACTIVE, а количества, отметки и исходы
 *    приёмки живут черновиком на сервере (`useChecklistDraft`) — возврат на
 *    таб восстанавливает экран из черновика (P6);
 *  - чек-лист монтируется с `key={sessionId}`: следующая бронь в левом списке
 *    получает свежий экземпляр, а не итог предыдущей (P7);
 *  - PIN-вход переживает перезагрузку: живой токен из sessionStorage
 *    (`getWarehouseAuth`) проверяется после монтирования (P18);
 *  - «←» и выбор другой брони — «ухожу»: черновик досылается, а сессия без
 *    работы прерывается (`EMPTY_LEAVE`), чтобы «открыл и посмотрел» не
 *    оставлял висящих сессий (P25);
 *  - сессию закрыли (`SESSION_*`) — чек-лист показывает `SessionClosedNotice`,
 *    «К списку броней» закрывает его и обновляет списки;
 *  - /api/warehouse/shift питает и экран «Смена», и бейджи таб-бара;
 *  - вместе со сменой читается идущая инвентаризация: карточка на «Смене» ведёт
 *    в счёт полки (`?tab=count`, своей вкладки нет). Сбой этого запроса смену
 *    не ломает — карточки просто нет.
 *
 * Мокап: docs/mockups/warehouse-scan/05-workstation-v2.html.
 */

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCurrentUser } from "../../../src/lib/auth";
import { toast } from "../../../src/components/ToastProvider";
import {
  WorkstationShell,
  type WorkstationTab,
} from "../../../src/components/warehouse/WorkstationShell";
import { LoginStep } from "../../../src/components/warehouse/LoginStep";
import { BookingList } from "../../../src/components/warehouse/BookingList";
import { IssueChecklist } from "../../../src/components/warehouse/IssueChecklist";
import { ReturnChecklist } from "../../../src/components/warehouse/ReturnChecklist";
import { InWorkList } from "../../../src/components/warehouse/InWorkList";
import { InWorkDetails } from "../../../src/components/warehouse/InWorkDetails";
import {
  ShiftHome,
  shiftHeaderEyebrow,
  shiftHeaderTitle,
} from "../../../src/components/warehouse/ShiftHome";
import { JournalScreen } from "../../../src/components/warehouse/JournalScreen";
import { ProblemsScreen } from "../../../src/components/warehouse/ProblemsScreen";
import { StockCountScreen } from "../../../src/components/warehouse/StockCountScreen";
import { scanApi, type ShiftSummaryData } from "../../../src/components/warehouse/api";
import {
  leaveChecklistSession,
  type ChecklistLeaveFn,
} from "../../../src/components/warehouse/useChecklistDraft";
import type { StockCountDetail } from "../../../src/components/inventory/types";
import { isScanApiError } from "../../../src/components/warehouse/types";
import type {
  BookingSummary,
  ChecklistSessionProps,
  ScanOperation,
  ScanSessionInfo,
} from "../../../src/components/warehouse/types";

const VALID_TABS: WorkstationTab[] = [
  "shift",
  "issue",
  "return",
  "inwork",
  "journal",
  "problems",
  "count",
];

/**
 * Идущая инвентаризация для карточки на «Смене». Сбой — `undefined`: карточка
 * остаётся как была, а экран смены не падает из-за второстепенного запроса.
 */
async function fetchActiveStockCount(): Promise<StockCountDetail | null | undefined> {
  try {
    return await scanApi.getActiveStockCount();
  } catch {
    return undefined;
  }
}

interface ActiveSession {
  sessionId: string;
  operation: ScanOperation;
  booking: BookingSummary | null;
  /** createSession продолжил идущую сессию — чек-лист покажет плашку. */
  resumed: ScanSessionInfo | null;
}

/** Ответ createSession → то, что нужно плашке «Продолжена …». */
function resumedFrom(info: ScanSessionInfo | undefined | null): ScanSessionInfo | null {
  return info?.resumed ? info : null;
}

const loadingScreen = (
  <div className="flex min-h-screen items-center justify-center bg-surface-muted">
    <div className="text-sm text-ink-3">Загрузка…</div>
  </div>
);

function WarehouseScanInner({
  hasMainSession,
  workerName,
  initialBookingId,
  initialTab,
}: {
  hasMainSession: boolean;
  workerName: string;
  initialBookingId?: string | null;
  initialTab: WorkstationTab;
}) {
  const router = useRouter();

  const [authed, setAuthed] = useState(hasMainSession);
  // PIN-вход читается из sessionStorage только после монтирования — на
  // сервере хранилища нет, и разный первый кадр сломал бы гидратацию.
  const [authChecked, setAuthChecked] = useState(hasMainSession);
  const [tab, setTab] = useState<WorkstationTab>(initialTab);
  // Имя PIN-кладовщика (после логина через киоск). Для main-сессии — username.
  const [pinWorkerName, setPinWorkerName] = useState<string | null>(null);
  const displayName = pinWorkerName ?? workerName;

  // P18: перезагрузка PIN-киоска не выкидывает на вход, пока токен жив.
  // Истёкший токен getWarehouseAuth вычищает сам; отозванный отобьёт сервер
  // первым 401 → goToLogin.
  useEffect(() => {
    const auth = scanApi.getWarehouseAuth();
    if (auth) {
      setAuthed(true);
      if (auth.workerName) setPinWorkerName(auth.workerName);
    }
    setAuthChecked(true);
  }, []);

  // Открытый чек-лист. Переключение таба размонтирует экран, но не сессию:
  // возврат на таб Выдача/Приёмка продолжает её, экран восстанавливается из
  // черновика на сервере.
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  // Последняя отрисованная сессия — для обработчиков, чтобы «уход» не жил
  // внутри функции-обновления состояния (её React вправе вызвать дважды).
  const activeRef = useRef<ActiveSession | null>(null);
  activeRef.current = activeSession;

  // Чек-лист кладёт сюда «ухожу» (useChecklistDraft); пусто — экран
  // размонтирован, и страница зовёт то же самое через leaveChecklistSession.
  const leaveRef = useRef<ChecklistLeaveFn | null>(null);
  const leaveSession = useCallback((sessionId: string) => {
    const leave = leaveRef.current;
    leaveRef.current = null;
    if (leave) leave();
    else leaveChecklistSession(sessionId);
  }, []);

  const [inWorkSelectedBookingId, setInWorkSelectedBookingId] = useState<string | null>(null);
  const [inWorkOverdueFocus, setInWorkOverdueFocus] = useState(false);

  // Монотонные счётчики — bump после успешного complete, чтобы списки
  // (BookingList / InWorkList) перезагрузились и бронь ушла из очереди.
  const [listVersion, setListVersion] = useState(0);
  const [inWorkVersion, setInWorkVersion] = useState(0);

  // Сколько броней в левом списке каждого двухпанельного таба. Пока список не
  // загружен или пуст, подсказку «Выберите бронь слева» справа не показываем.
  const [listCounts, setListCounts] = useState<Partial<Record<WorkstationTab, number>>>({});
  const noteListCount = useCallback(
    (count: number) =>
      setListCounts((prev) => (prev[tab] === count ? prev : { ...prev, [tab]: count })),
    [tab],
  );
  const hasListItems = (listCounts[tab] ?? 0) > 0;

  // ── /shift: питает экран «Смена» и бейджи навигации ────────────────────────
  const [shift, setShift] = useState<ShiftSummaryData | null>(null);
  const [shiftError, setShiftError] = useState<string | null>(null);
  const [shiftVersion, setShiftVersion] = useState(0);
  const [activeStockCount, setActiveStockCount] = useState<StockCountDetail | null>(null);

  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    setShiftError(null);
    scanApi
      .getShift()
      .then((d) => {
        if (!cancelled) setShift(d);
      })
      .catch(() => {
        if (!cancelled) setShiftError("Не удалось загрузить смену");
      });
    void fetchActiveStockCount().then((sc) => {
      if (!cancelled && sc !== undefined) setActiveStockCount(sc);
    });
    return () => {
      cancelled = true;
    };
  }, [authed, shiftVersion]);

  const refreshShift = useCallback(() => setShiftVersion((v) => v + 1), []);

  // ── Навигация ──────────────────────────────────────────────────────────────

  const goTab = useCallback(
    (next: WorkstationTab) => {
      setTab(next);
      if (next === "shift") refreshShift();
      if (next !== "inwork") setInWorkOverdueFocus(false);
      router.replace(`/warehouse/scan?tab=${next}`, { scroll: false });
    },
    [router, refreshShift],
  );

  const goToLogin = useCallback(() => {
    scanApi.clearWarehouseToken();
    if (hasMainSession) {
      toast.error("Сессия истекла, войдите заново");
      router.push(`/login?from=${encodeURIComponent("/warehouse/scan")}`);
    } else {
      setAuthed(false);
    }
  }, [hasMainSession, router]);

  // ── Deep-link ?booking=<id> — сразу в чек-лист (контракт v1). ─────────────
  const [preselecting, setPreselecting] = useState(Boolean(initialBookingId));
  const preselectConsumed = useRef(false);

  useEffect(() => {
    if (!initialBookingId || preselectConsumed.current) return;
    if (!authed) return;
    preselectConsumed.current = true;
    let cancelled = false;

    (async () => {
      try {
        const [issueList, returnList] = await Promise.all([
          scanApi.listBookings("ISSUE").catch(() => [] as BookingSummary[]),
          scanApi.listBookings("RETURN").catch(() => [] as BookingSummary[]),
        ]);
        if (cancelled) return;
        const inIssue = issueList.find((b) => b.id === initialBookingId);
        const booking = inIssue ?? returnList.find((b) => b.id === initialBookingId);
        if (!booking) {
          toast.error("Бронь недоступна для сканирования");
          return;
        }
        const op: ScanOperation = inIssue ? "ISSUE" : "RETURN";
        const created = await scanApi.createSession(booking.id, op);
        if (cancelled) return;
        setActiveSession({
          sessionId: created.id,
          operation: op,
          booking,
          resumed: resumedFrom(created),
        });
        setTab(op === "ISSUE" ? "issue" : "return");
      } catch (err: unknown) {
        // Текст сервера точнее («Бронь уже выдана — выдачу в киоске не открыть…»).
        if (!cancelled) toast.error(isScanApiError(err) ? err.message : "Не удалось открыть бронь");
      } finally {
        if (!cancelled) {
          setPreselecting(false);
          router.replace("/warehouse/scan");
        }
      }
    })();

    return () => {
      cancelled = true;
      // Прерванный запуск (двойной mount в dev StrictMode, смена authed) не должен
      // «съесть» ссылку: иначе результат отброшен, а экран навсегда «Открываем бронь…».
      preselectConsumed.current = false;
    };
  }, [initialBookingId, authed, router]);

  // ── Обработчики потоков ────────────────────────────────────────────────────

  // Выбор другой брони — уход с текущей сессии (P25): черновик досылается,
  // пустая сессия прерывается. Повторный выбор той же брони — не уход.
  const switchTo = useCallback(
    (next: ActiveSession) => {
      const prev = activeRef.current;
      if (prev && prev.sessionId !== next.sessionId) leaveSession(prev.sessionId);
      activeRef.current = next;
      setActiveSession(next);
    },
    [leaveSession],
  );

  const handleBookingSelect = useCallback(
    (sid: string, booking: BookingSummary, sessionInfo?: ScanSessionInfo) => {
      switchTo({
        sessionId: sid,
        operation: tab === "return" ? "RETURN" : "ISSUE",
        booking,
        resumed: resumedFrom(sessionInfo),
      });
    },
    [tab, switchTo],
  );

  /** Закрыть чек-лист без «ухода» — после «Готово» на экране итога. */
  const closeChecklist = useCallback(() => {
    leaveRef.current = null;
    activeRef.current = null;
    setActiveSession(null);
  }, []);

  /** «←» с чек-листа: уйти (дослать черновик / прервать пустую) и закрыть. */
  const backFromChecklist = useCallback(() => {
    const prev = activeRef.current;
    if (prev) leaveSession(prev.sessionId);
    activeRef.current = null;
    setActiveSession(null);
  }, [leaveSession]);

  const bumpListsAfterComplete = useCallback(() => {
    setListVersion((v) => v + 1);
    setInWorkVersion((v) => v + 1);
    refreshShift();
  }, [refreshShift]);

  /**
   * «К списку броней» на `SessionClosedNotice`: сессию уже закрыли (оформили,
   * прервали, бронь изменили на карточке) — закрываем чек-лист и
   * перечитываем списки: бронь могла уйти из очереди.
   */
  const handleSessionClosed = useCallback(() => {
    closeChecklist();
    bumpListsAfterComplete();
  }, [closeChecklist, bumpListsAfterComplete]);

  const handleInWorkAcceptBack = useCallback(
    async (bookingId: string) => {
      setInWorkSelectedBookingId(null);
      try {
        const [details, session] = await Promise.all([
          scanApi.getInWorkDetails(bookingId).catch(() => null),
          scanApi.createSession(bookingId, "RETURN"),
        ]);
        const booking: BookingSummary | null = details
          ? {
              id: bookingId,
              projectName: details.projectName,
              client: { id: "", name: details.clientName },
              startDate: details.issuedAt ?? "",
              endDate: details.expectedReturnAt,
              status: "ISSUED",
              items: [],
            }
          : null;
        switchTo({
          sessionId: session.id,
          operation: "RETURN",
          booking,
          resumed: resumedFrom(session),
        });
        goTab("return");
      } catch (err: unknown) {
        toast.error(isScanApiError(err) ? err.message : "Не удалось открыть приёмку");
        goTab("return");
      }
    },
    [goTab, switchTo],
  );

  // ── Логин ──────────────────────────────────────────────────────────────────

  if (!authed && !authChecked) return loadingScreen;

  if (!authed) {
    return (
      <WorkstationShell
        tab="shift"
        onTab={() => {}}
        navHidden
        eyebrow="Склад"
        title="Вход на склад"
        detail={
          <LoginStep
            onSuccess={(name) => {
              setPinWorkerName(name);
              setAuthed(true);
            }}
          />
        }
      />
    );
  }

  if (preselecting && !activeSession) {
    return (
      <WorkstationShell
        tab={tab}
        onTab={goTab}
        navHidden
        eyebrow="Склад"
        title="Открываем бронь…"
        workerName={displayName}
        detail={
          <div className="flex flex-1 items-center justify-center px-4 py-12 text-sm text-ink-3">
            Загрузка брони…
          </div>
        }
      />
    );
  }

  // ── Бейджи навигации из /shift ─────────────────────────────────────────────
  const badges = shift
    ? {
        issue: Math.max(0, shift.counters.issuesPlanned - shift.counters.issuesDone),
        return:
          Math.max(0, shift.counters.returnsPlanned - shift.counters.returnsDone) +
          shift.counters.overdue,
        inwork: shift.counters.inWork,
      }
    : {};

  const shellCommon = {
    tab,
    onTab: goTab,
    badges,
    workerName: displayName,
    onLogout: hasMainSession ? undefined : goToLogin,
  };

  // ── Смена ──────────────────────────────────────────────────────────────────
  if (tab === "shift") {
    return (
      <WorkstationShell
        {...shellCommon}
        eyebrow={shiftHeaderEyebrow()}
        title={shiftHeaderTitle(displayName)}
        detail={
          <ShiftHome
            data={shift}
            error={shiftError}
            onRetry={refreshShift}
            onGoIssue={() => goTab("issue")}
            onGoReturn={() => goTab("return")}
            onGoOverdue={() => {
              setInWorkOverdueFocus(true);
              goTab("inwork");
            }}
            onOpenEntry={(entry) => {
              if (entry.status === "OVERDUE") {
                setInWorkOverdueFocus(true);
                goTab("inwork");
              } else {
                goTab(entry.kind === "ISSUE" ? "issue" : "return");
              }
            }}
            stockCount={activeStockCount}
            onGoCount={() => goTab("count")}
          />
        }
      />
    );
  }

  // ── Инвентаризация: счёт полки ─────────────────────────────────────────────
  if (tab === "count") {
    return (
      <StockCountScreen
        shell={shellCommon}
        workerName={displayName}
        initial={activeStockCount}
        onExit={() => goTab("shift")}
        onUnauth={goToLogin}
      />
    );
  }

  // ── Выдача / Приёмка ───────────────────────────────────────────────────────
  if (tab === "issue" || tab === "return") {
    const operation: ScanOperation = tab === "issue" ? "ISSUE" : "RETURN";
    const opLabel = operation === "ISSUE" ? "Выдача" : "Приёмка";
    const opAccusative = operation === "ISSUE" ? "выдачу" : "приёмку";
    const checklistOpen =
      activeSession != null && activeSession.operation === operation;

    const bookingListSlot = (
      <BookingList
        operation={operation}
        version={listVersion}
        activeBookingId={checklistOpen ? (activeSession?.booking?.id ?? null) : null}
        onUnauth={goToLogin}
        onSelect={handleBookingSelect}
        onCountChange={noteListCount}
      />
    );

    if (checklistOpen && activeSession) {
      const projectName = activeSession.booking?.projectName ?? "";
      // Контракт страница → чек-листы (types.ts, ChecklistSessionProps):
      // плашку «Продолжена …» и SessionClosedNotice рендерят сами чек-листы.
      const sessionProps: ChecklistSessionProps = {
        resumed: activeSession.resumed,
        leaveRef,
        onSessionClosed: handleSessionClosed,
      };
      return (
        <WorkstationShell
          {...shellCommon}
          eyebrow={`${opLabel} · ${activeSession.booking ? activeSession.booking.id.slice(-6).toUpperCase() : ""}`}
          title={projectName || opLabel}
          onBack={backFromChecklist}
          list={bookingListSlot}
          mobileList="hidden"
          detail={
            operation === "ISSUE" ? (
              <IssueChecklist
                key={activeSession.sessionId}
                sessionId={activeSession.sessionId}
                projectName={projectName}
                onBack={backFromChecklist}
                onComplete={closeChecklist}
                onCompleted={bumpListsAfterComplete}
                {...sessionProps}
              />
            ) : (
              <ReturnChecklist
                key={activeSession.sessionId}
                sessionId={activeSession.sessionId}
                projectName={projectName}
                onBack={backFromChecklist}
                onDone={closeChecklist}
                onCompleted={bumpListsAfterComplete}
                {...sessionProps}
              />
            )
          }
        />
      );
    }

    return (
      <WorkstationShell
        {...shellCommon}
        eyebrow={`Склад · ${opLabel}`}
        title="Выберите бронь"
        list={bookingListSlot}
        detail={
          hasListItems ? (
            <div className="hidden flex-1 items-center justify-center px-4 py-12 text-center text-sm text-ink-3 lg:flex">
              Выберите бронь слева, чтобы начать {opAccusative}.
            </div>
          ) : null
        }
      />
    );
  }

  // ── В работе ───────────────────────────────────────────────────────────────
  if (tab === "inwork") {
    const inWorkListSlot = (
      <InWorkList
        onSelect={(bid) => setInWorkSelectedBookingId(bid)}
        onAcceptBack={(bid) => void handleInWorkAcceptBack(bid)}
        version={inWorkVersion}
        initialFilter={inWorkOverdueFocus ? "overdue" : undefined}
        onCountChange={noteListCount}
        key={inWorkOverdueFocus ? "overdue" : "default"}
      />
    );
    if (inWorkSelectedBookingId) {
      return (
        <WorkstationShell
          {...shellCommon}
          eyebrow="Склад · В работе"
          title="Активная выдача"
          onBack={() => setInWorkSelectedBookingId(null)}
          list={inWorkListSlot}
          mobileList="hidden"
          detail={
            <InWorkDetails
              bookingId={inWorkSelectedBookingId}
              onAcceptBack={(bid) => void handleInWorkAcceptBack(bid)}
            />
          }
        />
      );
    }
    return (
      <WorkstationShell
        {...shellCommon}
        eyebrow="Склад · В работе"
        title={`У клиентов сейчас${shift ? ` · ${shift.counters.inWork}` : ""}`}
        list={inWorkListSlot}
        detail={
          hasListItems ? (
            <div className="hidden flex-1 items-center justify-center px-4 py-12 text-center text-sm text-ink-3 lg:flex">
              Выберите бронь слева, чтобы посмотреть выдачу.
            </div>
          ) : null
        }
      />
    );
  }

  // ── Журнал ─────────────────────────────────────────────────────────────────
  if (tab === "journal") {
    return (
      <WorkstationShell
        {...shellCommon}
        eyebrow="Склад · Журнал"
        title="Учёт работы"
        detail={<JournalScreen onOpenProblems={() => goTab("problems")} />}
      />
    );
  }

  // ── Поломки ────────────────────────────────────────────────────────────────
  return (
    <WorkstationShell
      {...shellCommon}
      eyebrow="Склад · Поломки"
      title="Поломки и потеряшки"
      onBack={() => goTab("journal")}
      backMobileOnly
      detail={<ProblemsScreen hasMainSession={hasMainSession} />}
    />
  );
}

function WarehouseScanPageBody() {
  const { user, loading } = useCurrentUser();
  const searchParams = useSearchParams();
  const initialBookingId = searchParams.get("booking");
  const tabParam = searchParams.get("tab");
  const initialTab: WorkstationTab = VALID_TABS.includes(tabParam as WorkstationTab)
    ? (tabParam as WorkstationTab)
    : "shift";

  if (loading) return loadingScreen;

  const hasMainSession = user?.role === "SUPER_ADMIN" || user?.role === "WAREHOUSE";
  const workerName = user?.username ?? "Кладовщик";

  return (
    <WarehouseScanInner
      hasMainSession={hasMainSession}
      workerName={workerName}
      initialBookingId={initialBookingId}
      initialTab={initialTab}
    />
  );
}

export default function WarehouseScanPage() {
  // useSearchParams требует Suspense boundary в Next.js 14 (App Router).
  return (
    <Suspense fallback={loadingScreen}>
      <WarehouseScanPageBody />
    </Suspense>
  );
}
