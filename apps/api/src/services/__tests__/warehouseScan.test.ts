import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import type { ScanSession, ScanRecord, EquipmentUnit, BookingItem, Booking } from "@prisma/client";

// Set env vars before any imports
beforeAll(() => {
  process.env.BARCODE_SECRET = "test-secret-key";
});

// ─────────────────────────────────────────────
// Mock prisma singleton
// ─────────────────────────────────────────────
vi.mock("../../prisma", () => ({
  prisma: {
    booking: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    scanSession: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    equipmentUnit: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    bookingItem: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    bookingItemUnit: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    scanRecord: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

// ─────────────────────────────────────────────
// Dynamic imports after mocks are established
// ─────────────────────────────────────────────
async function getSvc() {
  const mod = await import("../warehouseScan");
  return mod;
}

async function getPrisma() {
  const mod = await import("../../prisma");
  return mod.prisma as any;
}

// ─────────────────────────────────────────────
// Reset mocks before each test
// ─────────────────────────────────────────────
beforeEach(() => {
  vi.resetAllMocks();
});

// ─────────────────────────────────────────────
// 5.1 createSession
// ─────────────────────────────────────────────
describe("createSession", () => {
  it("rejects if booking does not exist", async () => {
    const { createSession } = await getSvc();
    const db = await getPrisma();
    db.booking.findUnique.mockResolvedValue(null);

    await expect(createSession("b1", "Иван", "ISSUE")).rejects.toThrow("Бронь не найдена");
  });

  it("rejects CANCELLED booking", async () => {
    const { createSession } = await getSvc();
    const db = await getPrisma();
    db.booking.findUnique.mockResolvedValue({ id: "b1", status: "CANCELLED" });

    await expect(createSession("b1", "Иван", "ISSUE")).rejects.toThrow("отменена");
  });

  it("rejects ISSUE when booking is not CONFIRMED", async () => {
    const { createSession } = await getSvc();
    const db = await getPrisma();
    db.booking.findUnique.mockResolvedValue({ id: "b1", status: "DRAFT" });

    await expect(createSession("b1", "Иван", "ISSUE")).rejects.toThrow("CONFIRMED");
  });

  it("rejects RETURN when booking is not ISSUED", async () => {
    const { createSession } = await getSvc();
    const db = await getPrisma();
    db.booking.findUnique.mockResolvedValue({ id: "b1", status: "CONFIRMED" });

    await expect(createSession("b1", "Иван", "RETURN")).rejects.toThrow("ISSUED");
  });

  it("returns the existing ACTIVE session instead of throwing (idempotent re-open)", async () => {
    // Real scenario: warehouse worker started, closed the tab, came back →
    // tapping the same booking must REUSE the existing session, not blow up
    // with «Уже существует…» which the global error handler mapped to a 500
    // «Внутренняя ошибка сервера» and silently broke the UI.
    const { createSession } = await getSvc();
    const db = await getPrisma();
    db.booking.findUnique.mockResolvedValue({ id: "b1", status: "CONFIRMED" });
    const existing = {
      id: "s1",
      bookingId: "b1",
      operation: "ISSUE",
      status: "ACTIVE",
      workerName: "Алена",
    };
    db.scanSession.findFirst.mockResolvedValue(existing);
    db.$transaction.mockImplementation(async (fn: any) => fn(db));

    const out = await createSession("b1", "Борис", "ISSUE");
    expect(out).toEqual(existing);
    // create MUST NOT be invoked when an ACTIVE session already exists.
    expect(db.scanSession.create).not.toHaveBeenCalled();
  });

  it("creates and returns session for valid ISSUE booking", async () => {
    const { createSession } = await getSvc();
    const db = await getPrisma();
    db.booking.findUnique.mockResolvedValue({ id: "b1", status: "CONFIRMED" });
    db.scanSession.findFirst.mockResolvedValue(null);

    const mockSession = {
      id: "sess-1",
      bookingId: "b1",
      workerName: "Иван",
      operation: "ISSUE",
      status: "ACTIVE",
      startedAt: new Date(),
    };
    db.scanSession.create.mockResolvedValue(mockSession);
    db.$transaction.mockImplementation(async (fn: any) => fn(db));

    const result = await createSession("b1", "Иван", "ISSUE");
    expect(result).toEqual(mockSession);
    expect(db.scanSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          bookingId: "b1",
          workerName: "Иван",
          operation: "ISSUE",
          status: "ACTIVE",
        }),
      }),
    );
  });

  it("creates session for valid RETURN booking", async () => {
    const { createSession } = await getSvc();
    const db = await getPrisma();
    db.booking.findUnique.mockResolvedValue({ id: "b1", status: "ISSUED" });
    db.scanSession.findFirst.mockResolvedValue(null);

    const mockSession = {
      id: "sess-2",
      bookingId: "b1",
      workerName: "Петр",
      operation: "RETURN",
      status: "ACTIVE",
      startedAt: new Date(),
    };
    db.scanSession.create.mockResolvedValue(mockSession);
    db.$transaction.mockImplementation(async (fn: any) => fn(db));

    const result = await createSession("b1", "Петр", "RETURN");
    expect(result).toEqual(mockSession);
  });
});

// ─────────────────────────────────────────────
// 5.3 completeSession
// ─────────────────────────────────────────────
describe("completeSession", () => {
  it("rejects if session is not ACTIVE", async () => {
    const { completeSession } = await getSvc();
    const db = await getPrisma();
    db.scanSession.findUnique.mockResolvedValue({
      id: "s1",
      status: "COMPLETED",
      bookingId: "b1",
      operation: "ISSUE",
      booking: { status: "CONFIRMED" },
      scans: [],
    });

    await expect(completeSession("s1")).rejects.toThrow("активной");
  });

  it("rejects if booking is CANCELLED", async () => {
    const { completeSession } = await getSvc();
    const db = await getPrisma();
    db.scanSession.findUnique.mockResolvedValue({
      id: "s1",
      status: "ACTIVE",
      bookingId: "b1",
      operation: "ISSUE",
      booking: { status: "CANCELLED" },
      scans: [],
    });

    await expect(completeSession("s1")).rejects.toThrow("отменена");
  });

  it("completes ISSUE session: sets units to ISSUED, creates BookingItemUnit, returns summary", async () => {
    const { completeSession } = await getSvc();
    const db = await getPrisma();

    const scannedUnitId = "unit-1";
    const session = {
      id: "s1",
      status: "ACTIVE",
      bookingId: "b1",
      operation: "ISSUE",
      booking: { status: "CONFIRMED" },
      scans: [
        {
          id: "sr-1",
          equipmentUnitId: scannedUnitId,
          equipmentUnit: { id: scannedUnitId, equipmentId: "eq-1" },
        },
      ],
    };
    db.scanSession.findUnique.mockResolvedValue(session);

    db.bookingItem.findMany.mockResolvedValue([
      { id: "bi-1", equipmentId: "eq-1", quantity: 1 },
    ]);

    // Reserved units (BookingItemUnit) — same unit is reserved
    db.bookingItemUnit.findMany.mockResolvedValue([
      { id: "biu-1", bookingItemId: "bi-1", equipmentUnitId: scannedUnitId },
    ]);

    // Transaction mock: execute the callback
    db.$transaction.mockImplementation(async (fn: any) => fn(db));

    // Unit update and session update mocks
    db.equipmentUnit.update.mockResolvedValue({});
    db.bookingItemUnit.create.mockResolvedValue({});
    db.bookingItemUnit.delete.mockResolvedValue({});
    db.scanSession.update.mockResolvedValue({
      id: "s1",
      status: "COMPLETED",
      completedAt: new Date(),
    });

    const result = await completeSession("s1");
    expect(result).toMatchObject({
      scanned: 1,
      expected: 1,
      missing: [],
      substituted: [],
    });
  });

  it("completes RETURN session: reverts unit status, sets returnedAt, flags missing", async () => {
    const { completeSession } = await getSvc();
    const db = await getPrisma();

    const scannedUnitId = "unit-1";
    const notScannedUnitId = "unit-2";

    const session = {
      id: "s1",
      status: "ACTIVE",
      bookingId: "b1",
      operation: "RETURN",
      booking: { status: "ISSUED" },
      scans: [
        {
          id: "sr-1",
          equipmentUnitId: scannedUnitId,
          equipmentUnit: { id: scannedUnitId, equipmentId: "eq-1" },
        },
      ],
    };
    db.scanSession.findUnique.mockResolvedValue(session);

    db.bookingItem.findMany.mockResolvedValue([
      { id: "bi-1", equipmentId: "eq-1", quantity: 2 },
    ]);

    // Both units were issued
    db.bookingItemUnit.findMany.mockResolvedValue([
      {
        id: "biu-1",
        bookingItemId: "bi-1",
        equipmentUnitId: scannedUnitId,
        equipmentUnit: { id: scannedUnitId },
      },
      {
        id: "biu-2",
        bookingItemId: "bi-1",
        equipmentUnitId: notScannedUnitId,
        equipmentUnit: { id: notScannedUnitId },
      },
    ]);

    db.$transaction.mockImplementation(async (fn: any) => fn(db));
    db.equipmentUnit.update.mockResolvedValue({});
    db.bookingItemUnit.update.mockResolvedValue({});
    db.scanSession.update.mockResolvedValue({ id: "s1", status: "COMPLETED" });

    const result = await completeSession("s1");
    expect(result.scanned).toBe(1);
    expect(result.expected).toBe(2);
    expect(result.missing).toContain(notScannedUnitId);
    expect(result.substituted).toEqual([]);
  });
});

// ─────────────────────────────────────────────
// 5.4 cancelSession
// ─────────────────────────────────────────────
describe("cancelSession", () => {
  it("rejects if session is not ACTIVE", async () => {
    const { cancelSession } = await getSvc();
    const db = await getPrisma();
    db.scanSession.findUnique.mockResolvedValue({ id: "s1", status: "COMPLETED" });

    await expect(cancelSession("s1")).rejects.toThrow("активной");
  });

  it("sets session status to CANCELLED without touching units", async () => {
    const { cancelSession } = await getSvc();
    const db = await getPrisma();
    db.scanSession.findUnique.mockResolvedValue({ id: "s1", status: "ACTIVE" });
    db.scanSession.update.mockResolvedValue({ id: "s1", status: "CANCELLED" });

    const result = await cancelSession("s1");
    expect(result.status).toBe("CANCELLED");
    expect(db.equipmentUnit.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// 5.5 getSessionWithDetails
// ─────────────────────────────────────────────
describe("getSessionWithDetails", () => {
  it("returns session with COUNT items flagged as trackingMode COUNT", async () => {
    const { getSessionWithDetails } = await getSvc();
    const db = await getPrisma();

    db.scanSession.findUnique.mockResolvedValue({
      id: "s1",
      bookingId: "b1",
      operation: "ISSUE",
      status: "ACTIVE",
      workerName: "Иван",
      startedAt: new Date(),
      completedAt: null,
      scans: [],
    });

    db.bookingItem.findMany.mockResolvedValue([
      {
        id: "bi-1",
        equipmentId: "eq-1",
        quantity: 3,
        equipment: { id: "eq-1", name: "Фоновый свет", stockTrackingMode: "COUNT" },
        unitReservations: [],
      },
    ]);

    const result = await getSessionWithDetails("s1");
    expect(result.bookingItems[0]).toMatchObject({ trackingMode: "COUNT" });
  });

  it("returns session with UNIT items having expected and scanned counts", async () => {
    const { getSessionWithDetails } = await getSvc();
    const db = await getPrisma();

    db.scanSession.findUnique.mockResolvedValue({
      id: "s1",
      bookingId: "b1",
      operation: "ISSUE",
      status: "ACTIVE",
      workerName: "Иван",
      startedAt: new Date(),
      completedAt: null,
      scans: [
        {
          id: "sr-1",
          equipmentUnitId: "unit-1",
          scannedAt: new Date(),
          equipmentUnit: { id: "unit-1", equipmentId: "eq-1", equipment: { name: "Arri M18" } },
        },
      ],
    });

    db.bookingItem.findMany.mockResolvedValue([
      {
        id: "bi-1",
        equipmentId: "eq-1",
        quantity: 2,
        equipment: { id: "eq-1", name: "Arri M18", stockTrackingMode: "UNIT" },
        unitReservations: [
          { id: "biu-1", equipmentUnitId: "unit-1" },
          { id: "biu-2", equipmentUnitId: "unit-2" },
        ],
      },
    ]);

    const result = await getSessionWithDetails("s1");
    const item = result.bookingItems[0];
    expect(item.trackingMode).toBe("UNIT");
    expect(item.expected).toBe(2);
    expect(item.scanned).toBe(1);
  });

  it("flags reservedButUnavailable units for ISSUE sessions", async () => {
    const { getSessionWithDetails } = await getSvc();
    const db = await getPrisma();

    db.scanSession.findUnique.mockResolvedValue({
      id: "s1",
      bookingId: "b1",
      operation: "ISSUE",
      status: "ACTIVE",
      workerName: "Иван",
      startedAt: new Date(),
      completedAt: null,
      scans: [],
    });

    db.bookingItem.findMany.mockResolvedValue([
      {
        id: "bi-1",
        equipmentId: "eq-1",
        quantity: 1,
        equipment: { id: "eq-1", name: "Arri M18", stockTrackingMode: "UNIT" },
        unitReservations: [
          {
            id: "biu-1",
            equipmentUnitId: "unit-1",
            equipmentUnit: { id: "unit-1", status: "MAINTENANCE" },
          },
        ],
      },
    ]);

    const result = await getSessionWithDetails("s1");
    expect(result.bookingItems[0].reservedButUnavailable).toEqual(["unit-1"]);
  });
});
