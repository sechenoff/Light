/**
 * Shared helpers for generating booking invoice and act PDFs.
 *
 * Both the admin route (`/api/bookings/:id/invoice.pdf` and `/api/bookings/:id/act.pdf`)
 * and the client-portal route (`/api/lk/bookings/:id/estimate.pdf` and `/api/lk/bookings/:id/act.pdf`)
 * call these functions after performing their own auth/ownership checks.
 *
 * Functions accept a bookingId string and return a PDF buffer.
 * They do NOT set response headers or check permissions — that is the caller's responsibility.
 */

import Decimal from "decimal.js";
import { prisma } from "../../prisma";
import { getSettings } from "../organizationService";
import { renderInvoicePdf, coalesceWithEnv, type InvoiceLine } from "./invoice/renderInvoicePdf";
import { renderActPdf, type ActLine } from "./act/renderActPdf";

/**
 * Builds and renders the booking's invoice/estimate PDF.
 * Requires the booking to exist (caller must have verified ownership and status).
 * Returns a PDF buffer.
 */
export async function buildBookingEstimatePdf(bookingId: string): Promise<Buffer> {
  const booking = await prisma.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: {
      client: true,
      estimates: { include: { lines: true } },
      items: { include: { equipment: true } },
    },
  });

  const orgSettings = await getSettings();
  const org = coalesceWithEnv(orgSettings);
  const invoiceNumber = `LR-DRAFT-${booking.id.slice(0, 8).toUpperCase()}`;
  const invoiceDate = new Date().toLocaleDateString("ru-RU");

  let lines: InvoiceLine[];
  let subtotal: string;
  let discountPercent: string | null = null;
  let discountAmount: string | null = null;
  let totalAfterDiscount: string;

  const mainEstimate = booking.estimates?.find((e) => e.kind === "MAIN");
  if (mainEstimate) {
    lines = mainEstimate.lines.map((l, i) => ({
      index: i + 1,
      name: l.nameSnapshot,
      quantity: l.quantity,
      unitPrice: l.unitPrice.toString(),
      lineSum: l.lineSum.toString(),
    }));
    subtotal = mainEstimate.subtotal.toString();
    if (mainEstimate.discountPercent && new Decimal(mainEstimate.discountPercent.toString()).greaterThan(0)) {
      discountPercent = mainEstimate.discountPercent.toString();
      discountAmount = mainEstimate.discountAmount.toString();
    }
    totalAfterDiscount = mainEstimate.totalAfterDiscount.toString();
  } else {
    lines = booking.items.map((item, i) => {
      const rate = item.equipment?.rentalRatePerShift ?? new Decimal(0);
      const lineSum = new Decimal(rate.toString()).mul(item.quantity);
      return {
        index: i + 1,
        name: item.equipment?.name ?? item.customName ?? "—",
        quantity: item.quantity,
        unitPrice: rate.toString(),
        lineSum: lineSum.toString(),
      };
    });
    subtotal = booking.finalAmount.toString();
    totalAfterDiscount = booking.finalAmount.toString();
  }

  return renderInvoicePdf(
    { invoiceNumber, invoiceDate, clientName: booking.client.name, lines, subtotal, discountPercent, discountAmount, totalAfterDiscount },
    org,
  );
}

/**
 * Builds and renders the booking's act PDF.
 * Requires the booking to exist (caller must have verified ownership, status=RETURNED, and zero debt).
 * Returns a PDF buffer.
 */
export async function buildBookingActPdf(bookingId: string): Promise<Buffer> {
  const booking = await prisma.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: {
      client: true,
      estimates: { include: { lines: true } },
      items: { include: { equipment: true } },
    },
  });

  const orgSettings = await getSettings();
  const org = coalesceWithEnv(orgSettings);
  const actNumber = `LR-ACT-${booking.id.slice(0, 8).toUpperCase()}`;
  const actDate = new Date().toLocaleDateString("ru-RU");

  let actLines: ActLine[];
  let totalAmount: string;

  const mainEstimate = booking.estimates?.find((e) => e.kind === "MAIN");
  if (mainEstimate) {
    actLines = mainEstimate.lines.map((l, i) => ({
      index: i + 1,
      name: l.nameSnapshot,
      quantity: l.quantity,
      unitPrice: l.unitPrice.toString(),
      lineSum: l.lineSum.toString(),
    }));
    totalAmount = mainEstimate.totalAfterDiscount.toString();
  } else {
    actLines = booking.items.map((item, i) => {
      const rate = item.equipment?.rentalRatePerShift ?? new Decimal(0);
      const lineSum = new Decimal(rate.toString()).mul(item.quantity);
      return {
        index: i + 1,
        name: item.equipment?.name ?? item.customName ?? "—",
        quantity: item.quantity,
        unitPrice: rate.toString(),
        lineSum: lineSum.toString(),
      };
    });
    totalAmount = booking.finalAmount.toString();
  }

  return renderActPdf(
    { actNumber, actDate, clientName: booking.client.name, lines: actLines, totalAmount },
    org,
  );
}
