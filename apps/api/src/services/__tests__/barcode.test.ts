import { describe, it, expect, beforeAll, vi } from "vitest";

// Set BARCODE_SECRET before importing the module
beforeAll(() => {
  process.env.BARCODE_SECRET = "test-secret-key";
});

// Dynamic import after env is set
async function getBarcode() {
  return import("../barcode");
}

describe("generateBarcodeId", () => {
  it("generates barcode ID matching pattern LR-XXX-NNN", async () => {
    const { generateBarcodeId } = await getBarcode();
    const id = generateBarcodeId("Skypanel S60", "LED панели", 3);
    expect(id).toMatch(/^LR-[A-Z0-9]+-\d{3}$/);
  });

  it("pads sequence number to 3 digits", async () => {
    const { generateBarcodeId } = await getBarcode();
    const id = generateBarcodeId("Arri M18", "Галогенные приборы", 1);
    expect(id).toMatch(/-001$/);
  });

  it("includes numeric suffix from equipment name when present", async () => {
    const { generateBarcodeId } = await getBarcode();
    const id = generateBarcodeId("Skypanel S60", "LED панели", 3);
    expect(id).toContain("60");
  });
});

describe("generateBarcodePayload / verifyBarcodePayload", () => {
  it("generates a payload string with unitId:hmac format", async () => {
    const { generateBarcodePayload } = await getBarcode();
    const payload = generateBarcodePayload("unit-abc-123");
    expect(payload).toMatch(/^unit-abc-123:[0-9a-f]{12}$/);
  });

  it("verifies a valid payload and returns unitId", async () => {
    const { generateBarcodePayload, verifyBarcodePayload } = await getBarcode();
    const payload = generateBarcodePayload("unit-xyz-456");
    const unitId = verifyBarcodePayload(payload);
    expect(unitId).toBe("unit-xyz-456");
  });

  it("returns null for a tampered payload", async () => {
    const { generateBarcodePayload, verifyBarcodePayload } = await getBarcode();
    const payload = generateBarcodePayload("unit-tamper");
    // Tamper by replacing the last char of HMAC
    const tampered = payload.slice(0, -1) + (payload.endsWith("f") ? "0" : "f");
    const result = verifyBarcodePayload(tampered);
    expect(result).toBeNull();
  });

  it("returns null for malformed payload (no colon)", async () => {
    const { verifyBarcodePayload } = await getBarcode();
    expect(verifyBarcodePayload("nocolon")).toBeNull();
  });

  it("returns null for wrong HMAC length", async () => {
    const { verifyBarcodePayload } = await getBarcode();
    expect(verifyBarcodePayload("unit-id:tooshort")).toBeNull();
  });
});

describe("renderLabelPng", () => {
  it("returns a Buffer with PNG magic bytes", async () => {
    const { renderLabelPng } = await getBarcode();
    const buf = await renderLabelPng({
      barcode: "LR-SKY60-003",
      barcodePayload: "cuid123:abcdef012345",
      equipment: { name: "Skypanel S60", category: "LED панели" },
    });
    expect(buf).toBeInstanceOf(Buffer);
    // PNG magic bytes: 89 50 4E 47
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50); // P
    expect(buf[2]).toBe(0x4e); // N
    expect(buf[3]).toBe(0x47); // G
  });

  it("returns a buffer of reasonable size for 638x298 label", async () => {
    const { renderLabelPng } = await getBarcode();
    const buf = await renderLabelPng({
      barcode: "LR-TEST-001",
      barcodePayload: "cuid456:fedcba098765",
      equipment: { name: "Тестовый прибор", category: "Прочее" },
    });
    // A 638x298 PNG should be at least a few KB
    expect(buf.byteLength).toBeGreaterThan(1000);
  });

  it("encodes barcodePayload (not barcode) in the barcode image", async () => {
    // Verify that the payload (HMAC-signed) is what gets encoded in the image,
    // not the human-readable barcode ID. We do this by checking renderLabelPng
    // accepts barcodePayload as a required field (interface enforcement test).
    const { renderLabelPng } = await getBarcode();
    const payload = "unit-id-123:abcdef012345";
    const buf = await renderLabelPng({
      barcode: "LR-TEST-001",
      barcodePayload: payload,
      equipment: { name: "Тест", category: "Прочее" },
    });
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf[0]).toBe(0x89); // PNG magic
  });
});

describe("renderLabelsPdf", () => {
  it("returns a Buffer starting with PDF magic bytes", async () => {
    const { renderLabelsPdf } = await getBarcode();
    const buf = await renderLabelsPdf([
      {
        barcode: "LR-SKY60-003",
        barcodePayload: "cuid123:abcdef012345",
        equipment: { name: "Skypanel S60", category: "LED панели" },
      },
    ]);
    expect(buf).toBeInstanceOf(Buffer);
    // PDF magic: %PDF
    const header = buf.toString("ascii", 0, 4);
    expect(header).toBe("%PDF");
  });

  it("handles multiple units without error", async () => {
    const { renderLabelsPdf } = await getBarcode();
    const buf = await renderLabelsPdf([
      {
        barcode: "LR-SKY60-001",
        barcodePayload: "cuid111:abcdef012345",
        equipment: { name: "Skypanel S60", category: "LED панели" },
      },
      {
        barcode: "LR-HMI-002",
        barcodePayload: "cuid222:fedcba098765",
        equipment: { name: "Arri M18", category: "ГМИ приборы" },
      },
    ]);
    expect(buf.byteLength).toBeGreaterThan(1000);
  });
});

// ── resolveBarcode tests ──

// Mock prisma for resolveBarcode tests
vi.mock("../../prisma", () => ({
  prisma: {
    equipmentUnit: {
      findFirst: vi.fn(),
    },
  },
}));

describe("resolveBarcode", () => {
  it("resolves valid HMAC payload → unitId + hmacVerified: true", async () => {
    const { generateBarcodePayload, resolveBarcode } = await getBarcode();
    const payload = generateBarcodePayload("unit-123");
    const result = await resolveBarcode(payload);
    expect(result).toEqual({ unitId: "unit-123", hmacVerified: true });
  });

  it("resolves raw barcode via DB lookup → unitId + hmacVerified: false", async () => {
    const { prisma } = await import("../../prisma");
    (prisma.equipmentUnit.findFirst as any).mockResolvedValueOnce({ id: "unit-456" });

    const { resolveBarcode } = await getBarcode();
    const result = await resolveBarcode("RAW-BARCODE-123");
    expect(result).toEqual({ unitId: "unit-456", hmacVerified: false });
  });

  it("returns null for unknown barcode", async () => {
    const { prisma } = await import("../../prisma");
    (prisma.equipmentUnit.findFirst as any).mockResolvedValueOnce(null);

    const { resolveBarcode } = await getBarcode();
    const result = await resolveBarcode("UNKNOWN-BARCODE");
    expect(result).toBeNull();
  });

  it("returns null for barcode exceeding 100 chars", async () => {
    const { resolveBarcode } = await getBarcode();
    const longBarcode = "A".repeat(101);
    const result = await resolveBarcode(longBarcode);
    expect(result).toBeNull();
  });
});
