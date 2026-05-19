"use client";

/**
 * Warehouse-scan kiosk page — THIN shell (Task 5.2).
 *
 * Standalone client component, NO AppShell (mounted-tablet kiosk surface).
 * Composes `useScanSession` + `ScanShell` and renders one component per step:
 *   login     → LoginStep            (canon PIN login, token contract intact)
 *   operation → OperationStep        (ISSUE / RETURN picker)
 *   booking   → BookingList          (filter-less, date-grouped)
 *   checklist → IssueChecklist / ReturnChecklist  (Task 6/7 placeholders)
 *   summary   → SummaryStep          (Task 7/8 placeholder)
 *
 * Preserved verbatim from the previous implementation:
 *  - token contract: sessionStorage "warehouse_token" (Bearer) via api.ts
 *  - step machine values: login|operation|booking|checklist|summary
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
import { BookingList } from "../../../src/components/warehouse/BookingList";
import { IssueChecklist } from "../../../src/components/warehouse/IssueChecklist";
import { ReturnChecklist } from "../../../src/components/warehouse/ReturnChecklist";
import { SummaryStep } from "../../../src/components/warehouse/SummaryStep";
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
    (op: ScanOperation) => {
      setOperation(op);
      goStep("booking");
    },
    [setOperation, goStep],
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

  const opLabel = operation === "ISSUE" ? "Выдача" : "Возврат";

  const bookingListSlot = (
    <BookingList
      operation={operation}
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
            Выберите бронь слева, чтобы начать {opLabel.toLowerCase()}.
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
            />
          ) : (
            <ReturnChecklist
              sessionId={sessionId}
              projectName={projectName}
              onBack={backToBooking}
            />
          )
        }
      />
    );
  }

  if (step === "summary" && sessionId) {
    return (
      <ScanShell
        eyebrow={`${opLabel} · итог`}
        title={headerTitle}
        workerName={workerName}
        onBack={() => goStep("checklist")}
        list={bookingListSlot}
        detail={
          <SummaryStep
            sessionId={sessionId}
            onBack={() => goStep("checklist")}
          />
        }
      />
    );
  }

  // Defensive fallback (e.g. checklist/summary without a session).
  return (
    <ScanShell
      eyebrow={`Склад · ${opLabel}`}
      title="Выберите бронь"
      workerName={workerName}
      onBack={backToOperation}
      list={bookingListSlot}
      detail={
        <div className="hidden flex-1 items-center justify-center px-4 py-12 text-center text-sm text-ink-3 lg:flex">
          Выберите бронь слева, чтобы начать {opLabel.toLowerCase()}.
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
