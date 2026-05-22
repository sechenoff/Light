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

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
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
}: {
  hasMainSession: boolean;
  workerName: string;
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

  // Monotonic counter — bumped after a successful complete so the BookingList
  // re-fetches and the just-issued booking disappears from the ISSUE list
  // (and re-appears in the RETURN list when the operator switches operation).
  // Without this the list cache stays stale → operator sees the booking they
  // just completed and might tap it again (backend will refuse, but the UX
  // confusion is real).
  const [listVersion, setListVersion] = useState(0);

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
      // this booking. Try to open an existing ACTIVE RETURN session first;
      // if none exists, the user can pick the booking from the normal RETURN
      // list and start a new one. To keep the flow simple, we just flip the
      // mode + operation and navigate the user to the bookings list filtered
      // by RETURN — they'll see the same booking ready to be picked.
      setViewMode("RETURN");
      setOperation("RETURN");
      setInWorkSelectedBookingId(null);
      // Try to fetch an existing session for this booking. If the backend
      // sessions endpoint exists for booking-id lookup, we can directly
      // jump into checklist. Otherwise fall back to the booking list and
      // let the user tap.
      try {
        const session = await scanApi.createSession(bookingId, "RETURN");
        if (session && session.id) {
          // Reuse / create — same idempotent path as BookingList.onSelect.
          // We don't have an activeBooking for headers (in-work-details
          // returned projectName, but we don't keep it here). Best-effort:
          // null booking is acceptable — checklist still loads from sessionId.
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

  // Same as backToBooking, but also bumps listVersion → BookingList refetches.
  // Wire this into `onComplete`/`onDone` (= «Готово» from the result screen);
  // the plain `onBack` path keeps `backToBooking` because nothing changed.
  const backToBookingAfterComplete = useCallback(async () => {
    setListVersion((v) => v + 1);
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
        detail={
          operation === "ISSUE" ? (
            <IssueChecklist
              sessionId={sessionId}
              projectName={projectName}
              onBack={backToBooking}
              onComplete={backToBookingAfterComplete}
            />
          ) : (
            <ReturnChecklist
              sessionId={sessionId}
              projectName={projectName}
              onBack={backToBooking}
              onDone={backToBookingAfterComplete}
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

export default function WarehouseScanPage() {
  const { user, loading } = useCurrentUser();

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
    />
  );
}
