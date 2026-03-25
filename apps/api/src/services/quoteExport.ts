import type { QuoteLine } from "./bookings";

export type QuoteExportPayload = {
  clientName: string;
  projectName: string;
  startDate: Date;
  endDate: Date;
  discountPercent: string;
  shifts: number;
  durationLabel: string;
  subtotal: string;
  discountAmount: string;
  totalAfterDiscount: string;
  comment: string | null;
  lines: QuoteLine[];
};

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildQuoteXml(payload: QuoteExportPayload): string {
  const { lines } = payload;
  const lineEls = lines
    .map(
      (l) => `    <line category="${escapeXml(l.categorySnapshot)}" name="${escapeXml(l.nameSnapshot)}" quantity="${l.quantity}" unitPrice="${escapeXml(l.unitPrice.toString())}" lineSum="${escapeXml(l.lineSum.toString())}" pricingMode="${escapeXml(l.pricingMode)}" />`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<estimate xmlns="https://light-rental.local/schema/estimate/1">
  <meta generated="${escapeXml(new Date().toISOString())}" shifts="${payload.shifts}" />
  <client>${escapeXml(payload.clientName)}</client>
  <project>${escapeXml(payload.projectName)}</project>
  <period start="${escapeXml(payload.startDate.toISOString())}" end="${escapeXml(payload.endDate.toISOString())}" duration="${escapeXml(payload.durationLabel)}" />
  <discount percent="${escapeXml(payload.discountPercent)}" />
  <comment>${payload.comment ? escapeXml(payload.comment) : ""}</comment>
  <lines>
${lineEls}
  </lines>
  <totals subtotal="${escapeXml(payload.subtotal)}" discountAmount="${escapeXml(payload.discountAmount)}" totalAfterDiscount="${escapeXml(payload.totalAfterDiscount)}" />
</estimate>
`;
}
