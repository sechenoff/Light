/**
 * Жизненный цикл сессии киоска: открытие, завершение, прерывание.
 *
 * Регрессии прода (аудит «Выдача и приёмка», сентябрь 2026):
 *  - «Готово» на забытом планшете возвращал принятую кнопкой бронь в «Выдана»
 *    и заводил потеряшки задним числом — устаревшая сессия теперь 409 и
 *    закрывается;
 *  - повтор и параллельный «Готово» давали 500 «Сессия должна быть активной»
 *    и двойные потеряшки/ремонты — теперь сессия захватывается первой записью
 *    транзакции, второй запрос получает 409 с тем, кто и когда завершил;
 *  - в сессии записан тот, кто открыл, а не тот, кто завершил;
 *  - киоск выдавал бронь за недели до начала без вопросов;
 *  - «Готово» с обнулёнными строками «выдавал» пустую бронь;
 *  - правка состава брони во время выдачи ломала «Готово» 400-м;
 *  - брошенную сессию нечем было закрыть.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import { DAY, HOUR, kioskTestKit } from "./kioskTestKit";

const kit = kioskTestKit("scan-session-lifecycle");

beforeAll(() => kit.boot(), 120_000);
afterAll(() => kit.shutdown());

const CLOSED_CODES = ["SESSION_STALE", "SESSION_CANCELLED"];

async function auditOf(bookingId: string, action: string) {
  return kit.prisma.auditEntry.findMany({ where: { entityId: bookingId, action }, orderBy: { createdAt: "asc" } });
}

describe("устаревшая сессия не завершается", () => {
  it("выдачу, брошенную до ручных «Выдать» и «Вернуть», нельзя завершить: бронь остаётся принятой", async () => {
    const eq = await kit.mkEquipment();
    const b = await kit.mkBooking({ status: "CONFIRMED", items: [{ equipmentId: eq, quantity: 2 }] });
    const stale = await kit.openSession(kit.pinToken, b, "ISSUE");
    expect((await kit.manual(b, "issue")).status).toBe(200);
    expect((await kit.manual(b, "return")).status).toBe(200);
    const bi = await kit.itemOf(b, eq);

    const res = await kit.complete(kit.pinToken, stale.id, {
      issuanceAdjustments: [{ bookingItemId: bi.id, actualQuantity: 5 }],
    });

    expect(res.status).toBe(409);
    expect(CLOSED_CODES).toContain(res.body.code);
    expect(await kit.bookingStatus(b)).toBe("RETURNED");
    expect((await kit.itemOf(b, eq)).quantity).toBe(2);
    expect((await kit.sessionRow(stale.id)).status).toBe("CANCELLED");
    const inWork = await kit.get(kit.whToken, "/api/warehouse/in-work");
    expect(JSON.stringify(inWork.body)).not.toContain(b);
  });

  it("бронь выдали мимо киоска: 409 SESSION_STALE с понятным текстом, сессия закрыта с причиной STALE", async () => {
    const eq = await kit.mkEquipment();
    const b = await kit.mkBooking({ status: "CONFIRMED", items: [{ equipmentId: eq, quantity: 2 }] });
    const s = await kit.openSession(kit.pinToken, b, "ISSUE");
    // Так живут 8 сессий на проде: бронь сменила статус, сессию никто не закрыл.
    await kit.prisma.booking.update({ where: { id: b }, data: { status: "ISSUED", issuedAt: new Date() } });
    const bi = await kit.itemOf(b, eq);

    const res = await kit.complete(kit.pinToken, s.id, {
      issuanceAdjustments: [{ bookingItemId: bi.id, actualQuantity: 1 }],
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SESSION_STALE");
    expect(res.body.message).toBe("Бронь уже выдана на карточке — чек-лист закрыт, изменения из него не применены");
    expect(res.body.details).toMatchObject({ sessionId: s.id, operation: "ISSUE", bookingStatus: "ISSUED" });
    expect((await kit.itemOf(b, eq)).quantity).toBe(2);
    const row = await kit.sessionRow(s.id);
    expect(row.status).toBe("CANCELLED");
    expect(row.cancelReason).toBe("STALE");
    const audit = await auditOf(b, "SCAN_SESSION_CANCELLED");
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].after)).toMatchObject({ sessionId: s.id, reason: "STALE" });

    // Повтор — уже «прервана», не «устарела»: сессия закрыта первым обращением.
    const again = await kit.complete(kit.pinToken, s.id, {});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("SESSION_CANCELLED");
  });

  it("бронь вернули на согласование: забытая выдача её не выдаёт", async () => {
    const eq = await kit.mkEquipment();
    const b = await kit.mkBooking({ status: "CONFIRMED", items: [{ equipmentId: eq, quantity: 1 }] });
    const s = await kit.openSession(kit.whToken, b, "ISSUE");
    await kit.prisma.booking.update({ where: { id: b }, data: { status: "PENDING_APPROVAL" } });

    const res = await kit.complete(kit.whToken, s.id, {});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SESSION_STALE");
    expect(res.body.message).toBe("Бронь вернули на согласование — выдавать пока нельзя");
    expect(await kit.bookingStatus(b)).toBe("PENDING_APPROVAL");
  });

  it("приёмка, брошенная до ручного «Вернуть»: 409, потеряшки задним числом не заводятся", async () => {
    const eq = await kit.mkEquipment();
    const b = await kit.mkBooking({ status: "ISSUED", items: [{ equipmentId: eq, quantity: 2 }] });
    const s = await kit.openSession(kit.pinToken, b, "RETURN");
    expect((await kit.manual(b, "return")).status).toBe(200);
    const bi = await kit.itemOf(b, eq);

    const res = await kit.complete(kit.pinToken, s.id, {
      problemUnits: [{ bookingItemId: bi.id, quantity: 2, reason: "LOST", comment: "не привезли" }],
    });

    expect(res.status).toBe(409);
    expect(CLOSED_CODES).toContain(res.body.code);
    expect(await kit.prisma.problemItem.count({ where: { bookingItemId: bi.id } })).toBe(0);
    expect(await kit.bookingStatus(b)).toBe("RETURNED");
  });
});

describe("повтор и гонки «Готово»", () => {
  it("повторное «Готово» выдачи → 409 с тем, кто завершил; отмена завершённой → 409; деньги не задвоены", async () => {
    const eqA = await kit.mkEquipment();
    const eqB = await kit.mkEquipment({ rate: "400" });
    const b = await kit.mkBooking({ status: "CONFIRMED", items: [{ equipmentId: eqA, quantity: 1 }] });
    const s = await kit.openSession(kit.whToken, b, "ISSUE");
    expect((await kit.addItem(kit.whToken, s.id, { equipmentId: eqB, quantity: 1 })).status).toBe(201);

    const first = await kit.complete(kit.whToken, s.id, {});
    expect(first.status).toBe(200);
    const fin1 = Number((await kit.prisma.booking.findUnique({ where: { id: b } })).finalAmount);

    const second = await kit.complete(kit.whToken, s.id, {});
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("SESSION_ALREADY_COMPLETED");
    expect(second.body.message).toBe("Выдача по этой брони уже оформлена");
    expect(second.body.details).toMatchObject({ sessionId: s.id, operation: "ISSUE", completedBy: kit.whName });
    expect(second.body.details.completedAt).toBeTruthy();

    const cancel = await kit.cancel(kit.whToken, s.id);
    expect(cancel.status).toBe(409);
    expect(cancel.body.code).toBe("SESSION_ALREADY_COMPLETED");

    const after = await kit.prisma.booking.findUnique({ where: { id: b } });
    expect(after.status).toBe("ISSUED");
    expect(Number(after.finalAmount)).toBe(fin1);
    expect(await auditOf(b, "BOOKING_ISSUED")).toHaveLength(1);
  });

  it("два одновременных «Готово» приёмки: один проходит, второй 409; одна потеряшка и один ремонт", async () => {
    const eq = await kit.mkEquipment();
    const b = await kit.mkBooking({ status: "ISSUED", items: [{ equipmentId: eq, quantity: 3 }] });
    const s = await kit.openSession(kit.pinToken, b, "RETURN");
    const bi = await kit.itemOf(b, eq);
    const body = {
      problemUnits: [{ bookingItemId: bi.id, quantity: 1, reason: "LOST", comment: "нет на возврате" }],
      repairUnits: [{ bookingItemId: bi.id, quantity: 1, comment: "сломано" }],
    };

    const [r1, r2] = await Promise.all([kit.complete(kit.pinToken, s.id, body), kit.complete(kit.pinToken, s.id, body)]);

    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(loser.body.code).toBe("SESSION_ALREADY_COMPLETED");
    expect(await kit.prisma.problemItem.count({ where: { bookingItemId: bi.id } })).toBe(1);
    expect(await kit.prisma.repair.count({ where: { bookingItemId: bi.id } })).toBe(1);
    expect(await auditOf(b, "BOOKING_RETURNED")).toHaveLength(1);
  });

  it("второй планшет продолжает ту же приёмку; его «Готово» после первого — 409, а не тихая потеря поломки", async () => {
    const eq = await kit.mkEquipment();
    const b = await kit.mkBooking({ status: "ISSUED", items: [{ equipmentId: eq, quantity: 4 }] });
    const a = await kit.openSession(kit.pinToken, b, "RETURN");
    const other = await kit.openSession(kit.whToken, b, "RETURN");
    expect(other.id).toBe(a.id);
    expect(other.resumed).toBe(true);
    const bi = await kit.itemOf(b, eq);

    expect((await kit.complete(kit.pinToken, a.id, {})).status).toBe(200);
    const second = await kit.complete(kit.whToken, a.id, {
      repairUnits: [{ bookingItemId: bi.id, quantity: 1, comment: "треснула пружина" }],
    });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("SESSION_ALREADY_COMPLETED");
    expect(second.body.message).toBe("Приёмка по этой брони уже завершена");
    expect(second.body.details.completedBy).toBe(kit.pinName);
  });
});

describe("большая бронь", () => {
  it("70 строк: выдача со степпером по каждой строке и приёмка с поломками укладываются в транзакцию", async () => {
    const items: Array<{ equipmentId: string; quantity: number }> = [];
    for (let i = 0; i < 70; i++) items.push({ equipmentId: await kit.mkEquipment({ total: 10 }), quantity: 3 });
    const b = await kit.mkBooking({ status: "CONFIRMED", items });
    const rows = await kit.prisma.bookingItem.findMany({ where: { bookingId: b } });

    const s = await kit.openSession(kit.whToken, b, "ISSUE");
    const started = Date.now();
    const issued = await kit.complete(kit.whToken, s.id, {
      issuanceAdjustments: rows.map((r: any) => ({ bookingItemId: r.id, actualQuantity: 2 })),
    });
    expect(issued.status).toBe(200);
    expect(Number(issued.body.mainAfterDiscount)).toBe(70 * 2 * 1000);

    const r = await kit.openSession(kit.whToken, b, "RETURN");
    const returned = await kit.complete(kit.whToken, r.id, {
      repairUnits: rows.map((x: any) => ({ bookingItemId: x.id, quantity: 1, comment: "проверить" })),
      problemUnits: rows.slice(0, 20).map((x: any) => ({ bookingItemId: x.id, quantity: 1, reason: "LOST", comment: "нет" })),
    });
    expect(returned.status).toBe(200);
    expect(returned.body.createdRepairIds).toHaveLength(70);
    expect(returned.body.createdProblemItemIds).toHaveLength(20);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 60_000);
});

describe("кто завершил", () => {
  it("приёмку открыл один, завершил другой — в сессии записан завершивший, открывший сохранён", async () => {
    const eq = await kit.mkEquipment();
    const b = await kit.mkBooking({ status: "ISSUED", items: [{ equipmentId: eq, quantity: 1 }] });
    const s = await kit.openSession(kit.pinToken, b, "RETURN");

    const res = await kit.complete(kit.whToken, s.id, {});
    expect(res.status).toBe(200);
    expect(res.body.completedBy).toBe(kit.whName);
    expect(res.body.bookingStatus).toBe("RETURNED");
    const row = await kit.sessionRow(s.id);
    expect(row.completedBy).toBe(kit.whName);
    expect(row.workerName).toBe(kit.pinName);
  });
});

describe("защита от устаревшего экрана", () => {
  it("itemsVersion: состав изменился — 409 CHECKLIST_OUTDATED, совпал — выдача проходит", async () => {
    const eq = await kit.mkEquipment();
    const b = await kit.mkBooking({ status: "CONFIRMED", items: [{ equipmentId: eq, quantity: 2 }] });
    const s = await kit.openSession(kit.whToken, b, "ISSUE");
    const st = await kit.state(kit.whToken, s.id);
    expect(st.status).toBe(200);
    const { itemsVersion } = st.body;
    expect(typeof itemsVersion).toBe("string");

    // Руководитель поправил количество, пока кладовщик смотрел на старый список.
    await kit.prisma.bookingItem.updateMany({ where: { bookingId: b }, data: { quantity: 3 } });
    const stale = await kit.complete(kit.whToken, s.id, { itemsVersion });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("CHECKLIST_OUTDATED");
    expect(await kit.bookingStatus(b)).toBe("CONFIRMED");
    expect((await kit.sessionRow(s.id)).status).toBe("ACTIVE");

    const fresh = await kit.state(kit.whToken, s.id);
    const ok = await kit.complete(kit.whToken, s.id, { itemsVersion: fresh.body.itemsVersion });
    expect(ok.status).toBe(200);
    expect(await kit.bookingStatus(b)).toBe("ISSUED");
  });

  it("позицию брони пересоздали во время выдачи — корректировка по старому id: 409 CHECKLIST_OUTDATED, а не 400", async () => {
    const eq = await kit.mkEquipment();
    const b = await kit.mkBooking({ status: "CONFIRMED", items: [{ equipmentId: eq, quantity: 4 }] });
    const s = await kit.openSession(kit.whToken, b, "ISSUE");
    const oldItem = await kit.itemOf(b, eq);
    // Как PATCH состава: позиции удаляются и создаются заново с новыми id.
    await kit.prisma.bookingItem.delete({ where: { id: oldItem.id } });
    await kit.prisma.bookingItem.create({ data: { bookingId: b, equipmentId: eq, quantity: 5 } });

    const res = await kit.complete(kit.whToken, s.id, {
      issuanceAdjustments: [{ bookingItemId: oldItem.id, actualQuantity: 3 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CHECKLIST_OUTDATED");
    expect(res.body.message).toBe(
      "Состав брони изменился, пока был открыт чек-лист — список обновлён, проверьте строки",
    );
    expect(res.body.details.unknownBookingItemIds).toEqual([oldItem.id]);
    expect(await kit.bookingStatus(b)).toBe("CONFIRMED");
    expect((await kit.sessionRow(s.id)).status).toBe("ACTIVE");
  });

  it("draftRevision: черновик сохранили на другом планшете — 409 DRAFT_OUTDATED со свежим черновиком", async () => {
    const eq = await kit.mkEquipment();
    const b = await kit.mkBooking({ status: "CONFIRMED", items: [{ equipmentId: eq, quantity: 2 }] });
    const s = await kit.openSession(kit.pinToken, b, "ISSUE");
    const bi = await kit.itemOf(b, eq);
    const draft = (qty: number) => ({ v: 1, issue: { rows: { [bi.id]: { qty, checked: true, equipmentId: eq } } } });
    const put = (revision: number, qty: number, token = kit.pinToken) =>
      request(kit.app)
        .put(`/api/warehouse/sessions/${s.id}/draft`)
        .set(kit.headers(token))
        .send({ revision, draft: draft(qty) });

    const r1 = await put(0, 1);
    expect(r1.status).toBe(200);
    expect(r1.body.revision).toBe(1);
    const r2 = await put(1, 2, kit.whToken);
    expect(r2.body.revision).toBe(2);

    const res = await kit.complete(kit.pinToken, s.id, { draftRevision: 1 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DRAFT_OUTDATED");
    expect(res.body.details).toMatchObject({ revision: 2, savedBy: kit.whName });
    expect(res.body.details.draft.issue.rows[bi.id].qty).toBe(2);
    expect(await kit.bookingStatus(b)).toBe("CONFIRMED");

    expect((await kit.complete(kit.pinToken, s.id, { draftRevision: 2 })).status).toBe(200);
  });
});

describe("ранняя выдача", () => {
  it("киоск не выдаёт бронь за пять дней до начала без подтверждения — тот же текст, что у кнопки", async () => {
    const eq = await kit.mkEquipment();
    const b = await kit.mkBooking({
      status: "CONFIRMED",
      items: [{ equipmentId: eq, quantity: 1 }],
      startOffsetMs: 5 * DAY,
    });
    const s = await kit.openSession(kit.whToken, b, "ISSUE");

    const res = await kit.complete(kit.whToken, s.id, {});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ISSUE_TOO_EARLY");
    expect(res.body.details.startDate).toBeTruthy();
    const button = await request(kit.app)
      .post(`/api/bookings/${b}/status`)
      .set(kit.headers(kit.saToken))
      .send({ action: "issue" });
    expect(button.body.code).toBe("ISSUE_TOO_EARLY");
    expect(res.body.message).toBe(button.body.message);
    expect(await kit.bookingStatus(b)).toBe("CONFIRMED");
    expect((await kit.sessionRow(s.id)).status).toBe("ACTIVE");

    const forced = await kit.complete(kit.whToken, s.id, { force: true });
    expect(forced.status).toBe(200);
    expect(await kit.bookingStatus(b)).toBe("ISSUED");
    const audit = await auditOf(b, "BOOKING_ISSUED");
    expect(JSON.parse(audit[0].after)).toMatchObject({ via: "kiosk", forcedEarlyIssue: true });
  });

  it("за 23 часа до начала подтверждение не нужно", async () => {
    const eq = await kit.mkEquipment();
    const b = await kit.mkBooking({
      status: "CONFIRMED",
      items: [{ equipmentId: eq, quantity: 1 }],
      startOffsetMs: 23 * HOUR,
    });
    const s = await kit.openSession(kit.whToken, b, "ISSUE");
    expect((await kit.complete(kit.whToken, s.id, {})).status).toBe(200);
    const audit = await auditOf(b, "BOOKING_ISSUED");
    expect(JSON.parse(audit[0].after).forcedEarlyIssue).toBeUndefined();
  });
});

describe("обнулённые строки", () => {
  it("все строки обнулены — 409 NOTHING_TO_ISSUE, смета и статус не тронуты", async () => {
    const eq = await kit.mkEquipment();
    const b = await kit.mkBooking({ status: "CONFIRMED", items: [{ equipmentId: eq, quantity: 2 }] });
    const s = await kit.openSession(kit.whToken, b, "ISSUE");
    const bi = await kit.itemOf(b, eq);

    const res = await kit.complete(kit.whToken, s.id, {
      issuanceAdjustments: [{ bookingItemId: bi.id, actualQuantity: 0 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NOTHING_TO_ISSUE");
    expect(res.body.message).toMatch(/отмените её на карточке брони/);
    const after = await kit.prisma.booking.findUnique({ where: { id: b }, include: { estimates: { include: { lines: true } }, items: true } });
    expect(after.status).toBe("CONFIRMED");
    expect(after.items[0].quantity).toBe(2);
    expect(after.estimates.find((e: any) => e.kind === "MAIN").lines).toHaveLength(1);
  });

  it("строка, обнулённая на выдаче, не показывается в «В работе»", async () => {
    const eqA = await kit.mkEquipment({ name: "Остаётся у клиента" });
    const eqB = await kit.mkEquipment({ name: "Не поехал" });
    const b = await kit.mkBooking({
      status: "CONFIRMED",
      items: [{ equipmentId: eqA, quantity: 2 }, { equipmentId: eqB, quantity: 1 }],
    });
    const s = await kit.openSession(kit.whToken, b, "ISSUE");
    const biB = await kit.itemOf(b, eqB);
    expect((await kit.complete(kit.whToken, s.id, {
      issuanceAdjustments: [{ bookingItemId: biB.id, actualQuantity: 0 }],
    })).status).toBe(200);

    const details = await kit.get(kit.whToken, `/api/warehouse/in-work/${b}/details`);
    expect(details.status).toBe(200);
    expect(details.body.items.map((i: any) => i.equipmentName)).toEqual(["Остаётся у клиента"]);
  });
});

describe("открытие сессии", () => {
  it("выдачу уже выданной брони не открыть — подсказка про «+ Добор»", async () => {
    const eq = await kit.mkEquipment();
    const b = await kit.mkBooking({ status: "ISSUED", items: [{ equipmentId: eq, quantity: 1 }] });
    const res = await request(kit.app)
      .post("/api/warehouse/sessions")
      .set(kit.headers(kit.whToken))
      .send({ bookingId: b, operation: "ISSUE" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BOOKING_WRONG_STATUS");
    expect(res.body.message).toMatch(/«\+ Добор» на карточке брони/);
  });

  it("открытие приёмки закрывает брошенную выдачу этой брони", async () => {
    const eq = await kit.mkEquipment();
    const b = await kit.mkBooking({ status: "CONFIRMED", items: [{ equipmentId: eq, quantity: 1 }] });
    const issue = await kit.openSession(kit.pinToken, b, "ISSUE");
    await kit.prisma.booking.update({ where: { id: b }, data: { status: "ISSUED", issuedAt: new Date() } });

    const ret = await kit.openSession(kit.whToken, b, "RETURN");
    expect(ret.resumed).toBe(false);
    expect(ret.closedStaleSessionIds).toEqual([issue.id]);
    const closed = await kit.sessionRow(issue.id);
    expect(closed.status).toBe("CANCELLED");
    expect(closed.cancelReason).toBe("STALE");
  });

  it("повторное открытие продолжает сессию и не отдаёт тело черновика", async () => {
    const eq = await kit.mkEquipment();
    const b = await kit.mkBooking({ status: "CONFIRMED", items: [{ equipmentId: eq, quantity: 1 }] });
    const first = await kit.openSession(kit.pinToken, b, "ISSUE");
    expect(first.hasDraft).toBe(false);
    await kit.prisma.scanSession.update({ where: { id: first.id }, data: { draftJson: '{"v":1}', draftRevision: 1 } });

    const again = await kit.openSession(kit.whToken, b, "ISSUE");
    expect(again.id).toBe(first.id);
    expect(again.resumed).toBe(true);
    expect(again.workerName).toBe(kit.pinName);
    expect(again.hasDraft).toBe(true);
    expect(again.draftJson).toBeUndefined();
  });
});

describe("прервать сессию", () => {
  it("«Прервать выдачу» по PIN: сессия закрыта, в журнале брони — кладовщик от имени склада", async () => {
    const eq = await kit.mkEquipment();
    const b = await kit.mkBooking({ status: "CONFIRMED", items: [{ equipmentId: eq, quantity: 1 }] });
    const s = await kit.openSession(kit.pinToken, b, "ISSUE");

    const res = await kit.cancel(kit.pinToken, s.id, { reason: "KIOSK_ABORT" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: s.id, status: "CANCELLED", cancelled: true, cancelReason: "KIOSK_ABORT" });
    expect(res.body.cancelledBy).toBe(kit.pinName);
    const audit = await auditOf(b, "SCAN_SESSION_CANCELLED");
    expect(audit).toHaveLength(1);
    expect(audit[0].userId).toBe("_system_");
    expect(JSON.parse(audit[0].after)).toMatchObject({
      sessionId: s.id,
      operation: "ISSUE",
      reason: "KIOSK_ABORT",
      workerName: kit.pinName,
    });
    expect(await kit.bookingStatus(b)).toBe("CONFIRMED");
  });

  it("прервать из CRM главной сессией: автор — сотрудник, без подписи «склад»", async () => {
    const eq = await kit.mkEquipment();
    const b = await kit.mkBooking({ status: "ISSUED", items: [{ equipmentId: eq, quantity: 1 }] });
    const s = await kit.openSession(kit.pinToken, b, "RETURN");

    const res = await kit.cancel(kit.whToken, s.id, { reason: "CARD_ABORT" });
    expect(res.status).toBe(200);
    expect(res.body.cancelledBy).toBe(kit.whName);
    const [audit] = await auditOf(b, "SCAN_SESSION_CANCELLED");
    expect(audit.userId).toBe(kit.whId);
    const after = JSON.parse(audit.after);
    expect(after.reason).toBe("CARD_ABORT");
    expect(after.workerName).toBeUndefined();
  });

  it("onlyIfEmpty: пустую сессию закрывает, сессию с черновиком или добором — нет", async () => {
    const eq = await kit.mkEquipment();
    const eqAddon = await kit.mkEquipment();

    const empty = await kit.openSession(
      kit.pinToken,
      await kit.mkBooking({ status: "CONFIRMED", items: [{ equipmentId: eq, quantity: 1 }] }),
      "ISSUE",
    );
    const r1 = await kit.cancel(kit.pinToken, empty.id, { reason: "EMPTY_LEAVE", onlyIfEmpty: true });
    expect(r1.body).toMatchObject({ cancelled: true, status: "CANCELLED", cancelReason: "EMPTY_LEAVE" });

    const withDraft = await kit.openSession(
      kit.pinToken,
      await kit.mkBooking({ status: "CONFIRMED", items: [{ equipmentId: eq, quantity: 1 }] }),
      "ISSUE",
    );
    await kit.prisma.scanSession.update({ where: { id: withDraft.id }, data: { draftJson: '{"v":1}' } });
    const r2 = await kit.cancel(kit.pinToken, withDraft.id, { reason: "EMPTY_LEAVE", onlyIfEmpty: true });
    expect(r2.status).toBe(200);
    expect(r2.body).toMatchObject({ cancelled: false, status: "ACTIVE" });
    expect(r2.body.draftJson).toBeUndefined();

    const withAddon = await kit.openSession(
      kit.pinToken,
      await kit.mkBooking({ status: "CONFIRMED", items: [{ equipmentId: eq, quantity: 1 }] }),
      "ISSUE",
    );
    expect((await kit.addItem(kit.pinToken, withAddon.id, { equipmentId: eqAddon, quantity: 1 })).status).toBe(201);
    const r3 = await kit.cancel(kit.pinToken, withAddon.id, { reason: "EMPTY_LEAVE", onlyIfEmpty: true });
    expect(r3.body.cancelled).toBe(false);
    expect((await kit.sessionRow(withAddon.id)).status).toBe("ACTIVE");
  });

  it("устаревшую сессию закрывает всегда, с причиной STALE", async () => {
    const eq = await kit.mkEquipment();
    const b = await kit.mkBooking({ status: "CONFIRMED", items: [{ equipmentId: eq, quantity: 1 }] });
    const s = await kit.openSession(kit.pinToken, b, "ISSUE");
    await kit.prisma.scanSession.update({ where: { id: s.id }, data: { draftJson: '{"v":1}' } });
    await kit.prisma.booking.update({ where: { id: b }, data: { status: "CANCELLED" } });

    const res = await kit.cancel(kit.pinToken, s.id, { reason: "EMPTY_LEAVE", onlyIfEmpty: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ cancelled: true, cancelReason: "STALE" });
  });

  it("чужая причина из киоска — 400; несуществующая сессия — 404 SESSION_NOT_FOUND", async () => {
    const eq = await kit.mkEquipment();
    const s = await kit.openSession(
      kit.pinToken,
      await kit.mkBooking({ status: "CONFIRMED", items: [{ equipmentId: eq, quantity: 1 }] }),
      "ISSUE",
    );
    expect((await kit.cancel(kit.pinToken, s.id, { reason: "STALE" })).status).toBe(400);
    const missing = await kit.cancel(kit.pinToken, "no-such-session");
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("SESSION_NOT_FOUND");
    const missingComplete = await kit.complete(kit.pinToken, "no-such-session", {});
    expect(missingComplete.status).toBe(404);
    expect(missingComplete.body.code).toBe("SESSION_NOT_FOUND");
  });
});
