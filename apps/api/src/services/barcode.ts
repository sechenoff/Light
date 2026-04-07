/**
 * Сервис штрихкодирования оборудования.
 *
 * Функции:
 * - Генерация ID штрихкода (делегирует в barcodeAbbrev)
 * - HMAC-подпись payload для сканирования
 * - Рендеринг PNG-этикетки (638×298px @ 360 DPI, Brother P750W 45mm×21mm)
 * - Рендеринг PDF с этикетками (45mm×24mm страницы)
 */

import crypto from "crypto";
import bwipjs from "bwip-js";
import sharp from "sharp";
import PDFDocument from "pdfkit";

import { generateBarcodeId as _generateBarcodeId } from "../utils/barcodeAbbrev";

// ──────────────────────────────────────────────
// Типы
// ──────────────────────────────────────────────

export interface LabelUnit {
  barcode: string;
  barcodePayload: string;
  equipment: { name: string; category: string };
}

// ──────────────────────────────────────────────
// Константы
// ──────────────────────────────────────────────

/** Ширина этикетки в пикселях при 360 DPI (45mm). */
const LABEL_W = 638;
/** Высота этикетки в пикселях при 360 DPI (21mm). */
const LABEL_H = 298;

/** Ширина зоны штрихкода внутри этикетки. */
const BARCODE_ZONE_W = 380;
/** Высота зоны штрихкода внутри этикетки. */
const BARCODE_ZONE_H = 220;

// ──────────────────────────────────────────────
// Генерация ID штрихкода
// ──────────────────────────────────────────────

/**
 * Генерирует ID штрихкода в формате `LR-{ABBREV}{NUM}-{SEQ}`.
 * Делегирует логику аббревиации в утилиту barcodeAbbrev.
 */
export function generateBarcodeId(
  equipmentName: string,
  category: string,
  sequenceNum: number,
): string {
  return _generateBarcodeId(equipmentName, category, sequenceNum);
}

// ──────────────────────────────────────────────
// HMAC payload
// ──────────────────────────────────────────────

function getSecret(): string {
  const secret = process.env.BARCODE_SECRET;
  if (!secret) {
    throw new Error("BARCODE_SECRET env var is not set");
  }
  return secret;
}

/**
 * Создаёт HMAC-подписанный payload для единицы оборудования.
 * Формат: `{unitId}:{hmac12hex}` — первые 12 шестнадцатеричных символов HMAC-SHA256.
 */
export function generateBarcodePayload(unitId: string): string {
  const secret = getSecret();
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(unitId)
    .digest("hex")
    .slice(0, 12);
  return `${unitId}:${hmac}`;
}

/**
 * Верифицирует HMAC-подписанный payload.
 * @returns unitId если payload валиден, иначе null.
 */
export function verifyBarcodePayload(payload: string): string | null {
  const colonIdx = payload.indexOf(":");
  if (colonIdx === -1) return null;

  const unitId = payload.slice(0, colonIdx);
  const receivedHmac = payload.slice(colonIdx + 1);

  // HMAC должен быть ровно 12 hex символов
  if (receivedHmac.length !== 12) return null;

  const secret = getSecret();
  const expectedHmac = crypto
    .createHmac("sha256", secret)
    .update(unitId)
    .digest("hex")
    .slice(0, 12);

  // Безопасное сравнение с постоянным временем
  const receivedBuf = Buffer.from(receivedHmac, "hex");
  const expectedBuf = Buffer.from(expectedHmac, "hex");

  if (receivedBuf.length !== expectedBuf.length) return null;

  try {
    if (!crypto.timingSafeEqual(receivedBuf, expectedBuf)) return null;
  } catch {
    return null;
  }

  return unitId;
}

// ──────────────────────────────────────────────
// SVG оверлей с текстом
// ──────────────────────────────────────────────

/**
 * Строит SVG-оверлей с текстовыми данными этикетки.
 * Текст размещается в правой части этикетки (рядом со штрихкодом).
 */
function buildTextOverlaySvg(
  barcodeId: string,
  name: string,
  category: string,
): string {
  const textX = BARCODE_ZONE_W + 20;
  const textW = LABEL_W - textX - 10;

  // Экранируем спецсимволы XML
  const esc = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  return `<svg width="${LABEL_W}" height="${LABEL_H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${LABEL_W}" height="${LABEL_H}" fill="white"/>
  <!-- ID штрихкода -->
  <text
    x="${textX}"
    y="60"
    font-family="Arial, Helvetica, sans-serif"
    font-size="28"
    font-weight="bold"
    fill="#0f172a"
    text-anchor="start"
    dominant-baseline="middle"
  >${esc(barcodeId)}</text>
  <!-- Название прибора -->
  <text
    x="${textX}"
    y="130"
    font-family="Arial, Helvetica, sans-serif"
    font-size="22"
    fill="#0f172a"
    text-anchor="start"
    dominant-baseline="middle"
    textLength="${textW}"
    lengthAdjust="spacingAndGlyphs"
  >${esc(name.length > 22 ? name.slice(0, 22) + "…" : name)}</text>
  <!-- Категория -->
  <text
    x="${textX}"
    y="195"
    font-family="Arial, Helvetica, sans-serif"
    font-size="19"
    fill="#64748b"
    text-anchor="start"
    dominant-baseline="middle"
    textLength="${textW}"
    lengthAdjust="spacingAndGlyphs"
  >${esc(category.length > 24 ? category.slice(0, 24) + "…" : category)}</text>
</svg>`;
}

// ──────────────────────────────────────────────
// Рендеринг PNG-этикетки
// ──────────────────────────────────────────────

/**
 * Рендерит PNG-этикетку для одной единицы оборудования.
 *
 * Размер: 638×298px (45mm×21mm @ 360 DPI).
 * Макет: штрихкод слева, текстовая информация справа.
 *
 * Не использует нативные шрифты — текст через SVG оверлей.
 *
 * @returns Buffer с PNG данными
 */
export async function renderLabelPng(unit: LabelUnit): Promise<Buffer> {
  // 1. Генерируем штрихкод Code128 через bwip-js
  // Кодируем barcodePayload (HMAC-подписанный payload для сканера),
  // а НЕ human-readable barcode ID — иначе сканер получает нечитаемое значение
  const barcodeBuffer = await bwipjs.toBuffer({
    bcid: "code128",
    text: unit.barcodePayload,
    scale: 3,
    height: 18,       // высота в мм (bwip-js единицы)
    includetext: true,
    textxalign: "center",
    backgroundcolor: "FFFFFF",
  });

  // 2. Масштабируем штрихкод до зоны
  const scaledBarcode = await sharp(barcodeBuffer)
    .resize(BARCODE_ZONE_W, BARCODE_ZONE_H, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .png()
    .toBuffer();

  // 3. Строим SVG оверлей с текстом (на весь холст)
  const svgOverlay = buildTextOverlaySvg(unit.barcode, unit.equipment.name, unit.equipment.category);
  const svgBuffer = Buffer.from(svgOverlay);

  // 4. Создаём белый холст и накладываем слои
  const labelBuffer = await sharp({
    create: {
      width: LABEL_W,
      height: LABEL_H,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite([
      // Базовый SVG с текстом (фон + текст)
      { input: svgBuffer, top: 0, left: 0 },
      // Штрихкод поверх (в левой части)
      { input: scaledBarcode, top: Math.floor((LABEL_H - BARCODE_ZONE_H) / 2), left: 10 },
    ])
    .png()
    .toBuffer();

  return labelBuffer;
}

// ──────────────────────────────────────────────
// Рендеринг PDF с этикетками
// ──────────────────────────────────────────────

// Размер страницы Brother P750W: 45mm × 24mm (в пунктах PDF: 1mm ≈ 2.8346 pt)
const MM_TO_PT = 2.8346;
const LABEL_PAGE_W_PT = Math.round(45 * MM_TO_PT); // ~127.6 pt
const LABEL_PAGE_H_PT = Math.round(24 * MM_TO_PT); // ~68.0 pt

/**
 * Рендерит PDF с этикетками для множества единиц оборудования.
 *
 * Каждая единица занимает отдельную страницу (45mm × 24mm для Brother P750W).
 * PNG-этикетки вставляются в PDF как изображения.
 *
 * @returns Buffer с PDF данными
 */
export async function renderLabelsPdf(units: LabelUnit[]): Promise<Buffer> {
  // Рендерим все PNG параллельно
  const pngs = await Promise.all(units.map((u) => renderLabelPng(u)));

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];

    const doc = new PDFDocument({
      size: [LABEL_PAGE_W_PT, LABEL_PAGE_H_PT],
      margin: 0,
      autoFirstPage: false,
    });

    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    pngs.forEach((png, i) => {
      doc.addPage({ size: [LABEL_PAGE_W_PT, LABEL_PAGE_H_PT], margin: 0 });
      doc.image(png, 0, 0, {
        width: LABEL_PAGE_W_PT,
        height: LABEL_PAGE_H_PT,
        fit: [LABEL_PAGE_W_PT, LABEL_PAGE_H_PT],
        align: "center",
        valign: "center",
      });
      void i; // suppress unused warning
    });

    doc.end();
  });
}
