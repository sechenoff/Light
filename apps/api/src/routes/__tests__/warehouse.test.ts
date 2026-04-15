import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (must be declared before imports) ───────────────────────────────────

const mockAuthenticateWorker = vi.fn();
const mockHashPin = vi.fn();
const mockVerifyToken = vi.fn();

vi.mock("../../services/warehouseAuth", () => ({
  authenticateWorker: mockAuthenticateWorker,
  hashPin: mockHashPin,
  verifyToken: mockVerifyToken,
}));

const mockPrisma = {
  warehousePin: {
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  booking: {
    findMany: vi.fn(),
  },
  equipmentUnit: {
    findMany: vi.fn(),
  },
  scanSession: {
    findUnique: vi.fn(),
  },
};

vi.mock("../../prisma", () => ({ prisma: mockPrisma }));

const mockCreateSession = vi.fn();
const mockRecordScan = vi.fn();
const mockCompleteSession = vi.fn();
const mockCancelSession = vi.fn();
const mockGetSessionWithDetails = vi.fn();
const mockGetReconciliationPreview = vi.fn();

vi.mock("../../services/warehouseScan", () => ({
  createSession: mockCreateSession,
  recordScan: mockRecordScan,
  completeSession: mockCompleteSession,
  cancelSession: mockCancelSession,
  getSessionWithDetails: mockGetSessionWithDetails,
  getReconciliationPreview: mockGetReconciliationPreview,
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import request from "supertest";
import express from "express";
import { ZodError } from "zod";

let app: express.Express;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();

  // Re-import after resetModules
  const { warehousePublicRouter, warehouseScanRouter } = await import("../warehouse");
  app = express();
  app.use(express.json());
  app.use("/api/warehouse", warehousePublicRouter);
  app.use("/api/warehouse", warehouseScanRouter);
  // Centralized error handler — mirrors app.ts
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ message: "Некорректные данные запроса", details: err.flatten() });
      return;
    }
    res.status(500).json({ message: err instanceof Error ? err.message : String(err) });
  });
});

// ── POST /api/warehouse/auth ──────────────────────────────────────────────────

describe("POST /api/warehouse/auth", () => {
  it("returns token on valid credentials", async () => {
    mockAuthenticateWorker.mockResolvedValue({
      token: "tok-abc",
      name: "Иван",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    const res = await request(app)
      .post("/api/warehouse/auth")
      .send({ name: "Иван", pin: "1234" });

    expect(res.status).toBe(200);
    expect(res.body.token).toBe("tok-abc");
    expect(res.body.name).toBe("Иван");
  });

  it("returns 401 on invalid credentials", async () => {
    mockAuthenticateWorker.mockResolvedValue({ error: "Неверный PIN" });

    const res = await request(app)
      .post("/api/warehouse/auth")
      .send({ name: "Иван", pin: "0000" });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Неверный PIN");
  });
});

// ── Auth guard for scan routes ─────────────────────────────────────────────────

describe("warehouseAuth guard", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const res = await request(app)
      .get("/api/warehouse/bookings?operation=ISSUE");

    expect(res.status).toBe(401);
  });

  it("returns 401 when token is invalid", async () => {
    mockVerifyToken.mockReturnValue(null);

    const res = await request(app)
      .get("/api/warehouse/bookings?operation=ISSUE")
      .set("Authorization", "Bearer bad-token");

    expect(res.status).toBe(401);
  });
});

// ── GET /api/warehouse/bookings ────────────────────────────────────────────────

describe("GET /api/warehouse/bookings", () => {
  beforeEach(() => {
    mockVerifyToken.mockReturnValue({ name: "Иван" });
  });

  it("returns bookings list for ISSUE operation", async () => {
    const booking = {
      id: "book-1",
      client: "Клиент А",
      project: "Проект Б",
      startDate: "2026-01-01",
      endDate: "2026-01-05",
      status: "CONFIRMED",
      items: [{ id: "item-1" }, { id: "item-2" }, { id: "item-3" }],
    };
    mockPrisma.booking.findMany.mockResolvedValue([booking]);

    const res = await request(app)
      .get("/api/warehouse/bookings?operation=ISSUE")
      .set("Authorization", "Bearer valid-token");

    expect(res.status).toBe(200);
    expect(res.body.bookings).toHaveLength(1);
    expect(res.body.bookings[0].items).toHaveLength(3);
    expect(res.body.bookings[0].items[0]).toEqual({ id: "item-1" });
    expect(res.body.bookings[0].status).toBe("CONFIRMED");

    // Verify filter: ISSUE → CONFIRMED
    expect(mockPrisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "CONFIRMED" },
      }),
    );
  });

  it("filters by ISSUED status for RETURN operation", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/warehouse/bookings?operation=RETURN")
      .set("Authorization", "Bearer valid-token");

    expect(res.status).toBe(200);
    expect(mockPrisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "ISSUED" },
      }),
    );
  });

  it("returns 400 when operation is missing", async () => {
    const res = await request(app)
      .get("/api/warehouse/bookings")
      .set("Authorization", "Bearer valid-token");

    expect(res.status).toBe(400);
  });

  it("returns 400 when operation is invalid", async () => {
    const res = await request(app)
      .get("/api/warehouse/bookings?operation=INVALID")
      .set("Authorization", "Bearer valid-token");

    expect(res.status).toBe(400);
  });
});

// ── POST /api/warehouse/sessions ──────────────────────────────────────────────

describe("POST /api/warehouse/sessions", () => {
  beforeEach(() => {
    mockVerifyToken.mockReturnValue({ name: "Иван" });
  });

  it("creates a session with worker name from token", async () => {
    const session = {
      id: "sess-1",
      bookingId: "book-1",
      operation: "ISSUE",
      status: "ACTIVE",
      workerName: "Иван",
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    mockCreateSession.mockResolvedValue(session);

    const res = await request(app)
      .post("/api/warehouse/sessions")
      .set("Authorization", "Bearer valid-token")
      .send({ bookingId: "book-1", operation: "ISSUE" });

    expect(res.status).toBe(201);
    expect(res.body.session).toMatchObject({ id: "sess-1", workerName: "Иван" });
    expect(mockCreateSession).toHaveBeenCalledWith("book-1", "Иван", "ISSUE");
  });

  it("returns 400 on invalid body", async () => {
    const res = await request(app)
      .post("/api/warehouse/sessions")
      .set("Authorization", "Bearer valid-token")
      .send({ bookingId: "book-1" }); // missing operation

    expect(res.status).toBe(400);
  });
});

// ── GET /api/warehouse/sessions/:id ──────────────────────────────────────────

describe("GET /api/warehouse/sessions/:id", () => {
  beforeEach(() => {
    mockVerifyToken.mockReturnValue({ name: "Иван" });
  });

  it("returns session with details", async () => {
    const sessionDetails = {
      session: { id: "sess-1", bookingId: "book-1", operation: "ISSUE", status: "ACTIVE" },
      bookingItems: [],
    };
    mockGetSessionWithDetails.mockResolvedValue(sessionDetails);

    const res = await request(app)
      .get("/api/warehouse/sessions/sess-1")
      .set("Authorization", "Bearer valid-token");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(sessionDetails);
    expect(mockGetSessionWithDetails).toHaveBeenCalledWith("sess-1");
  });
});

// ── POST /api/warehouse/sessions/:id/scan ────────────────────────────────────

describe("POST /api/warehouse/sessions/:id/scan", () => {
  beforeEach(() => {
    mockVerifyToken.mockReturnValue({ name: "Иван" });
  });

  it("returns scan result on success", async () => {
    const scanResult = {
      scanRecord: { id: "scan-1", sessionId: "sess-1", equipmentUnitId: "unit-1", scannedAt: new Date().toISOString() },
      bookingItem: { id: "bi-1", equipmentId: "eq-1" },
      unit: { id: "unit-1", barcode: "BC001" },
    };
    mockRecordScan.mockResolvedValue(scanResult);

    const res = await request(app)
      .post("/api/warehouse/sessions/sess-1/scan")
      .set("Authorization", "Bearer valid-token")
      .send({ barcodePayload: "hmac-signed-payload" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", ...scanResult });
    expect(mockRecordScan).toHaveBeenCalledWith("sess-1", "hmac-signed-payload");
  });

  it("returns error result when scan service returns error", async () => {
    mockRecordScan.mockResolvedValue({ error: "Неверный штрихкод" });

    const res = await request(app)
      .post("/api/warehouse/sessions/sess-1/scan")
      .set("Authorization", "Bearer valid-token")
      .send({ barcodePayload: "bad" });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Неверный штрихкод");
    expect(res.body.status).toBe("error");
  });

  it("returns 400 when barcodePayload is missing", async () => {
    const res = await request(app)
      .post("/api/warehouse/sessions/sess-1/scan")
      .set("Authorization", "Bearer valid-token")
      .send({});

    expect(res.status).toBe(400);
  });
});

// ── POST /api/warehouse/sessions/:id/complete ────────────────────────────────

describe("POST /api/warehouse/sessions/:id/complete", () => {
  beforeEach(() => {
    mockVerifyToken.mockReturnValue({ name: "Иван" });
  });

  it("returns reconciliation summary", async () => {
    const summary = { scanned: 5, expected: 5, missing: [], substituted: [] };
    mockCompleteSession.mockResolvedValue(summary);
    mockPrisma.equipmentUnit.findMany.mockResolvedValue([]);
    mockPrisma.scanSession.findUnique.mockResolvedValue({ id: "sess-1", operation: "ISSUE" });

    const res = await request(app)
      .post("/api/warehouse/sessions/sess-1/complete")
      .set("Authorization", "Bearer valid-token");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sessionId: "sess-1",
      operation: "ISSUE",
      scannedCount: 5,
      expectedCount: 5,
      missingItems: [],
      substitutedItems: [],
    });
    expect(mockCompleteSession).toHaveBeenCalledWith("sess-1", expect.objectContaining({}));
  });
});

// ── POST /api/warehouse/sessions/:id/cancel ──────────────────────────────────

describe("POST /api/warehouse/sessions/:id/cancel", () => {
  beforeEach(() => {
    mockVerifyToken.mockReturnValue({ name: "Иван" });
  });

  it("returns cancelled session", async () => {
    const cancelled = {
      id: "sess-1",
      bookingId: "book-1",
      status: "CANCELLED",
      workerName: "Иван",
    };
    mockCancelSession.mockResolvedValue(cancelled);

    const res = await request(app)
      .post("/api/warehouse/sessions/sess-1/cancel")
      .set("Authorization", "Bearer valid-token");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(cancelled);
    expect(mockCancelSession).toHaveBeenCalledWith("sess-1");
  });
});
