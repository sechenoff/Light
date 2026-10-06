/**
 * Смена клиента брони.
 *
 * Основная бронь и её продолжения — одна сделка, разделённая приёмкой, и
 * клиент у них один (правило семьи). Раньше смена клиента у брони с
 * продолжением поэтому просто запрещалась, и ошибочно выбранного клиента было
 * не исправить. Теперь клиент меняется у всей семьи сразу — с какой бы брони
 * семьи его ни меняли: правило «один клиент» соблюдено, а исправление
 * возможно.
 */
import type { Prisma } from "@prisma/client";

import { writeAuditEntry } from "./audit";
import { loadFamily } from "./bookingFamily";

/**
 * Перевести бронь и всю её семью на клиента. Брони, которые уже у него, не
 * трогаются. Каждая переведённая бронь получает запись в журнале — в той же
 * транзакции. Возвращает id переведённых броней.
 */
export async function moveBookingFamilyToClient(
  tx: Prisma.TransactionClient,
  args: {
    booking: { id: string; rootBookingId: string | null };
    client: { id: string; name: string };
    userId: string;
  },
): Promise<string[]> {
  // Семья — основная и все продолжения; бронь без семьи — она сама.
  const ids = (await loadFamily(tx, args.booking)).map((m) => m.id);
  const members = await tx.booking.findMany({
    where: { id: { in: ids }, clientId: { not: args.client.id } },
    select: { id: true, client: { select: { id: true, name: true } } },
  });
  if (members.length === 0) return [];
  await tx.booking.updateMany({
    where: { id: { in: members.map((m) => m.id) } },
    data: { clientId: args.client.id },
  });
  for (const m of members) {
    await writeAuditEntry({
      tx,
      userId: args.userId,
      action: "BOOKING_CLIENT_CHANGED",
      entityType: "Booking",
      entityId: m.id,
      before: { clientId: m.client.id, clientName: m.client.name },
      after: {
        clientId: args.client.id,
        clientName: args.client.name,
        ...(m.id !== args.booking.id ? { reason: "Клиент сменён у всей семьи броней" } : {}),
      },
    });
  }
  return members.map((m) => m.id);
}
