/**
 * Общий стенд для интеграционных тестов киоска склада (выдача и приёмка).
 *
 * Не тест, а набор помощников: изолированная SQLite на файл, пользователи
 * (руководитель, кладовщик главной сессией, кладовщик по PIN), позиции,
 * брони с MAIN-сметой и HTTP-обёртки над маршрутами киоска.
 *
 * Порядок использования в тестовом файле:
 *   const kit = kioskTestKit("имя-файла");   // до любых импортов приложения
 *   beforeAll(() => kit.boot(), 120_000);
 *   afterAll(() => kit.shutdown());
 *
 * Даты — только от Date.now(): зашитые календарные даты «протухают».
 */
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import request from "supertest";

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

type AnyRecord = Record<string, any>;

export interface KitBookingItem {
  equipmentId: string;
  quantity: number;
}

export interface KitBookingOpts {
  status: "DRAFT" | "PENDING_APPROVAL" | "CONFIRMED" | "ISSUED" | "RETURNED";
  items: KitBookingItem[];
  /** Смещение начала аренды от «сейчас»; по умолчанию −1 ч (аренда уже идёт). */
  startOffsetMs?: number;
  /** Длительность; по умолчанию сутки (1 смена). */
  durationMs?: number;
  /** Смен в MAIN-смете; по умолчанию 1. */
  shifts?: number;
  manualFinalAmount?: string;
  archived?: boolean;
  projectName?: string;
  /** Штучным позициям — зарезервировать свободные экземпляры (по умолчанию да). */
  reserveUnits?: boolean;
}

export function kioskTestKit(name: string) {
  const dbPath = path.resolve(__dirname, `../../prisma/test-${name}.db`);
  const apiKey = `test-key-${name}`;
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.RATE_LIMIT_DISABLED = "true";
  process.env.API_KEYS = apiKey;
  process.env.AUTH_MODE = "warn";
  process.env.NODE_ENV = "test";
  process.env.BARCODE_SECRET = `test-secret-${name}`;
  process.env.WAREHOUSE_SECRET = `test-warehouse-${name}-min16chars`;
  process.env.VISION_PROVIDER = "mock";
  process.env.JWT_SECRET = `test-jwt-${name}-min16chars-000`;

  const kit = {
    app: null as any,
    prisma: null as any,
    saId: "",
    whId: "",
    saToken: "",
    whToken: "",
    /** Имя кладовщика главной сессии (username) — так его видит киоск. */
    whName: `${name}_wh`,
    pinToken: "",
    pinName: "Кладовщик Тестовый",
    clientId: "",
    seq: 0,

    headers(token: string) {
      return { "X-API-Key": apiKey, Authorization: `Bearer ${token}` };
    },

    /** Поднимает базу и приложение. `withSystemUser: false` — база без `_system_`. */
    async boot(opts: { withSystemUser?: boolean } = {}) {
      fs.writeFileSync(dbPath, "");
      execSync("npx prisma db push --skip-generate --force-reset", {
        cwd: path.resolve(__dirname, "../.."),
        env: { ...process.env, DATABASE_URL: `file:${dbPath}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
        stdio: "pipe",
      });
      kit.prisma = (await import("../prisma")).prisma;
      kit.app = (await import("../app")).app;
      (await import("../services/scanSessionPolicy"))._resetSystemAuditUserCacheForTests();

      const { hashPassword, signSession } = await import("../services/auth");
      const { hashPin, generateToken } = await import("../services/warehouseAuth");
      const hash = await hashPassword(`${name}-pass-123`);
      const sa = await kit.prisma.adminUser.create({
        data: { username: `${name}_sa`, passwordHash: hash, role: "SUPER_ADMIN" },
      });
      const wh = await kit.prisma.adminUser.create({
        data: { username: kit.whName, passwordHash: hash, role: "WAREHOUSE" },
      });
      if (opts.withSystemUser !== false) {
        await kit.prisma.adminUser.create({
          data: { id: "_system_", username: "_system_", passwordHash: "!disabled", role: "SUPER_ADMIN", isActive: false },
        });
      }
      kit.saId = sa.id;
      kit.whId = wh.id;
      kit.saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
      kit.whToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });
      await kit.prisma.warehousePin.create({
        data: { name: kit.pinName, pinHash: await hashPin("135790"), isActive: true },
      });
      kit.pinToken = generateToken(kit.pinName);
      kit.clientId = (await kit.prisma.client.create({ data: { name: `Клиент ${name}`, phone: "+70000001234" } })).id;
    },

    async shutdown() {
      await kit.prisma?.$disconnect?.();
      for (const s of ["", "-wal", "-shm", "-journal"]) {
        try {
          fs.unlinkSync(dbPath + s);
        } catch {
          /* файла нет — нечего убирать */
        }
      }
    },

    async mkEquipment(o: { name?: string; total?: number; rate?: string; mode?: "COUNT" | "UNIT"; category?: string } = {}) {
      kit.seq += 1;
      const eq = await kit.prisma.equipment.create({
        data: {
          importKey: `${name}-eq-${kit.seq}`,
          name: o.name ?? `Прибор ${kit.seq}`,
          category: o.category ?? "Свет",
          rentalRatePerShift: o.rate ?? "1000",
          stockTrackingMode: o.mode ?? "COUNT",
          totalQuantity: o.total ?? 10,
        },
      });
      return eq.id as string;
    },

    /** Штучные экземпляры позиции, все на полке. */
    async mkUnits(equipmentId: string, n: number) {
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        kit.seq += 1;
        const u = await kit.prisma.equipmentUnit.create({
          data: { equipmentId, status: "AVAILABLE", internalInventoryNumber: `${name}-U-${kit.seq}` },
        });
        ids.push(u.id);
      }
      return ids;
    },

    /**
     * Бронь с позициями и MAIN-сметой по ставке позиции × смены. Штучные
     * позиции получают резервы свободных экземпляров; у выданной брони они ISSUED.
     */
    async mkBooking(o: KitBookingOpts): Promise<string> {
      const shifts = o.shifts ?? 1;
      const start = new Date(Date.now() + (o.startOffsetMs ?? -HOUR));
      const end = new Date(start.getTime() + (o.durationMs ?? DAY));
      const equipment = await kit.prisma.equipment.findMany({
        where: { id: { in: o.items.map((i) => i.equipmentId) } },
      });
      const eqById = new Map<string, AnyRecord>(equipment.map((e: AnyRecord) => [e.id, e]));
      const lines = o.items.map((i) => {
        const eq = eqById.get(i.equipmentId)!;
        const unitPrice = Number(eq.rentalRatePerShift) * shifts;
        return {
          equipmentId: i.equipmentId,
          categorySnapshot: eq.category,
          nameSnapshot: eq.name,
          quantity: i.quantity,
          unitPrice: String(unitPrice),
          lineSum: String(unitPrice * i.quantity),
        };
      });
      const total = lines.reduce((s, l) => s + Number(l.lineSum), 0);
      const finalAmount = o.manualFinalAmount ?? String(total);
      const booking = await kit.prisma.booking.create({
        data: {
          clientId: kit.clientId,
          projectName: o.projectName ?? `Проект ${++kit.seq}`,
          startDate: start,
          endDate: end,
          status: o.status,
          ...(o.status === "ISSUED" || o.status === "RETURNED" ? { issuedAt: new Date(start.getTime()) } : {}),
          ...(o.archived ? { deletedAt: new Date() } : {}),
          totalEstimateAmount: String(total),
          discountAmount: "0",
          finalAmount,
          manualFinalAmount: o.manualFinalAmount ?? null,
          amountOutstanding: finalAmount,
          legacyFinance: false,
          items: { create: o.items.map((i) => ({ equipmentId: i.equipmentId, quantity: i.quantity })) },
          estimates: {
            create: {
              kind: "MAIN",
              shifts,
              subtotal: String(total),
              discountAmount: "0",
              totalAfterDiscount: String(total),
              lines: { create: lines },
            },
          },
        },
        include: { items: true },
      });
      if (o.reserveUnits !== false) {
        for (const bi of booking.items) {
          const eq = eqById.get(bi.equipmentId)!;
          if (eq.stockTrackingMode !== "UNIT") continue;
          const taken = await kit.prisma.bookingItemUnit.findMany({
            where: { returnedAt: null, equipmentUnit: { equipmentId: eq.id } },
            select: { equipmentUnitId: true },
          });
          const free = await kit.prisma.equipmentUnit.findMany({
            where: {
              equipmentId: eq.id,
              status: "AVAILABLE",
              id: { notIn: taken.map((t: AnyRecord) => t.equipmentUnitId) },
            },
            take: bi.quantity,
            orderBy: { id: "asc" },
          });
          for (const u of free) {
            await kit.prisma.bookingItemUnit.create({ data: { bookingItemId: bi.id, equipmentUnitId: u.id } });
            if (o.status === "ISSUED") {
              await kit.prisma.equipmentUnit.update({ where: { id: u.id }, data: { status: "ISSUED" } });
            }
          }
        }
      }
      return booking.id as string;
    },

    async itemOf(bookingId: string, equipmentId: string) {
      return kit.prisma.bookingItem.findFirst({ where: { bookingId, equipmentId } });
    },

    async openSession(token: string, bookingId: string, operation: "ISSUE" | "RETURN") {
      const r = await request(kit.app).post("/api/warehouse/sessions").set(kit.headers(token)).send({ bookingId, operation });
      if (r.status !== 201) throw new Error(`openSession ${r.status}: ${JSON.stringify(r.body)}`);
      return r.body.session as AnyRecord & { id: string; resumed: boolean };
    },

    state(token: string, sessionId: string) {
      return request(kit.app).get(`/api/warehouse/sessions/${sessionId}/state`).set(kit.headers(token));
    },

    complete(token: string, sessionId: string, body: AnyRecord = {}) {
      return request(kit.app).post(`/api/warehouse/sessions/${sessionId}/complete`).set(kit.headers(token)).send(body);
    },

    cancel(token: string, sessionId: string, body?: AnyRecord) {
      const req = request(kit.app).post(`/api/warehouse/sessions/${sessionId}/cancel`).set(kit.headers(token));
      return body ? req.send(body) : req;
    },

    addItem(token: string, sessionId: string, body: AnyRecord) {
      return request(kit.app).post(`/api/warehouse/sessions/${sessionId}/items`).set(kit.headers(token)).send(body);
    },

    /** Кнопка «Выдать» / «Вернуть» на карточке брони. */
    manual(bookingId: string, action: "issue" | "return", token?: string) {
      return request(kit.app)
        .post(`/api/bookings/${bookingId}/status`)
        .set(kit.headers(token ?? kit.saToken))
        .send({ action, force: true });
    },

    get(token: string, url: string) {
      return request(kit.app).get(url).set(kit.headers(token));
    },

    async bookingStatus(bookingId: string) {
      return (await kit.prisma.booking.findUnique({ where: { id: bookingId } })).status as string;
    },

    async sessionRow(sessionId: string) {
      return kit.prisma.scanSession.findUnique({ where: { id: sessionId } });
    },
  };
  return kit;
}
