/**
 * PDF-отчёт по дебиторской задолженности клиента.
 * Паттерн: async Promise<Buffer> с await на event "end" — идентично invoice/act.
 */

import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import type { OrganizationSettings } from "@prisma/client";
import Decimal from "decimal.js";

// ── Типы ──────────────────────────────────────────────────────────────────────

export interface DebtReportBooking {
  bookingId: string;
  startDate: Date | null;
  endDate: Date | null;
  projectName: string;
  finalAmount: Decimal;
  amountPaid: Decimal;
  amountOutstanding: Decimal;
  expectedPaymentDate: Date | null;
  daysOverdue: number;
  paymentStatus: string;
}

export interface ClientDebtReportInput {
  client: {
    id: string;
    name: string;
    phone?: string | null;
    email?: string | null;
  };
  bookings: DebtReportBooking[];
  organization: OrganizationSettings;
  generatedAt: Date;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const COLORS = {
  ink: "#0f172a",
  muted: "#64748b",
  border: "#cbd5e1",
  headerBg: "#f1f5f9",
  sectionBg: "#e2e8f0",
  rose: "#e11d48",
  amber: "#d97706",
};

type FontSet = { body: string; bold: string };

function apiPackageRoot(): string {
  // __dirname = .../apps/api/src/services/documentExport/clientDebtReport
  // 4 levels up: clientDebtReport → documentExport → services → src → api → apps/api
  return path.resolve(__dirname, "..", "..", "..", "..");
}

function bundledDejaVuPaths(): { regular: string; bold: string } | null {
  const root = apiPackageRoot();
  const regular = path.join(root, "assets", "fonts", "DejaVuSans.ttf");
  const bold = path.join(root, "assets", "fonts", "DejaVuSans-Bold.ttf");
  if (fs.existsSync(regular) && fs.existsSync(bold)) return { regular, bold };
  if (fs.existsSync(regular)) return { regular, bold: regular };
  return null;
}

function resolveFonts(pdfDoc: InstanceType<typeof PDFDocument>): FontSet {
  const ttf = process.env.SMETA_PDF_FONT_TTF?.trim();
  const boldTtf = process.env.SMETA_PDF_FONT_BOLD_TTF?.trim();
  if (ttf && fs.existsSync(ttf)) {
    pdfDoc.registerFont("DebtBody", ttf);
    const boldPath = boldTtf && fs.existsSync(boldTtf) ? boldTtf : ttf;
    pdfDoc.registerFont("DebtBold", boldPath);
    return { body: "DebtBody", bold: "DebtBold" };
  }
  const bundled = bundledDejaVuPaths();
  if (bundled) {
    pdfDoc.registerFont("DebtBody", bundled.regular);
    pdfDoc.registerFont("DebtBold", bundled.bold);
    return { body: "DebtBody", bold: "DebtBold" };
  }
  return { body: "Helvetica", bold: "Helvetica-Bold" };
}

const rubFormatter = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatRub(value: Decimal): string {
  return `${rubFormatter.format(Number(value.toFixed(2)))} ₽`;
}

const RU_MONTHS = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

function formatDateRu(d: Date): string {
  return `${d.getDate()} ${RU_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Ключ группировки: «YYYY-MM-DD» или пустая строка для «без даты» */
function dayKey(d: Date | null): string {
  if (!d) return "";
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function paymentStatusLabel(paymentStatus: string, daysOverdue: number): string {
  if (daysOverdue > 0) return `Просрочено ${daysOverdue} дн`;
  switch (paymentStatus) {
    case "PARTIALLY_PAID": return "Частично";
    case "NOT_PAID": return "Открыт";
    case "PAID": return "Оплачено";
    case "OVERDUE": return "Просрочено";
    default: return paymentStatus;
  }
}

// ── Рендер ────────────────────────────────────────────────────────────────────

export function renderClientDebtReportPdf(input: ClientDebtReportInput): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const pdfDoc = new PDFDocument({ size: "A4", margin: 44, autoFirstPage: true });
    const fonts = resolveFonts(pdfDoc);

    pdfDoc.on("data", (chunk: Buffer) => chunks.push(chunk));
    pdfDoc.on("end", () => resolve(Buffer.concat(chunks)));
    pdfDoc.on("error", reject);

    const margin = 44;
    const pageWidth = 595.28;
    const contentW = pageWidth - margin * 2;
    let y = margin;

    const { client, bookings, organization, generatedAt } = input;
    const org = organization;

    // Короткий ID отчёта из timestamp
    const reportId = `#R-${generatedAt.getTime().toString(36).toUpperCase().slice(-6)}`;

    // ── Шапка ─────────────────────────────────────────────────────────────────

    // Левая колонка — реквизиты организации
    const orgName = (org.legalName && org.legalName.trim()) ? org.legalName.trim() : "Light Rental";
    const orgInn = org.inn ? `ИНН ${org.inn}` : "";
    const orgKpp = org.kpp ? ` КПП ${org.kpp}` : "";
    const orgPhone = org.phone ?? "";
    const orgAddress = org.address ?? "";

    pdfDoc.font(fonts.bold).fontSize(11).fillColor(COLORS.ink)
      .text(orgName, margin, y, { width: contentW * 0.5 });
    y += 15;
    if (orgInn || orgKpp) {
      pdfDoc.font(fonts.body).fontSize(8).fillColor(COLORS.muted)
        .text(`${orgInn}${orgKpp}`, margin, y, { width: contentW * 0.5 });
      y += 12;
    }
    if (orgPhone) {
      pdfDoc.font(fonts.body).fontSize(8).fillColor(COLORS.muted)
        .text(orgPhone, margin, y, { width: contentW * 0.5 });
      y += 12;
    }
    if (orgAddress) {
      pdfDoc.font(fonts.body).fontSize(8).fillColor(COLORS.muted)
        .text(orgAddress, margin, y, { width: contentW * 0.5, lineBreak: false, ellipsis: true });
      y += 12;
    }

    // Правая колонка — название отчёта и дата (абсолютное позиционирование)
    const rightX = margin + contentW * 0.52;
    const rightW = contentW * 0.48;
    pdfDoc.font(fonts.bold).fontSize(14).fillColor(COLORS.ink)
      .text("Отчёт по дебиторке", rightX, margin, { width: rightW, align: "right" });
    pdfDoc.font(fonts.body).fontSize(8.5).fillColor(COLORS.muted)
      .text(`Сформировано: ${formatDateRu(generatedAt)}`, rightX, margin + 18, { width: rightW, align: "right" });
    pdfDoc.font(fonts.body).fontSize(8.5).fillColor(COLORS.muted)
      .text(reportId, rightX, margin + 30, { width: rightW, align: "right" });

    y = Math.max(y, margin + 44) + 10;

    // Разделитель
    pdfDoc.save()
      .moveTo(margin, y).lineTo(margin + contentW, y)
      .strokeColor(COLORS.border).lineWidth(0.5).stroke()
      .restore();
    y += 10;

    // ── Секция клиента ────────────────────────────────────────────────────────

    pdfDoc.font(fonts.bold).fontSize(10).fillColor(COLORS.ink)
      .text("Клиент", margin, y, { width: contentW });
    y += 14;
    pdfDoc.font(fonts.bold).fontSize(11).fillColor(COLORS.ink)
      .text(client.name, margin, y, { width: contentW });
    y += 14;
    if (client.phone) {
      pdfDoc.font(fonts.body).fontSize(9).fillColor(COLORS.muted)
        .text(`Тел.: ${client.phone}`, margin, y, { width: contentW });
      y += 13;
    }
    if (client.email) {
      pdfDoc.font(fonts.body).fontSize(9).fillColor(COLORS.muted)
        .text(`Email: ${client.email}`, margin, y, { width: contentW });
      y += 13;
    }

    y += 8;

    // ── Пустое состояние ──────────────────────────────────────────────────────

    if (bookings.length === 0) {
      pdfDoc.save()
        .moveTo(margin, y).lineTo(margin + contentW, y)
        .strokeColor(COLORS.border).lineWidth(0.5).stroke()
        .restore();
      y += 14;
      pdfDoc.font(fonts.body).fontSize(11).fillColor(COLORS.muted)
        .text("У клиента нет открытых долгов на текущий момент", margin, y, {
          width: contentW,
          align: "center",
        });

      addFooter();
      pdfDoc.end();
      return;
    }

    // ── Группировка броней по дате ─────────────────────────────────────────────

    // Группируем по dayKey, сортируем desc (пустая дата = вершина)
    const grouped = new Map<string, DebtReportBooking[]>();
    for (const b of bookings) {
      const k = dayKey(b.startDate);
      if (!grouped.has(k)) grouped.set(k, []);
      grouped.get(k)!.push(b);
    }

    // Порядок ключей: пустая строка ("без даты") первой, затем по убыванию даты
    const sortedKeys = Array.from(grouped.keys()).sort((a, b) => {
      if (a === "" && b === "") return 0;
      if (a === "") return -1;
      if (b === "") return 1;
      return b.localeCompare(a); // desc
    });

    // Колонки таблицы
    const COL = {
      num: 24,
      project: 155,
      total: 72,
      paid: 72,
      outstanding: 80,
      status: 82,
    };
    const totalColW = COL.num + COL.project + COL.total + COL.paid + COL.outstanding + COL.status;
    // centre the table if content is narrower than page content width
    const tableX = margin + Math.max(0, (contentW - totalColW) / 2);

    function ensureSpace(extra: number) {
      const bottom = pdfDoc.page.height - margin - 40; // 40 for footer
      if (y + extra > bottom) {
        pdfDoc.addPage();
        y = margin;
      }
    }

    function drawTableHeader() {
      ensureSpace(20);
      const headers: [string, number][] = [
        ["№", COL.num],
        ["Проект", COL.project],
        ["Итого", COL.total],
        ["Получено", COL.paid],
        ["К получению", COL.outstanding],
        ["Статус", COL.status],
      ];
      pdfDoc.save()
        .rect(tableX, y, totalColW, 18).fill(COLORS.sectionBg)
        .restore();
      let cx = tableX;
      pdfDoc.font(fonts.bold).fontSize(7.5).fillColor(COLORS.ink);
      for (const [h, w] of headers) {
        pdfDoc.text(h, cx + 3, y + 5, { width: w - 6, lineBreak: false, ellipsis: true });
        cx += w;
      }
      y += 18;
    }

    for (const key of sortedKeys) {
      const group = grouped.get(key)!;
      const firstDate = group[0].startDate;

      ensureSpace(28 + group.length * 26);

      // Заголовок дня
      pdfDoc.save()
        .rect(margin, y, contentW, 20).fill(COLORS.headerBg)
        .restore();

      const dayLabel = key === ""
        ? "Без даты проекта"
        : `${firstDate ? formatDateRu(firstDate) : key}`;

      pdfDoc.font(fonts.bold).fontSize(9.5).fillColor(COLORS.ink)
        .text(dayLabel, margin + 6, y + 5, { width: contentW - 12 });
      y += 20;

      // Таблица-шапка
      drawTableHeader();

      // Строки броней
      for (const b of group) {
        ensureSpace(26);
        const isOverdue = b.daysOverdue > 0;
        const rowH = 24;

        // alternating subtle bg
        pdfDoc.save()
          .moveTo(tableX, y).lineTo(tableX + totalColW, y)
          .strokeColor(COLORS.border).lineWidth(0.3).stroke()
          .restore();

        // № брони (последние 6 символов CUID)
        const shortId = b.bookingId.slice(-6).toUpperCase();

        const cells: [string, number, string, boolean][] = [
          [shortId, COL.num, COLORS.muted, false],
          [b.projectName, COL.project, COLORS.ink, false],
          [formatRub(b.finalAmount), COL.total, COLORS.muted, false],
          [b.amountPaid.greaterThan(0) ? formatRub(b.amountPaid) : "—", COL.paid, COLORS.muted, false],
          [formatRub(b.amountOutstanding), COL.outstanding, isOverdue ? COLORS.rose : COLORS.ink, true],
          [paymentStatusLabel(b.paymentStatus, b.daysOverdue), COL.status, isOverdue ? COLORS.rose : COLORS.amber, false],
        ];

        let cx = tableX;
        for (const [text, w, color, bold] of cells) {
          pdfDoc.font(bold ? fonts.bold : fonts.body).fontSize(8).fillColor(color)
            .text(text, cx + 3, y + 7, { width: w - 6, lineBreak: false, ellipsis: true });
          cx += w;
        }
        y += rowH;
      }

      y += 8;
    }

    // ── Итоги ─────────────────────────────────────────────────────────────────

    const totalBookings = bookings.length;
    const totalFinalAmount = bookings.reduce((s, b) => s.add(b.finalAmount), new Decimal(0));
    const totalPaid = bookings.reduce((s, b) => s.add(b.amountPaid), new Decimal(0));
    const totalOutstanding = bookings.reduce((s, b) => s.add(b.amountOutstanding), new Decimal(0));
    const overdueBookings = bookings.filter((b) => b.daysOverdue >= 7);
    const overdueOutstanding = overdueBookings.reduce((s, b) => s.add(b.amountOutstanding), new Decimal(0));

    ensureSpace(80);

    pdfDoc.save()
      .moveTo(margin, y).lineTo(margin + contentW, y)
      .strokeColor(COLORS.border).lineWidth(0.8).stroke()
      .restore();
    y += 10;

    // Строка-аннотация
    pdfDoc.font(fonts.body).fontSize(9).fillColor(COLORS.muted)
      .text(
        `Всего броней: ${totalBookings}  ·  Сумма броней: ${formatRub(totalFinalAmount)}  ·  Получено: ${formatRub(totalPaid)}`,
        margin,
        y,
        { width: contentW },
      );
    y += 15;

    // Большая итоговая строка
    const rubColor = totalOutstanding.greaterThan(0) ? COLORS.rose : COLORS.ink;
    pdfDoc.font(fonts.bold).fontSize(13).fillColor(rubColor)
      .text(`Общая задолженность: ${formatRub(totalOutstanding)}`, margin, y, { width: contentW });
    y += 19;

    if (overdueBookings.length > 0) {
      pdfDoc.font(fonts.body).fontSize(9).fillColor(COLORS.rose)
        .text(
          `Просрочено ≥ 7 дней: ${overdueBookings.length} ${overdueBookings.length === 1 ? "бронь" : overdueBookings.length <= 4 ? "брони" : "броней"} на сумму ${formatRub(overdueOutstanding)}`,
          margin,
          y,
          { width: contentW },
        );
      y += 15;
    }

    // ── Футер ─────────────────────────────────────────────────────────────────
    addFooter();

    pdfDoc.end();

    function addFooter() {
      const footerY = pdfDoc.page.height - margin;
      pdfDoc.save()
        .moveTo(margin, footerY - 14).lineTo(margin + contentW, footerY - 14)
        .strokeColor(COLORS.border).lineWidth(0.5).stroke()
        .restore();
      pdfDoc.font(fonts.body).fontSize(7.5).fillColor(COLORS.muted)
        .text(
          `Документ сформирован системой Light Rental ${formatDateRu(generatedAt)} · только для внутреннего использования`,
          margin,
          footerY - 8,
          { width: contentW, align: "center" },
        );
    }
  });
}
