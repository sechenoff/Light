import path from "path";
import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";
import { HttpError } from "../utils/errors";
import { projectDetail } from "./bookingProjects";
import type { ProjectPriceLine } from "./projectPricing";

export async function exportProjectDocument(
  bookingId: string,
  documentId: string,
  format: "pdf" | "xlsx",
): Promise<Buffer> {
  const p = await projectDetail(bookingId);
  const period =
    documentId === "forecast"
      ? null
      : p.periods.find((x) => x.id === documentId);
  if (documentId !== "forecast" && !period)
    throw new HttpError(404, "Документ не найден");
  const lines: ProjectPriceLine[] = period
    ? JSON.parse(period.linesJson)
    : p.forecast.lines;
  const amount = period?.amount.toString() ?? p.forecast.total;
  const title = period
    ? period.kind === "CORRECTION"
      ? "Корректировка начислений"
      : `Счёт за период ${period.invoice?.number ?? ""}`
    : "Предварительная смета проекта";
  const snapshot = period ? JSON.parse(period.documentJson) : null;
  const description = `${snapshot?.projectName ?? p.booking.projectName} · ${snapshot?.client?.legalName || snapshot?.client?.name || p.booking.client.name}`;
  const seller = snapshot?.seller;
  const legal = seller
    ? [
        seller.legalName,
        seller.inn && `ИНН ${seller.inn}`,
        seller.bankName,
        seller.bankBik && `БИК ${seller.bankBik}`,
        seller.rschet && `Р/с ${seller.rschet}`,
        seller.kschet && `К/с ${seller.kschet}`,
        seller.taxNote,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const dates = `${period?.fromDate ?? p.fromDate} — ${period?.throughDate ?? p.throughDate}`;
  if (format === "xlsx") {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Расчёт проекта");
    ws.addRow([title]);
    ws.addRow([description]);
    ws.addRow([dates]);
    ws.addRow([
      "Оборудование / услуга",
      "Кол-во",
      "С",
      "По (вкл.)",
      "Съёмочные",
      "Выходные",
      "Коэф.",
      "Ставка",
      "Сумма",
    ]);
    for (const l of lines)
      ws.addRow([
        l.name,
        l.quantity,
        l.fromDate,
        l.throughDate,
        l.shootDays ?? "",
        l.restDays ?? "",
        l.restFactor ? Number(l.restFactor) : "",
        l.rate ? Number(l.rate) : "",
        Number(l.amount),
      ]);
    ws.addRow(["Итого", "", "", "", "", "", "", "", Number(amount)]);
    if (legal) ws.addRow([legal]);
    ws.columns.forEach((c, i) => {
      c.width = i === 0 ? 50 : 15;
    });
    ws.getRow(4).font = { bold: true };
    ws.views = [{ state: "frozen", ySplit: 4 }];
    ws.getColumn(8).numFmt = "#,##0.00";
    ws.getColumn(9).numFmt = "#,##0.00";
    ws.pageSetup = {
      paperSize: 9,
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    };
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.font(path.resolve(__dirname, "../../assets/fonts/DejaVuSans.ttf"));
    doc.fontSize(16).text(title);
    doc.moveDown(0.5);
    doc.fontSize(10).text(description).text(dates);
    if (period)
      doc.text(
        `Дата: ${period.createdAt.toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" })} · Оплатить до: ${period.dueDate.toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" })}`,
      );
    doc.moveDown();
    for (const l of lines) {
      if (doc.y > 690) doc.addPage();
      doc
        .fontSize(10)
        .text(
          `${l.name} × ${l.quantity} — ${Number(l.amount).toLocaleString("ru-RU")} ₽`,
        );
      doc
        .fontSize(9)
        .fillColor("#555555")
        .text(
          `${l.fromDate} — ${l.throughDate}${l.rate ? `; ставка ${l.rate} ₽; съёмочных ${l.shootDays ?? 0}, выходных ${l.restDays ?? 0} × ${l.restFactor ?? 0}` : ""}`,
        )
        .fillColor("#000000");
      doc.moveDown(0.7);
    }
    doc.fontSize(13).text(`Итого: ${Number(amount).toLocaleString("ru-RU")} ₽`);
    if (legal) {
      if (doc.y > 660) doc.addPage();
      doc.moveDown();
      doc.fontSize(8).text(legal);
    }
    if (!period)
      doc
        .fontSize(9)
        .text(
          "Прогноз. Итоговые начисления фиксируются при закрытии периодов.",
        );
    doc.end();
  });
}
