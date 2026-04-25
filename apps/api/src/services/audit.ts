import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";

type TxClient = Omit<
  Prisma.TransactionClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends" | "$use"
>;

type AuditEntityType =
  | "Booking"
  | "Payment"
  | "Expense"
  | "Unit"
  | "EquipmentUnit"
  | "Client"
  | "Repair"
  | "AdminUser"
  | "Vehicle"
  | "Task"
  // L4: Finance Phase 2 entities
  | "Invoice"
  | "Refund"
  | "CreditNote"
  | "OrgSettings";

/**
 * Записывает событие в аудит-лог.
 * Принимает опциональный `tx` для использования внутри транзакций.
 */
export async function writeAuditEntry(args: {
  tx?: TxClient;
  userId: string;
  action: string;
  entityType: AuditEntityType;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}): Promise<void> {
  const client = args.tx ?? prisma;
  await client.auditEntry.create({
    data: {
      userId: args.userId,
      action: args.action,
      entityType: args.entityType,
      entityId: args.entityId,
      before: args.before ? JSON.stringify(diffFields(args.before)) : null,
      after: args.after ? JSON.stringify(diffFields(args.after)) : null,
    },
  });
}

/**
 * Очищает объект от вложенных связей (отношений ORM) и обрезает по максимальному размеру.
 *
 * Правила:
 * - Массивы отбрасываются (relations-to-many).
 * - Объекты с полем `id` отбрасываются (relations-to-one).
 * - Если итоговый JSON > maxBytes — оставляем только примитивы.
 */
export function diffFields(
  obj: Record<string, unknown>,
  maxBytes = 10 * 1024,
): Record<string, unknown> {
  const cleaned = Object.fromEntries(
    Object.entries(obj).filter(([, v]) => {
      if (v === null || v === undefined) return true;
      if (Array.isArray(v)) return false;
      if (typeof v === "object" && "id" in (v as Record<string, unknown>)) {
        return false; // вложенная relation — пропускаем
      }
      return true;
    }),
  );

  const asJson = JSON.stringify(cleaned);
  if (asJson.length <= maxBytes) return cleaned;

  // Усечение: оставляем только примитивы
  return Object.fromEntries(
    Object.entries(cleaned).filter(([, v]) => {
      return v === null || typeof v !== "object";
    }),
  );
}
