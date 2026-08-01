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
 *  - страница держит одну activeSession: переключение таба НЕ теряет
 *    открытый чек-лист (сессия ACTIVE, возврат на таб продолжает её);
 *  - /api/warehouse/shift питает и экран «Смена», и бейджи таб-бара.
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
import { ResumedSessionBanner } from "../../../src/components/warehouse/ResumedSessionBanner";
import { scanApi, type ShiftSummaryData } from "../../../src/components/warehouse/api";
import type {
  BookingSummary,
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
];

interface ActiveSession {
  sessionId: string;
  operation: ScanOperation;
  booking: BookingSummary | null;
}

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
  const [tab, setTab] = useState<WorkstationTab>(initialTab);
  // Имя PIN-кладовщика (после логина через киоск). Для main-сессии — username.
  const [pinWorkerName, setPinWorkerName] = useState<string | null>(null);
  const displayName = pinWorkerName ?? workerName;

  // Открытый чек-лист. Переключение таба его НЕ сбрасывает — возврат на таб
  // Выдача/Приёмка продолжает сессию (она ACTIVE и резюмируема на бэке).
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);

  const [inWorkSelectedBookingId, setInWorkSelectedBookingId] = useState<string | null>(null);
  const [inWorkOverdueFocus, setInWorkOverdueFocus] = useState(false);

  const [resumedStartedAt, setResumedStartedAt] = useState<string | null>(null);
  const [showResumedBanner, setShowResumedBanner] = useState(false);

  // Монотонные счётчики — bump после успешного complete, чтобы списки
  // (BookingList / InWorkList) перезагрузились и бронь ушла из очереди.
  const [listVersion, setListVersion] = useState(0);
  const [inWorkVersion, setInWorkVersion] = useState(0);

  // ── /shift: питает экран «Смена» и бейджи навигации ────────────────────────
  const [shift, setShift] = useState<ShiftSummaryData | null>(null);
  const [shiftError, setShiftError] = useState<string | null>(null);
  const [shiftVersion, setShiftVersion] = useState(0);

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
    return () => {
      cancelled = true;
    };
  }, [authed, shiftVersion]);

  const refreshShift = useCallback(() => setShiftVersion((v) => v + 1), []);

  const noteSessionResumed = useCallback(
    (info?: { resumed?: boolean; startedAt?: string }) => {
      if (info?.resumed) {
        setResumedStartedAt(info.startedAt ?? null);
        setShowResumedBanner(true);
      } else {
        setResumedStartedAt(null);
        setShowResumedBanner(false);
      }
    },
    [],
  );

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
        noteSessionResumed(created);
        setActiveSession({ sessionId: created.id, operation: op, booking });
        setTab(op === "ISSUE" ? "issue" : "return");
      } catch {
        if (!cancelled) toast.error("Не удалось открыть бронь");
      } finally {
        if (!cancelled) {
          setPreselecting(false);
          router.replace("/warehouse/scan");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [initialBookingId, authed, router, noteSessionResumed]);

  // ── Обработчики потоков ────────────────────────────────────────────────────

  const handleBookingSelect = useCallback(
    (sid: string, booking: BookingSummary, sessionInfo?: ScanSessionInfo) => {
      noteSessionResumed(sessionInfo);
      setActiveSession({
        sessionId: sid,
        operation: tab === "return" ? "RETURN" : "ISSUE",
        booking,
      });
    },
    [tab, noteSessionResumed],
  );

  const closeChecklist = useCallback(() => {
    setActiveSession(null);
    noteSessionResumed(undefined);
  }, [noteSessionResumed]);

  const bumpListsAfterComplete = useCallback(() => {
    setListVersion((v) => v + 1);
    setInWorkVersion((v) => v + 1);
    refreshShift();
  }, [refreshShift]);

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
        noteSessionResumed(session);
        setActiveSession({ sessionId: session.id, operation: "RETURN", booking });
        goTab("return");
      } catch {
        toast.error("Не удалось открыть приёмку");
        goTab("return");
      }
    },
    [goTab, noteSessionResumed],
  );

  // ── Логин ──────────────────────────────────────────────────────────────────

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
          />
        }
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
      />
    );

    if (checklistOpen && activeSession) {
      const projectName = activeSession.booking?.projectName ?? "";
      return (
        <WorkstationShell
          {...shellCommon}
          eyebrow={`${opLabel} · ${activeSession.booking ? activeSession.booking.id.slice(-6).toUpperCase() : ""}`}
          title={projectName || opLabel}
          onBack={closeChecklist}
          list={bookingListSlot}
          mobileList="hidden"
          detail={
            <>
              {showResumedBanner && (
                <ResumedSessionBanner
                  startedAt={resumedStartedAt}
                  onDismiss={() => setShowResumedBanner(false)}
                />
              )}
              {operation === "ISSUE" ? (
                <IssueChecklist
                  sessionId={activeSession.sessionId}
                  projectName={projectName}
                  onBack={closeChecklist}
                  onComplete={closeChecklist}
                  onCompleted={bumpListsAfterComplete}
                />
              ) : (
                <ReturnChecklist
                  sessionId={activeSession.sessionId}
                  projectName={projectName}
                  onBack={closeChecklist}
                  onDone={closeChecklist}
                  onCompleted={bumpListsAfterComplete}
                />
              )}
            </>
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
          <div className="hidden flex-1 items-center justify-center px-4 py-12 text-center text-sm text-ink-3 lg:flex">
            Выберите бронь слева, чтобы начать {opAccusative}.
          </div>
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
              onBack={() => setInWorkSelectedBookingId(null)}
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
          <div className="hidden flex-1 items-center justify-center px-4 py-12 text-center text-sm text-ink-3 lg:flex">
            Выберите бронь слева, чтобы посмотреть выдачу.
          </div>
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
      eyebrow="Склад · Журнал"
      title="Поломки и потеряшки"
      onBack={() => goTab("journal")}
      detail={<ProblemsScreen />}
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

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-muted">
        <div className="text-sm text-ink-3">Загрузка…</div>
      </div>
    );
  }

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
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-surface-muted">
          <div className="text-sm text-ink-3">Загрузка…</div>
        </div>
      }
    >
      <WarehouseScanPageBody />
    </Suspense>
  );
}
