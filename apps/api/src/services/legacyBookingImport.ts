import Decimal from "decimal.js";

import { prisma } from "../prisma";
import { writeAuditEntry } from "./audit";

export interface LegacyImportRow {
  filename: string;
  clientName: string;
  date: string; // ISO datetime string
  amount: number;
}

export interface LegacyImportResult {
  created: number;
  clients: { created: number; matched: number };
  bookings: Array<{ id: string; clientName: string; finalAmount: string }>;
}

export async function importLegacyBookings(
  rows: LegacyImportRow[],
  userId: string,
): Promise<LegacyImportResult> {
  return prisma.$transaction(async (tx) => {
    const results: Array<{ id: string; clientName: string; finalAmount: string }> = [];
    let clientsCreated = 0;
    let clientsMatched = 0;

    for (const row of rows) {
      const normalizedName = row.clientName.trim();

      // Case-insensitive client lookup.
      // SQLite не поддерживает mode: "insensitive" для кириллицы через LIKE,
      // поэтому используем JS-сравнение: загружаем все имена и фильтруем toLowerCase().
      // Коллекция клиентов небольшая, поэтому это приемлемо.
      const lowerNorm = normalizedName.toLowerCase();
      const allClients = await tx.client.findMany({ select: { id: true, name: true } });
      const existingClient =
        allClients.find((c) => c.name.toLowerCase() === lowerNorm) ?? null;

      const client =
        existingClient ??
        (await tx.client.create({
          data: {
            name: normalizedName,
            phone: null,
            email: null,
            comment: "Создан импортом легаси-брони",
          },
        }));

      if (existingClient) {
        clientsMatched++;
      } else {
        clientsCreated++;
      }

      const startDate = new Date(row.date);
      const endDate = new Date(row.date);
      endDate.setHours(23, 59, 59, 999);

      const amountDec = new Decimal(row.amount).toDecimalPlaces(2);
      const amountStr = amountDec.toString();

      const booking = await tx.booking.create({
        data: {
          clientId: client.id,
          projectName: `Импорт: ${row.filename}`,
          startDate,
          endDate,
          status: "RETURNED",
          isLegacyImport: true,
          comment: null,
          discountPercent: null,
          totalEstimateAmount: amountStr,
          discountAmount: "0",
          finalAmount: amountStr,
          paymentStatus: "NOT_PAID",
          amountPaid: "0",
          amountOutstanding: amountStr,
          isFullyPaid: false,
        },
      });

      await writeAuditEntry({
        tx,
        userId,
        action: "LEGACY_IMPORTED",
        entityType: "Booking",
        entityId: booking.id,
        before: null,
        after: {
          filename: row.filename,
          clientName: normalizedName,
          amount: row.amount,
        },
      });

      results.push({
        id: booking.id,
        clientName: normalizedName,
        finalAmount: amountStr,
      });
    }

    return {
      created: results.length,
      clients: { created: clientsCreated, matched: clientsMatched },
      bookings: results,
    };
  });
}
