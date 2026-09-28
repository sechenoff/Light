import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

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
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    equipmentUnit: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    // Мок не поспевал за фичей пробега (2026-05-24): RETURN-ветка перед
    // транзакцией читает bookingVehicle.findMany (проверка обязательного пробега).
    bookingVehicle: {
      findMany: vi.fn(),
    },
    projectLot: { findMany: vi.fn() },
    projectLotUnit: { count: vi.fn() },
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
    db.booking.findUnique.mockResolvedValue({ id: "b1", status: "DRAFT", deletedAt: null });

    await expect(createSession("b1", "Иван", "ISSUE")).rejects.toMatchObject({
      status: 409,
      code: "BOOKING_WRONG_STATUS",
      message: "Выдать можно только подтверждённую бронь",
    });
  });

  it("rejects ISSUE on an already issued booking with a hint about «+ Добор»", async () => {
    const { createSession } = await getSvc();
    const db = await getPrisma();
    db.booking.findUnique.mockResolvedValue({ id: "b1", status: "ISSUED", deletedAt: null });

    await expect(createSession("b1", "Иван", "ISSUE")).rejects.toThrow(/«\+ Добор»/);
  });

  it("rejects ISSUE on an archived booking", async () => {
    const { createSession } = await getSvc();
    const db = await getPrisma();
    db.booking.findUnique.mockResolvedValue({ id: "b1", status: "CONFIRMED", deletedAt: new Date() });

    await expect(createSession("b1", "Иван", "ISSUE")).rejects.toMatchObject({ code: "BOOKING_ARCHIVED" });
  });

  it("rejects RETURN when booking is not ISSUED", async () => {
    const { createSession } = await getSvc();
    const db = await getPrisma();
    db.booking.findUnique.mockResolvedValue({ id: "b1", status: "CONFIRMED", deletedAt: null });

    await expect(createSession("b1", "Иван", "RETURN")).rejects.toMatchObject({
      status: 409,
      code: "BOOKING_WRONG_STATUS",
      message: "Принять можно только выданную бронь",
    });
  });

  it("returns the existing ACTIVE session instead of throwing (idempotent re-open)", async () => {
    // Real scenario: warehouse worker started, closed the tab, came back →
    // tapping the same booking must REUSE the existing session, not blow up
    // with «Уже существует…» which the global error handler mapped to a 500
    // «Внутренняя ошибка сервера» and silently broke the UI.
    const { createSession } = await getSvc();
    const db = await getPrisma();
    db.booking.findUnique.mockResolvedValue({ id: "b1", status: "CONFIRMED", deletedAt: null });
    db.scanSession.findMany.mockResolvedValue([]);
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
    // Существующая сессия возвращается с resumed=true — киоск по этому флагу
    // показывает плашку «Продолжена незавершённая сессия».
    expect(out).toEqual({ ...existing, hasDraft: false, resumed: true, closedStaleSessionIds: [] });
    // create MUST NOT be invoked when an ACTIVE session already exists.
    expect(db.scanSession.create).not.toHaveBeenCalled();
  });

  it("creates and returns session for valid ISSUE booking", async () => {
    const { createSession } = await getSvc();
    const db = await getPrisma();
    db.booking.findUnique.mockResolvedValue({ id: "b1", status: "CONFIRMED", deletedAt: null });
    db.scanSession.findMany.mockResolvedValue([]);
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
    expect(result).toEqual({ ...mockSession, hasDraft: false, resumed: false, closedStaleSessionIds: [] });
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
    db.booking.findUnique.mockResolvedValue({ id: "b1", status: "ISSUED", deletedAt: null });
    db.scanSession.findMany.mockResolvedValue([]);
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
    expect(result).toEqual({ ...mockSession, hasDraft: false, resumed: false, closedStaleSessionIds: [] });
  });
});

// ─────────────────────────────────────────────
// 5.3 completeSession / 5.4 cancelSession
//
// Проверяются на настоящей SQLite, а не моками: захват сессии, транзакции и
// аудит моками не воспроизводятся — scanSessionLifecycle.test.ts,
// warehouseKioskAudit.test.ts, warehouseScanUnitKiosk.test.ts.
// ─────────────────────────────────────────────

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
