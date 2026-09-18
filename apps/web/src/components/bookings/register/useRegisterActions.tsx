"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { BookingRegisterRow as Row } from "@light-rental/shared";
import { apiFetch } from "../../../lib/api";
import { toast } from "../../ToastProvider";
import { ConfirmActionModal } from "../ConfirmActionModal";
import { CancelWithDepositModal } from "../../finance/CancelWithDepositModal";
import { RecordPaymentModal } from "../../finance/RecordPaymentModal";
import { BookingRowMenu, type BookingRowMenuItem } from "../BookingRowMenu";
import { BulkActionBar } from "../BulkActionBar";
import { BulkResultModal } from "../BulkResultModal";
import { useBookingSelection } from "../useBookingSelection";
import { useBulkBookingActions } from "../useBulkBookingActions";
import { bulkActionMeta } from "../bulkActions";
import { BULK_MAX_IDS } from "../bulkLimits";
import type { CurrentUser } from "../../../lib/auth";
export function useRegisterActions(
  rows: Row[],
  user: CurrentUser | null,
  refresh: () => void,
  openIssues?: (r: Row) => void,
) {
  const router = useRouter(),
    sa = user?.role === "SUPER_ADMIN";
  const [payment, setPayment] = useState<Row | null>(null);
  const [deposit, setDeposit] = useState<Row | null>(null);
  const [confirm, setConfirm] = useState<{
    row: Row;
    action: "issue" | "return" | "cancel" | "archive";
    force?: boolean;
    message?: string;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    lock = useRef(false);
  const selection = useBookingSelection(
    rows.filter((r) => r.mode !== "PROJECT"),
    BULK_MAX_IDS,
  );
  const ctx = {
    isSuperAdmin: sa,
    approvalMode:
      user?.approvalMode === "auto" ? ("auto" as const) : ("manual" as const),
  };
  const bulk = useBulkBookingActions({
    rows,
    selected: selection.selected,
    ctx,
    statusFilter: "",
    rowTitle: (r) => `${r.client.name} · ${r.projectName}`,
    removeRows: () => {},
    applyStatus: () => {},
    deselect: selection.deselect,
    refreshCounts: refresh,
    onRowsEmptied: refresh,
  });
  const canPay = (r: Row) =>
    Number(r.amountOutstanding) > 0 &&
    (sa || ["ISSUED", "RETURNED"].includes(r.status));
  function primary(r: Row) {
    if (r.mode === "PROJECT") {
      router.push(`/bookings/${r.id}`);
      return;
    }
    if (["CONFIRMED", "ISSUED"].includes(r.status)) {
      if (r.hasScanSessions)
        router.push(`/warehouse/scan?booking=${encodeURIComponent(r.id)}`);
      else
        setConfirm({
          row: r,
          action: r.status === "ISSUED" ? "return" : "issue",
        });
    } else router.push(`/bookings/${r.id}`);
  }
  const primaryLabel = (r: Row) =>
    r.mode === "PROJECT"
      ? r.actions.includes("period")
        ? "Закрыть период"
        : r.projectSummary?.plannedQuantity
          ? "Доборы / выдача"
          : "Открыть проект"
      : r.status === "CONFIRMED"
        ? "Выдать"
        : r.status === "ISSUED"
          ? "Принять возврат"
          : r.status === "PENDING_APPROVAL" && sa
            ? "Согласовать"
            : "Открыть";
  async function run() {
    if (!confirm || lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await apiFetch(
        `/api/bookings/${confirm.row.id}${confirm.action === "archive" ? "" : "/status"}`,
        {
          method: confirm.action === "archive" ? "DELETE" : "POST",
          ...(confirm.action === "archive"
            ? {}
            : {
                body: JSON.stringify({
                  action: confirm.action,
                  ...(confirm.force ? { force: true } : {}),
                }),
              }),
        },
      );
      setConfirm(null);
      refresh();
      toast.success("Бронирование обновлено");
    } catch (e) {
      if (
        e instanceof Error &&
        (e as Error & { code?: string }).code === "ISSUE_TOO_EARLY" &&
        !confirm.force
      )
        setConfirm({
          ...confirm,
          force: true,
          message: `${e.message}\nРанняя выдача будет записана в историю.`,
        });
      else
        toast.error(
          e instanceof Error ? e.message : "Не удалось выполнить действие",
        );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function menu(r: Row) {
    const items: BookingRowMenuItem[] = [
      {
        key: "open",
        label: "Полная карточка",
        onSelect: () => router.push(`/bookings/${r.id}`),
      },
    ];
    if (openIssues) items.push({ key: "issues", label: "Проблемы и ремонты", onSelect: () => openIssues(r) });
    if (r.mode === "PROJECT") return <BookingRowMenu items={items} />;
    if (
      (["DRAFT", "CONFIRMED"].includes(r.status) ||
        (r.status === "PENDING_APPROVAL" && sa))
    )
      items.push({
        key: "edit",
        label: "Изменить",
        onSelect: () => router.push(`/bookings/${r.id}/edit`),
      });
    if (
      !["CANCELLED", "RETURNED", "ISSUED"].includes(r.status) &&
      (sa || Number(r.amountPaid) === 0)
    )
      items.push({
        key: "cancel",
        label: "Отменить бронь",
        danger: true,
        onSelect: () =>
          Number(r.amountPaid) > 0
            ? setDeposit(r)
            : setConfirm({ row: r, action: "cancel" }),
      });
    if (sa)
      items.push({
        key: "archive",
        label: "В архив",
        danger: true,
        onSelect: () => setConfirm({ row: r, action: "archive" }),
      });
    return <BookingRowMenu items={items} />;
  }
  const meta = bulk.confirm ? bulkActionMeta(bulk.confirm.action, ctx) : null;
  const messages = {
    issue:
      "Оборудование будет выдано по текущему составу брони. Проверьте комплект перед подтверждением.",
    return:
      "Весь состав вернётся на склад. Если есть недостача или повреждения, проведите возврат через сканирование на складе. Статус возврата финальный.",
    cancel: "Бронь будет отменена, резервы сняты. Отмена — финальный статус.",
    archive:
      "Бронь уйдёт в архив, резервы будут сняты. Данные сохранятся; восстановление доступно в архиве. Для выданного оборудования сначала оформите возврат.",
  };
  const labels = {
    issue: "Выдать",
    return: "Принять возврат",
    cancel: "Отменить бронь",
    archive: "В архив",
  };
  const modals = (
    <>
      {payment && (
        <RecordPaymentModal
          key={payment.id}
          open
          onClose={() => setPayment(null)}
          defaultBookingId={payment.id}
          bookingContext={payment}
          legacyFinance={
            payment.mode === "PROJECT" ? true : payment.legacyFinance
          }
          onCreated={() => {
            setPayment(null);
            refresh();
          }}
        />
      )}
      {deposit && (
        <CancelWithDepositModal
          open
          onClose={() => setDeposit(null)}
          bookingId={deposit.id}
          bookingDisplayName={deposit.projectName}
          clientId={deposit.client.id}
          clientName={deposit.client.name}
          depositTotal={Number(deposit.amountPaid)}
          onCancelled={() => {
            setDeposit(null);
            refresh();
          }}
        />
      )}
      <ConfirmActionModal
        open={!!confirm}
        title={
          confirm?.force
            ? "Ранняя выдача"
            : confirm
              ? labels[confirm.action]
              : ""
        }
        subtitle={
          confirm
            ? `${confirm.row.client.name} · ${confirm.row.projectName}`
            : ""
        }
        message={confirm ? (confirm.message ?? messages[confirm.action]) : ""}
        confirmLabel={
          confirm?.force
            ? "Выдать заранее"
            : confirm
              ? labels[confirm.action]
              : ""
        }
        tone={
          confirm?.action === "cancel" || confirm?.action === "archive"
            ? "danger"
            : "primary"
        }
        loading={busy}
        onClose={() => setConfirm(null)}
        onConfirm={run}
      />
      <BulkActionBar
        selectedCount={selection.selected.size}
        eligibleCounts={bulk.eligibleCounts}
        ctx={ctx}
        busyAction={bulk.busy}
        maxBatch={BULK_MAX_IDS}
        onRun={bulk.request}
        onClear={selection.clear}
      />
      <ConfirmActionModal
        open={!!bulk.confirm}
        title={meta?.confirmTitle ?? ""}
        message={meta?.confirmMessage(bulk.confirm?.ids.length ?? 0) ?? ""}
        confirmLabel={meta?.confirmLabel ?? ""}
        tone={meta?.danger ? "danger" : "primary"}
        loading={bulk.busy !== null}
        onClose={bulk.closeConfirm}
        onConfirm={bulk.run}
      />
      <BulkResultModal
        open={!!bulk.report}
        actionLabel={bulk.report?.actionLabel ?? ""}
        okCount={bulk.report?.okCount ?? 0}
        failures={bulk.report?.failures ?? []}
        onClose={bulk.closeReport}
      />
    </>
  );
  return {
    selection,
    canPay,
    pay: setPayment,
    primary,
    primaryLabel,
    menu,
    modals,
    busy: busy || bulk.busy !== null,
  };
}
