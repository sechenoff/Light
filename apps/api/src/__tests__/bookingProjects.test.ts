import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import {
  priceProject,
  nextDate,
  projectDates,
  defaultDayKind,
} from "../services/projectPricing";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "booking-projects-"));
const db = path.join(dir, "test.db");
fs.writeFileSync(db, "");
process.env.DATABASE_URL = `file:${db}`;
process.env.JWT_SECRET = "project-test-jwt-secret-at-least-32";
process.env.NODE_ENV = "test";
process.env.CLIENT_PORTAL_SESSION_SECRET = "project-client-session-secret";
process.env.CLIENT_PORTAL_TOKEN_SECRET = "project-client-token-secret";
process.env.WAREHOUSE_SECRET = "project-test-warehouse-secret";
process.env.RATE_LIMIT_DISABLED = "true";
let prisma: (typeof import("../prisma"))["prisma"];
let service: typeof import("../services/bookingProjects");
let app: (typeof import("../app"))["app"];
let uid: string, token: string, whToken: string;
const today = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Moscow",
}).format(new Date());
const start = nextDate(today, -21),
  end = nextDate(today, 60);
const H = () => ({
  "X-API-Key": "test-key-1",
  Authorization: `Bearer ${token}`,
});
let counter = 0;
beforeAll(async () => {
  execFileSync(
    process.execPath,
    [
      path.resolve(__dirname, "../../../../node_modules/prisma/build/index.js"),
      "db",
      "push",
      "--skip-generate",
      "--schema",
      path.resolve(__dirname, "../../prisma/schema.prisma"),
    ],
    { env: process.env, stdio: "pipe" },
  );
  prisma = (await import("../prisma")).prisma;
  service = await import("../services/bookingProjects");
  app = (await import("../app")).app;
  const { signSession } = await import("../services/auth");
  const sa = await prisma.adminUser.create({
    data: {
      username: "projects-sa",
      passwordHash: "unused",
      role: "SUPER_ADMIN",
    },
  });
  const wh = await prisma.adminUser.create({
    data: {
      username: "projects-wh",
      passwordHash: "unused",
      role: "WAREHOUSE",
    },
  });
  uid = sa.id;
  token = signSession({
    userId: uid,
    username: sa.username,
    role: "SUPER_ADMIN",
  });
  whToken = signSession({
    userId: wh.id,
    username: wh.username,
    role: "WAREHOUSE",
  });
});
afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});
async function fixture(mode: "COUNT" | "UNIT" = "COUNT", total = 10) {
  const n = ++counter;
  const client = await prisma.client.create({
    data: { name: `Project client ${n}` },
  });
  const eq = await prisma.equipment.create({
    data: {
      name: `Project light ${n}`,
      importKey: `proj-${n}`,
      category: "Свет",
      stockTrackingMode: mode,
      totalQuantity: total,
      rentalRatePerShift: 1000,
    },
  });
  if (mode === "UNIT")
    for (let i = 0; i < total; i++)
      await prisma.equipmentUnit.create({
        data: { equipmentId: eq.id, internalInventoryNumber: `P-${n}-${i}` },
      });
  const p = await service.createProject(
    {
      clientId: client.id,
      projectName: `Сериал ${n}`,
      fromDate: start,
      throughDate: end,
      restFactor: 0.5,
      billingCycle: "WEEKLY",
      paymentTermsDays: 7,
      paymentForm: "CASH",
      cashlessSurchargePercent: 0,
    },
    uid,
  );
  const lot = await service.addProjectLot(
    p.id,
    {
      revision: 0,
      equipmentId: eq.id,
      quantity: 2,
      fromDate: start,
      throughDate: end,
    },
    uid,
  );
  return { id: p.id, eq, client, lot };
}
async function revision(id: string) {
  return (
    await prisma.bookingProject.findUniqueOrThrow({ where: { bookingId: id } })
  ).revision;
}
async function issue(f: Awaited<ReturnType<typeof fixture>>) {
  await service.confirmProject(f.id, await revision(f.id), uid);
  const units = await prisma.equipmentUnit.findMany({
    where: { equipmentId: f.eq.id },
    take: 2,
  });
  await service.issueProjectLot(
    f.id,
    f.lot.id,
    {
      revision: await revision(f.id),
      fromDate: start,
      unitIds: units.map((u) => u.id),
    },
    uid,
  );
  return units;
}

describe("project pricing", () => {
  it("50 shooting days + 20 rest days = 60 full shifts, without integer rounding", () => {
    const days = projectDates("2026-01-01", "2026-03-11").map((date, i) => ({
      date,
      kind: i < 50 ? "SHOOT" : "REST",
    }));
    const priced = priceProject({
      fromDate: days[0].date,
      throughDate: days.at(-1)!.date,
      days,
      restFactor: ".5",
      lots: [
        {
          id: "a",
          nameSnapshot: "Light",
          quantity: 1,
          ratePerShift: "1000",
          fromDate: days[0].date,
          throughDate: days.at(-1)!.date,
          returns: [],
          status: "ISSUED",
        },
      ],
    });
    expect(priced.total).toBe("60000.00");
  });
  it("charges an addon only for its own 5 shooting and 2 rest days", () => {
    const priced = priceProject({
      fromDate: "2026-10-01",
      throughDate: "2026-12-15",
      days: [],
      restFactor: ".5",
      lots: [
        {
          id: "a",
          nameSnapshot: "Light",
          quantity: 2,
          ratePerShift: "1000",
          fromDate: "2026-10-21",
          throughDate: "2026-10-27",
          returns: [],
          status: "ISSUED",
        },
      ],
    });
    expect(priced.total).toBe("12000.00");
  });
});
describe("project workflows", () => {
  it("separates forecast, reservations and actual issue, sharing ordinary availability", async () => {
    const f = await fixture("COUNT", 3);
    const { getAvailability } = await import("../services/availability");
    const q = {
      startDate: new Date(),
      endDate: new Date(Date.now() + 86400000),
      equipmentIds: [f.eq.id],
    };
    expect((await getAvailability(q))[0].availableQuantity).toBe(3);
    await service.confirmProject(f.id, await revision(f.id), uid);
    expect((await getAvailability(q))[0].availableQuantity).toBe(1);
    const d = await service.projectDetail(f.id);
    expect(d.booking.finalAmount.toString()).toBe("0");
    expect(Number(d.forecast.total)).toBeGreaterThan(0);
    expect(d.lots[0].issuedAt).toBeNull();
    await expect(
      service.addProjectLot(
        f.id,
        {
          revision: d.revision,
          equipmentId: f.eq.id,
          quantity: 2,
          fromDate: today,
          throughDate: end,
        },
        uid,
      ),
    ).rejects.toThrow("Недостаточно");
  });
  it("does not sum non-overlapping reservations into a false conflict", async () => {
    const f = await fixture("COUNT", 4);
    await prisma.projectLot.delete({ where: { id: f.lot.id } });
    await service.addProjectLot(
      f.id,
      {
        revision: await revision(f.id),
        equipmentId: f.eq.id,
        quantity: 4,
        fromDate: today,
        throughDate: nextDate(today, 2),
      },
      uid,
    );
    await service.addProjectLot(
      f.id,
      {
        revision: await revision(f.id),
        equipmentId: f.eq.id,
        quantity: 4,
        fromDate: nextDate(today, 3),
        throughDate: end,
      },
      uid,
    );
    await service.confirmProject(f.id, await revision(f.id), uid);
    const { getAvailability } = await import("../services/availability");
    const rows = await getAvailability({
      startDate: new Date(),
      endDate: new Date(end),
      equipmentIds: [f.eq.id],
    });
    expect(rows[0].occupiedQuantity).toBe(4);
  });
  it("partial return frees only accepted quantity without closing booking", async () => {
    const f = await fixture();
    await issue(f);
    await service.returnProjectLot(
      f.id,
      f.lot.id,
      {
        revision: await revision(f.id),
        quantity: 1,
        lastBillableDate: today,
        unitIds: [],
        condition: "OK",
      },
      uid,
    );
    const d = await service.projectDetail(f.id);
    expect(d.booking.status).toBe("ISSUED");
    expect(d.lots[0].status).toBe("ISSUED");
    const { getAvailability } = await import("../services/availability");
    const rows = await getAvailability({
      startDate: new Date(Date.now() + 1000),
      endDate: new Date(Date.now() + 86400000),
      equipmentIds: [f.eq.id],
    });
    expect(rows[0].occupiedQuantity).toBe(1);
    await expect(
      service.finishProject(f.id, await revision(f.id), uid),
    ).rejects.toThrow("Сначала примите");
  });
  it("supports returning and reissuing the same serial unit into the same project", async () => {
    const f = await fixture("UNIT", 3);
    const units = await issue(f);
    await service.returnProjectLot(
      f.id,
      f.lot.id,
      {
        revision: await revision(f.id),
        quantity: 1,
        lastBillableDate: today,
        unitIds: [units[0].id],
        condition: "OK",
      },
      uid,
    );
    const lot = await service.addProjectLot(
      f.id,
      {
        revision: await revision(f.id),
        equipmentId: f.eq.id,
        quantity: 1,
        fromDate: today,
        throughDate: end,
      },
      uid,
    );
    await service.issueProjectLot(
      f.id,
      lot.id,
      {
        revision: await revision(f.id),
        fromDate: today,
        unitIds: [units[0].id],
      },
      uid,
    );
    expect(
      await prisma.projectLotUnit.count({
        where: { equipmentUnitId: units[0].id },
      }),
    ).toBe(2);
    expect(
      (
        await prisma.equipmentUnit.findUniqueOrThrow({
          where: { id: units[1].id },
        })
      ).status,
    ).toBe("ISSUED");
  });
  it("retains missing and damaged COUNT equipment outside available stock", async () => {
    const f = await fixture("COUNT", 3);
    await issue(f);
    await service.returnProjectLot(
      f.id,
      f.lot.id,
      {
        revision: await revision(f.id),
        quantity: 1,
        lastBillableDate: today,
        unitIds: [],
        condition: "REPAIR",
        reason: "Разбит разъём",
      },
      uid,
    );
    await service.returnProjectLot(
      f.id,
      f.lot.id,
      {
        revision: await revision(f.id),
        quantity: 1,
        lastBillableDate: today,
        unitIds: [],
        condition: "MISSING",
        reason: "Не вернули со съёмки",
      },
      uid,
    );
    const { getAvailability } = await import("../services/availability");
    expect(
      (
        await getAvailability({
          startDate: new Date(Date.now() + 1000),
          endDate: new Date(Date.now() + 86400000),
          equipmentIds: [f.eq.id],
        })
      )[0].availableQuantity,
    ).toBe(1);
  });
  it("freezes period lines and identity, creates one invoice on retry, rejects old edits", async () => {
    const f = await fixture();
    await issue(f);
    const rev = await revision(f.id);
    const body = {
      revision: rev,
      throughDate: nextDate(start, 6),
      requestKey: "period-retry-key",
    };
    const period = await service.closeProjectPeriod(f.id, body, uid);
    expect((await service.closeProjectPeriod(f.id, body, uid)).id).toBe(
      period.id,
    );
    expect(await prisma.invoice.count({ where: { bookingId: f.id } })).toBe(1);
    await expect(
      service.updateProjectDays(
        f.id,
        {
          revision: await revision(f.id),
          fromDate: start,
          throughDate: start,
          kind: "REST",
        },
        uid,
      ),
    ).rejects.toThrow("уже закрыт");
    await prisma.equipment.update({
      where: { id: f.eq.id },
      data: { rentalRatePerShift: 9000 },
    });
    const current = await prisma.projectBillingPeriod.findUniqueOrThrow({
      where: { id: period.id },
    });
    expect(current.linesJson).toBe(period.linesJson);
    expect(JSON.parse(current.documentJson).client.name).toBe(f.client.name);
    const { voidInvoice } = await import("../services/invoiceService");
    await expect(
      voidInvoice(period.invoiceId!, "Изменение суммы", uid),
    ).rejects.toThrow("корректировкой");
  });
  it("allocates advances across periods and preserves immutable corrections", async () => {
    const f = await fixture();
    await issue(f);
    await service.recordProjectPayment(
      f.id,
      { revision: await revision(f.id), amount: 15000, method: "CASH" },
      uid,
    );
    expect((await service.projectDetail(f.id)).advance).toBe("15000.00");
    const first = await service.closeProjectPeriod(
      f.id,
      {
        revision: await revision(f.id),
        throughDate: nextDate(start, 6),
        requestKey: "finance-period-one",
      },
      uid,
    );
    await service.closeProjectPeriod(
      f.id,
      {
        revision: await revision(f.id),
        throughDate: nextDate(start, 13),
        requestKey: "finance-period-two",
      },
      uid,
    );
    const d = await service.projectDetail(f.id);
    expect(d.booking.finalAmount.toString()).toBe("24000");
    expect(d.booking.amountPaid.toString()).toBe("15000");
    expect(d.booking.amountOutstanding.toString()).toBe("9000");
    expect(d.allocations[0].paid).toBe("12000.00");
    expect(d.allocations[1].paid).toBe("3000.00");
    await service.correctProjectPeriod(
      f.id,
      first.id,
      {
        revision: await revision(f.id),
        amount: -1000,
        reason: "Согласованная корректировка",
        requestKey: "correction-one-key",
      },
      uid,
    );
    const corrected = await service.projectDetail(f.id);
    expect(corrected.booking.amountOutstanding.toString()).toBe("8000");
    expect(
      (
        await prisma.projectBillingPeriod.findUniqueOrThrow({
          where: { id: first.id },
        })
      ).amount.toString(),
    ).toBe("12000");
  });
  it("rejects stale actions and closing planned or future deliveries", async () => {
    const f = await fixture();
    await expect(service.confirmProject(f.id, 0, uid)).rejects.toThrow(
      "Проект изменился",
    );
    await service.confirmProject(f.id, await revision(f.id), uid);
    await expect(
      service.closeProjectPeriod(
        f.id,
        {
          revision: await revision(f.id),
          throughDate: nextDate(start, 6),
          requestKey: "planned-close-key",
        },
        uid,
      ),
    ).rejects.toThrow("невыданные");
    await expect(
      service.closeProjectPeriod(
        f.id,
        {
          revision: await revision(f.id),
          throughDate: end,
          requestKey: "future-close-key",
        },
        uid,
      ),
    ).rejects.toThrow("будущий");
  });
  it("does not auto-release overdue equipment", async () => {
    const f = await fixture();
    await issue(f);
    await prisma.projectLot.update({
      where: { id: f.lot.id },
      data: { throughDate: nextDate(today, -1) },
    });
    const { getAvailability } = await import("../services/availability");
    expect(
      (
        await getAvailability({
          startDate: new Date(),
          endDate: new Date(Date.now() + 10 * 86400000),
          equipmentIds: [f.eq.id],
        })
      )[0].occupiedQuantity,
    ).toBe(2);
  });
  it("exports period PDF and XLSX from fixed lines", async () => {
    const f = await fixture();
    await issue(f);
    const period = await service.closeProjectPeriod(
      f.id,
      {
        revision: await revision(f.id),
        throughDate: nextDate(start, 6),
        requestKey: "export-period-key",
      },
      uid,
    );
    const { exportProjectDocument } = await import(
      "../services/projectDocuments"
    );
    expect(
      (await exportProjectDocument(f.id, period.id, "pdf"))
        .subarray(0, 4)
        .toString(),
    ).toBe("%PDF");
    expect(
      (await exportProjectDocument(f.id, period.id, "xlsx"))
        .subarray(0, 2)
        .toString(),
    ).toBe("PK");
  });
  it("exposes filtered list and protects normal booking/warehouse mutation paths", async () => {
    const f = await fixture();
    await issue(f);
    const list = await request(app).get("/api/bookings?mode=PROJECT").set(H());
    expect(list.status).toBe(200);
    expect(
      list.body.bookings.every((b: { mode: string }) => b.mode === "PROJECT"),
    ).toBe(true);
    const detail = await request(app)
      .get(`/api/booking-projects/${f.id}`)
      .set(H());
    expect(detail.status).toBe(200);
    expect(detail.body.booking.id).toBe(f.id);
    expect(
      (
        await request(app)
          .patch(`/api/bookings/${f.id}`)
          .set(H())
          .send({ projectName: "Bad" })
      ).status,
    ).toBe(409);
    const { createSession } = await import("../services/warehouseScan");
    await expect(createSession(f.id, "Склад", "RETURN")).rejects.toThrow(
      "конкретную поставку",
    );
    const calendar = await request(app)
      .get(`/api/calendar?start=${today}&end=${nextDate(today, 1)}`)
      .set(H());
    expect(calendar.status).toBe(200);
    expect(
      calendar.body.events.some(
        (e: { bookingId: string }) => e.bookingId === f.id,
      ),
    ).toBe(true);
  });
  it("prevents warehouse role from closing periods or booking drafts, and validates dates", async () => {
    const f = await fixture();
    const headers = { ...H(), Authorization: `Bearer ${whToken}` };
    expect(
      (
        await request(app)
          .post(`/api/booking-projects/${f.id}/confirm`)
          .set(headers)
          .send({ revision: 1 })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`/api/booking-projects/${f.id}/periods`)
          .set(headers)
          .send({
            revision: 1,
            throughDate: today,
            requestKey: "warehouse-close-key",
          })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .patch(`/api/booking-projects/${f.id}/calendar`)
          .set(H())
          .send({
            revision: 1,
            fromDate: "2026-02-31",
            throughDate: today,
            kind: "REST",
          })
      ).status,
    ).toBe(400);
  });
  it("keeps corrected invoice amounts consistent in list and aging, preserving original document", async () => {
    const f = await fixture();
    await issue(f);
    const period = await service.closeProjectPeriod(
      f.id,
      {
        revision: await revision(f.id),
        throughDate: nextDate(start, 6),
        requestKey: "read-model-period",
      },
      uid,
    );
    await service.correctProjectPeriod(
      f.id,
      period.id,
      {
        revision: await revision(f.id),
        amount: 500,
        reason: "Дополнительная услуга",
        requestKey: "read-model-correction",
      },
      uid,
    );
    const invoices = await request(app)
      .get(`/api/invoices?bookingId=${f.id}`)
      .set(H());
    expect(invoices.status).toBe(200);
    expect(invoices.body.items[0].total).toBe("12500.00");
    expect(invoices.body.items[0].originalTotal).toBe("12000");
    expect(
      (
        await prisma.invoice.findUniqueOrThrow({
          where: { id: period.invoiceId! },
        })
      ).total.toString(),
    ).toBe("12000");
    const { computeAgingPerClient } = await import("../services/finance");
    const aging = await computeAgingPerClient();
    expect(JSON.stringify(aging.perClient)).toContain(f.client.id);
    await expect(
      service.closeProjectPeriod(
        f.id,
        {
          revision: await revision(f.id),
          throughDate: nextDate(start, 13),
          requestKey: "read-model-period",
        },
        uid,
      ),
    ).rejects.toThrow("другого расчёта");
  });
  it("rejects extension conflicts and keeps dates unchanged on failure", async () => {
    const f = await fixture("COUNT", 2);
    await prisma.projectLot.update({
      where: { id: f.lot.id },
      data: { throughDate: today },
    });
    await service.confirmProject(f.id, await revision(f.id), uid);
    await prisma.booking.create({
      data: {
        clientId: f.client.id,
        projectName: "Next rental",
        startDate: new Date(nextDate(today) + "T00:00:00+03:00"),
        endDate: new Date(end),
        status: "CONFIRMED",
        items: { create: { equipmentId: f.eq.id, quantity: 2 } },
      },
    });
    await expect(
      service.changeProjectLot(
        f.id,
        f.lot.id,
        { revision: await revision(f.id), action: "EXTEND", throughDate: end },
        uid,
      ),
    ).rejects.toThrow("Недостаточно");
    expect(
      (await prisma.projectLot.findUniqueOrThrow({ where: { id: f.lot.id } }))
        .throughDate,
    ).toBe(today);
  });
  it("does not issue COUNT stock still physically held by an overdue ordinary booking", async () => {
    const f = await fixture("COUNT", 2);
    await prisma.projectLot.update({
      where: { id: f.lot.id },
      data: { fromDate: today },
    });
    await prisma.booking.create({
      data: {
        clientId: f.client.id,
        projectName: "Overdue rental",
        startDate: new Date(start),
        endDate: new Date(nextDate(today, -1)),
        status: "ISSUED",
        items: { create: { equipmentId: f.eq.id, quantity: 2 } },
      },
    });
    await service.confirmProject(f.id, await revision(f.id), uid);
    await expect(
      service.issueProjectLot(
        f.id,
        f.lot.id,
        { revision: await revision(f.id), fromDate: today, unitIds: [] },
        uid,
      ),
    ).rejects.toThrow("физически");
  });
  it("supports the warehouse PIN path without exposing prices and rejects invalid dates", async () => {
    const f = await fixture();
    await service.confirmProject(f.id, await revision(f.id), uid);
    const { generateToken, hashPin } = await import(
      "../services/warehouseAuth"
    );
    await prisma.warehousePin.create({
      data: {
        name: "Projects test worker",
        pinHash: await hashPin("2580"),
        isActive: true,
      },
    });
    const headers = {
      Authorization: `Bearer ${generateToken("Projects test worker")}`,
    };
    const ops = await request(app)
      .get("/api/warehouse/project-operations")
      .set(headers);
    expect(ops.status).toBe(200);
    expect(JSON.stringify(ops.body)).not.toContain("ratePerShift");
    const bad = await request(app)
      .post(`/api/warehouse/project-operations/${f.id}/${f.lot.id}/issue`)
      .set(headers)
      .send({
        revision: await revision(f.id),
        date: "2026-99-99",
        quantity: 2,
      });
    expect(bad.status).toBe(400);
    const issued = await request(app)
      .post(`/api/warehouse/project-operations/${f.id}/${f.lot.id}/issue`)
      .set(headers)
      .send({ revision: await revision(f.id), date: today, quantity: 2 });
    expect(issued.status).toBe(200);
    const returned = await request(app)
      .post(`/api/warehouse/project-operations/${f.id}/${f.lot.id}/return`)
      .set(headers)
      .send({ revision: await revision(f.id), date: today, quantity: 1 });
    expect(returned.status).toBe(200);
    expect((await service.projectDetail(f.id)).booking.status).toBe("ISSUED");
  });
  it("recomputes advances after voiding a payment through the common payment journal", async () => {
    const f = await fixture();
    await issue(f);
    await service.recordProjectPayment(
      f.id,
      { revision: await revision(f.id), amount: 15000, method: "CASH" },
      uid,
    );
    await service.closeProjectPeriod(
      f.id,
      {
        revision: await revision(f.id),
        throughDate: nextDate(start, 6),
        requestKey: "void-payment-period",
      },
      uid,
    );
    const payment = await prisma.payment.findFirstOrThrow({
      where: { bookingId: f.id },
    });
    const response = await request(app)
      .post(`/api/payments/${payment.id}/void`)
      .set(H())
      .send({ reason: "Ошибочная запись оплаты" });
    expect(response.status).toBe(200);
    const d = await service.projectDetail(f.id);
    expect(d.advance).toBe("0.00");
    expect(d.booking.amountOutstanding.toString()).toBe("12000");
  });
  it("adapts old estimate downloads and requires all periods before an act", async () => {
    const f = await fixture();
    await issue(f);
    const pdf = await request(app)
      .get(`/api/bookings/${f.id}/full-estimate/export/pdf`)
      .set(H());
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    await service.returnProjectLot(
      f.id,
      f.lot.id,
      {
        revision: await revision(f.id),
        quantity: 2,
        lastBillableDate: today,
        unitIds: [],
        condition: "OK",
      },
      uid,
    );
    await service.finishProject(f.id, await revision(f.id), uid);
    const { buildBookingActPdf } = await import(
      "../services/documentExport/bookingPdf"
    );
    await expect(buildBookingActPdf(f.id)).rejects.toThrow("последний период");
  });
  it("cancels an unissued project and releases reservations, but protects an advance", async () => {
    const f = await fixture("COUNT", 2);
    await service.confirmProject(f.id, await revision(f.id), uid);
    await service.cancelProject(f.id, await revision(f.id), uid);
    const { getAvailability } = await import("../services/availability");
    expect(
      (
        await getAvailability({
          startDate: new Date(),
          endDate: new Date(end),
          equipmentIds: [f.eq.id],
        })
      )[0].availableQuantity,
    ).toBe(2);
    expect((await service.projectDetail(f.id)).booking.status).toBe(
      "CANCELLED",
    );
    const f2 = await fixture();
    await service.recordProjectPayment(
      f2.id,
      { revision: await revision(f2.id), amount: 100, method: "CASH" },
      uid,
    );
    await expect(
      service.cancelProject(f2.id, await revision(f2.id), uid),
    ).rejects.toThrow("возврат аванса");
  });
  it("shows forecast and period documents only to the owning portal client", async () => {
    const f = await fixture();
    await issue(f);
    const period = await service.closeProjectPeriod(
      f.id,
      {
        revision: await revision(f.id),
        throughDate: nextDate(start, 6),
        requestKey: "portal-period-key",
      },
      uid,
    );
    const { issueMagicLink } = await import(
      "../services/clientPortal/magicLink"
    );
    const account = await prisma.clientPortalAccount.create({
      data: {
        clientId: f.client.id,
        email: "project-portal@test.example",
        status: "ACTIVE",
      },
    });
    const { rawToken } = await issueMagicLink(prisma, account.id, "LOGIN");
    const login = await request(app)
      .post("/api/lk/auth/verify")
      .send({ token: rawToken });
    expect(login.status).toBe(200);
    const cookie = login.headers["set-cookie"];
    const detail = await request(app)
      .get(`/api/lk/bookings/${f.id}`)
      .set("Cookie", cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.items.length).toBeGreaterThan(0);
    expect(detail.body.mode).toBe("PROJECT");
    expect(detail.body.events).toBeUndefined();
    expect(detail.body.payments).toBeUndefined();
    expect(
      (
        await request(app)
          .get(`/api/lk/bookings/${f.id}/project-documents/${period.id}/pdf`)
          .set("Cookie", cookie)
      ).status,
    ).toBe(200);
    const other = await fixture();
    await issue(other);
    expect(
      (
        await request(app)
          .get(`/api/lk/bookings/${other.id}/project-documents/forecast/pdf`)
          .set("Cookie", cookie)
      ).status,
    ).toBe(404);
  });

  it("prevents a forced ordinary issue from taking equipment held by a project", async () => {
    const f = await fixture("COUNT", 2);
    await issue(f);
    const ordinary = await prisma.booking.create({
      data: {
        clientId: f.client.id,
        projectName: "Conflicting ordinary booking",
        startDate: new Date(start),
        endDate: new Date(end),
        status: "CONFIRMED",
        items: { create: { equipmentId: f.eq.id, quantity: 1 } },
      },
    });
    const result = await request(app)
      .post(`/api/bookings/${ordinary.id}/status`)
      .set(H())
      .send({ action: "issue", force: true });
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("PROJECT_STOCK_CONFLICT");
    expect(
      (await prisma.booking.findUniqueOrThrow({ where: { id: ordinary.id } }))
        .status,
    ).toBe("CONFIRMED");
  });
});
