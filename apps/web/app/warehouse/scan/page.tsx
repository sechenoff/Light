"use client";

/**
 * Warehouse-scan kiosk page — THIN shell (Task 5.2).
 *
 * Standalone client component, NO AppShell (mounted-tablet kiosk surface).
 * Composes `useScanSession` + `ScanShell` and renders one component per step:
 *   login     → LoginStep            (canon PIN login, token contract intact)
 *   operation → OperationStep        (ISSUE / RETURN picker)
 *   booking   → BookingList          (filter-less, date-grouped)
 *   checklist → IssueChecklist (ISSUE) / ReturnChecklist (RETURN, Task 7.2:
 *               3-outcome приёмка + inline completion result). Both checklists
 *               own their own completion finale; there is no outer summary step.
 *
 * Preserved verbatim from the previous implementation:
 *  - token contract: sessionStorage "warehouse_token" (Bearer) via api.ts
 *  - step machine values: login|operation|booking|checklist
 *  - PIN-login flow + SA/WAREHOUSE "main session" bypass (skip login,
 *    expired token → redirect to /login)
 *  - session creation on booking tap → advance to checklist
 *
 * Desktop adaptive (mockup 03 block 4): from the booking step onward the
 * booking list stays in ScanShell's left pane, the active step in the right.
 */

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCurrentUser } from "../../../src/lib/auth";
import { toast } from "../../../src/components/ToastProvider";
import { ScanShell } from "../../../src/components/warehouse/ScanShell";
import { LoginStep } from "../../../src/components/warehouse/LoginStep";
import { OperationStep } from "../../../src/components/warehouse/OperationStep";
import type { ScanViewMode } from "../../../src/components/warehouse/OperationStep";
import { BookingList } from "../../../src/components/warehouse/BookingList";
import { IssueChecklist } from "../../../src/components/warehouse/IssueChecklist";
import { ReturnChecklist } from "../../../src/components/warehouse/ReturnChecklist";
import { InWorkList } from "../../../src/components/warehouse/InWorkList";
import { InWorkDetails } from "../../../src/components/warehouse/InWorkDetails";
import { useScanSession } from "../../../src/components/warehouse/useScanSession";
import { scanApi } from "../../../src/components/warehouse/api";
import type {
  BookingSummary,
  ScanOperation,
} from "../../../src/components/warehouse/types";

function WarehouseScanInner({
  hasMainSession,
  workerName,
  initialBookingId,
}: {
  hasMainSession: boolean;
  workerName: string;
  /** Deep-link ?booking=<id> с карточки брони — предвыбор брони после авторизации. */
  initialBookingId?: string | null;
}) {
  const router = useRouter();
  const session = useScanSession(hasMainSession ? "operation" : "login");
  const { step, operation, sessionId, goStep, setOperation, openSession } =
    session;

  // Booking selected for the active session (project/client for headers).
  const [activeBooking, setActiveBooking] = useState<BookingSummary | null>(
    null,
  );

  // «В работе» view-mode state — only meaningful when viewMode === "IN_WORK".
  // The page enters IN_WORK from OperationStep; from there it shows InWorkList,
  // then optionally InWorkDetails. There is no scan session in IN_WORK mode.
  const [viewMode, setViewMode] = useState<ScanViewMode>("ISSUE");
  const [inWorkSelectedBookingId, setInWorkSelectedBookingId] = useState<
    string | null
  >(null);
  // Monotonic counter — bumped after the operator returns to «В работе» from
  // a successful RETURN session, so InWorkList re-fetches and the just-handled
  // booking disappears. Mirrors `listVersion` for BookingList.
  const [inWorkVersion, setInWorkVersion] = useState(0);

  // Monotonic counter — bumped after a successful complete so the BookingList
  // re-fetches and the just-issued booking disappears from the ISSUE list
  // (and re-appears in the RETURN list when the operator switches operation).
  // Without this the list cache stays stale → operator sees the booking they
  // just completed and might tap it again (backend will refuse, but the UX
  // confusion is real).
  const [listVersion, setListVersion] = useState(0);

  // ── Deep-link ?booking=<id> ────────────────────────────────────────────────
  // Кнопка «Начать сканирование» на карточке брони передаёт ?booking=. После
  // авторизации сразу определяем операцию (бронь в списке выдач → ISSUE, в
  // списке возвратов → RETURN), создаём сессию и открываем чек-лист — шаги
  // «операция» и «выбор брони» пропускаются. Кнопка «←» (Назад) в шапке
  // возвращает к списку броней как обычно. Параметр расходуется один раз.
  const [preselecting, setPreselecting] = useState(Boolean(initialBookingId));
  const preselectConsumed = useRef(false);

  useEffect(() => {
    if (!initialBookingId || preselectConsumed.current) return;
    if (step === "login") return; // ждём авторизацию (PIN или main-session)
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
        const booking =
          inIssue ?? returnList.find((b) => b.id === initialBookingId);
        if (!booking) {
          toast.error("Бронь недоступна для сканирования");
          return;
        }

        const op: ScanOperation = inIssue ? "ISSUE" : "RETURN";
        setViewMode(op);
        setOperation(op);
        setActiveBooking(booking);
        const created = await scanApi.createSession(booking.id, op);
        if (cancelled) return;
        await openSession(created.id, op);
        if (cancelled) return;
        goStep("checklist");
      } catch {
        if (!cancelled) toast.error("Не удалось открыть бронь");
      } finally {
        if (!cancelled) {
          setPreselecting(false);
          // Чистим query, чтобы обновление страницы не запускало предвыбор заново.
          router.replace("/warehouse/scan");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [initialBookingId, step, setOperation, openSession, goStep, router]);

  const goToLogin = useCallback(() => {
    scanApi.clearWarehouseToken();
    if (hasMainSession) {
      toast.error("Сессия истекла, войдите заново");
      router.push(`/login?from=${encodeURIComponent("/warehouse/scan")}`);
    } else {
      goStep("login");
    }
  }, [hasMainSession, router, goStep]);

  const handleLoginSuccess = useCallback(() => {
    goStep("operation");
  }, [goStep]);

  const handleOperationSelect = useCallback(
    (mode: ScanViewMode) => {
      setViewMode(mode);
      if (mode === "IN_WORK") {
        // IN_WORK: skip operation/RETURN session creation — page renders
        // InWorkList instead of BookingList in the «booking» step.
        setInWorkSelectedBookingId(null);
        goStep("booking");
        return;
      }
      setOperation(mode);
      goStep("booking");
    },
    [setOperation, goStep],
  );

  const handleInWorkAcceptBack = useCallback(
    async (bookingId: string) => {
      // Switch from view-only IN_WORK mode into a real RETURN session for
      // this booking. Fetch in-work details FIRST so we carry projectName
      // into the checklist header (otherwise the title would be blank).
      setViewMode("RETURN");
      setOperation("RETURN");
      setInWorkSelectedBookingId(null);
      try {
        const [details, session] = await Promise.all([
          scanApi.getInWorkDetails(bookingId).catch(() => null),
          scanApi.createSession(bookingId, "RETURN"),
        ]);
        if (details) {
          // Build a minimal BookingSummary for the checklist header.
          setActiveBooking({
            id: bookingId,
            projectName: details.projectName,
            client: { id: "", name: details.clientName },
            startDate: details.issuedAt ?? "",
            endDate: details.expectedReturnAt,
            status: "ISSUED",
            items: [],
          });
        }
        if (session && session.id) {
          await openSession(session.id, "RETURN");
          goStep("checklist");
          return;
        }
      } catch {
        // ignore — fall through to booking list
      }
      goStep("booking");
    },
    [openSession, setOperation, goStep],
  );

  const handleBookingSelect = useCallback(
    async (sid: string, booking: BookingSummary) => {
      setActiveBooking(booking);
      await openSession(sid, operation);
      goStep("checklist");
    },
    [openSession, operation, goStep],
  );

  const backToBooking = useCallback(async () => {
    await openSession(null);
    setActiveBooking(null);
    goStep("booking");
  }, [openSession, goStep]);

  // Triggered the moment a successful /complete response comes back — bumps
  // both list versions so the LEFT pane (desktop) refetches immediately,
  // without waiting for the operator to press «Готово» on the result screen.
  // Was the cause of «бронь не уходит из списка приёмки»: BookingList only
  // refetched on listVersion change, which previously was bumped only on
  // «Готово» click.
  const bumpListsAfterComplete = useCallback(() => {
    setListVersion((v) => v + 1);
    setInWorkVersion((v) => v + 1);
  }, []);

  // Same as backToBooking, kept as the «Готово» handler. The list refetch is
  // already done by bumpListsAfterComplete the moment the response arrived,
  // so this is now pure navigation.
  const backToBookingAfterComplete = useCallback(async () => {
    await backToBooking();
  }, [backToBooking]);

  const backToOperation = useCallback(() => {
    goStep("operation");
  }, [goStep]);

  // ── Render ─────────────────────────────────────────────────────────────────

  if (step === "login") {
    return (
      <ScanShell
        eyebrow="Склад"
        title="Вход на склад"
        detail={<LoginStep onSuccess={handleLoginSuccess} />}
      />
    );
  }

  // Пока идёт предвыбор брони из deep-link — не мигаем экраном «Выберите
  // операцию»: показываем нейтральную загрузку до перехода в чек-лист.
  if (preselecting && step !== "checklist") {
    return (
      <ScanShell
        eyebrow="Склад"
        title="Открываем бронь…"
        workerName={workerName}
        detail={
          <div className="flex flex-1 items-center justify-center px-4 py-12 text-sm text-ink-3">
            Загрузка брони…
          </div>
        }
      />
    );
  }

  if (step === "operation") {
    return (
      <ScanShell
        eyebrow="Склад"
        title="Выберите операцию"
        workerName={workerName}
        onLogout={hasMainSession ? undefined : goToLogin}
        detail={<OperationStep onSelect={handleOperationSelect} />}
      />
    );
  }

  const opLabel =
    viewMode === "IN_WORK"
      ? "В работе"
      : operation === "ISSUE"
        ? "Выдача"
        : "Возврат";
  // Accusative for the «чтобы начать N» phrase: «выдачу» (feminine) / «возврат»
  // (masculine inanimate stays nominative). Без этого выводилось «начать выдача».
  const opAccusative = operation === "ISSUE" ? "выдачу" : "возврат";

  // ── IN_WORK branch — list of active bookings + details + «← Принять обратно». ──
  if (viewMode === "IN_WORK" && step === "booking") {
    const inWorkListSlot = (
      <InWorkList
        onSelect={(bid) => setInWorkSelectedBookingId(bid)}
        version={inWorkVersion}
      />
    );
    if (inWorkSelectedBookingId) {
      return (
        <ScanShell
          eyebrow="Склад · В работе"
          title="Активная выдача"
          workerName={workerName}
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
      <ScanShell
        eyebrow="Склад · В работе"
        title="Что сейчас у клиентов"
        workerName={workerName}
        onBack={backToOperation}
        list={inWorkListSlot}
        detail={
          <div className="hidden flex-1 items-center justify-center px-4 py-12 text-center text-sm text-ink-3 lg:flex">
            Выберите бронь слева, чтобы посмотреть выдачу.
          </div>
        }
      />
    );
  }

  const bookingListSlot = (
    <BookingList
      operation={operation}
      version={listVersion}
      activeBookingId={step === "checklist" ? (activeBooking?.id ?? null) : null}
      onUnauth={goToLogin}
      onSelect={handleBookingSelect}
    />
  );

  if (step === "booking") {
    return (
      <ScanShell
        eyebrow={`Склад · ${opLabel}`}
        title="Выберите бронь"
        workerName={workerName}
        onBack={backToOperation}
        list={bookingListSlot}
        detail={
          <div className="hidden flex-1 items-center justify-center px-4 py-12 text-center text-sm text-ink-3 lg:flex">
            Выберите бронь слева, чтобы начать {opAccusative}.
          </div>
        }
      />
    );
  }

  const projectName = activeBooking?.projectName ?? "";
  const headerTitle = projectName || opLabel;

  if (step === "checklist" && sessionId) {
    return (
      <ScanShell
        eyebrow={`${opLabel} · ${activeBooking ? activeBooking.id.slice(-6).toUpperCase() : ""}`}
        title={headerTitle}
        workerName={workerName}
        onBack={backToBooking}
        list={bookingListSlot}
        mobileList="hidden"
        detail={
          operation === "ISSUE" ? (
            <IssueChecklist
              sessionId={sessionId}
              projectName={projectName}
              onBack={backToBooking}
              onComplete={backToBookingAfterComplete}
              onCompleted={bumpListsAfterComplete}
            />
          ) : (
            <ReturnChecklist
              sessionId={sessionId}
              projectName={projectName}
              onBack={backToBooking}
              onDone={backToBookingAfterComplete}
              onCompleted={bumpListsAfterComplete}
            />
          )
        }
      />
    );
  }

  // Defensive fallback (e.g. checklist without a session).
  return (
    <ScanShell
      eyebrow={`Склад · ${opLabel}`}
      title="Выберите бронь"
      workerName={workerName}
      onBack={backToOperation}
      list={bookingListSlot}
      detail={
        <div className="hidden flex-1 items-center justify-center px-4 py-12 text-center text-sm text-ink-3 lg:flex">
          Выберите бронь слева, чтобы начать {opAccusative}.
        </div>
      }
    />
  );
}

function WarehouseScanPageBody() {
  const { user, loading } = useCurrentUser();
  const searchParams = useSearchParams();
  const initialBookingId = searchParams.get("booking");

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-muted">
        <div className="text-sm text-ink-3">Загрузка…</div>
      </div>
    );
  }

  const hasMainSession =
    user?.role === "SUPER_ADMIN" || user?.role === "WAREHOUSE";
  const workerName = user?.username ?? "Кладовщик";

  return (
    <WarehouseScanInner
      hasMainSession={hasMainSession}
      workerName={workerName}
      initialBookingId={initialBookingId}
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
