import { prisma } from "../prisma";

/** Секреты не должны возвращаться даже из старых снимков. */
export function safeAuditSnapshot(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const clean = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(clean);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value)
            .filter(
              ([key]) =>
                !/(password(?!Changed)|hash|token|secret|api.?key|authorization|cookie)/i.test(
                  key,
                ),
            )
            .map(([key, v]) => [key, clean(v)]),
        );
      return value;
    };
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? JSON.stringify(clean(parsed))
      : null;
  } catch {
    return null;
  }
}

type AuditRow = {
  entityType: string;
  entityId: string;
  before: string | null;
  after: string | null;
};
export async function presentAuditEntries<T extends AuditRow>(rows: T[]) {
  const referenceTypes: Record<string, string> = {
    clientId: "Client",
    bookingId: "Booking",
    userId: "AdminUser",
    assignedTo: "AdminUser",
    createdBy: "AdminUser",
    deletedBy: "AdminUser",
    equipmentId: "Equipment",
    vehicleId: "Vehicle",
    invoiceId: "Invoice",
  };
  const references = new Map<string, Set<string>>();
  const collect = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const type = referenceTypes[key];
      if (type && typeof child === "string") {
        const set = references.get(type) ?? new Set<string>();
        set.add(child);
        references.set(type, set);
      } else if (typeof child === "object") collect(child);
    }
  };
  for (const row of rows) {
    collect(JSON.parse(safeAuditSnapshot(row.before) ?? "{}"));
    collect(JSON.parse(safeAuditSnapshot(row.after) ?? "{}"));
  }
  const ids = (type: string) => [
    ...new Set([
      ...rows.filter((r) => r.entityType === type).map((r) => r.entityId),
      ...(references.get(type) ?? []),
    ]),
  ];
  const [
    bookings,
    users,
    clients,
    equipment,
    vehicles,
    invoices,
    bills,
    tasks,
  ] = await Promise.all([
    prisma.booking.findMany({
      where: { id: { in: ids("Booking") } },
      select: {
        id: true,
        projectName: true,
        docNumber: true,
        client: { select: { name: true } },
      },
    }),
    prisma.adminUser.findMany({
      where: { id: { in: ids("AdminUser") } },
      select: { id: true, username: true },
    }),
    prisma.client.findMany({
      where: { id: { in: ids("Client") } },
      select: { id: true, name: true },
    }),
    prisma.equipment.findMany({
      where: { id: { in: ids("Equipment") } },
      select: { id: true, name: true },
    }),
    prisma.vehicle.findMany({
      where: { id: { in: ids("Vehicle") } },
      select: { id: true, name: true },
    }),
    prisma.invoice.findMany({
      where: { id: { in: ids("Invoice") } },
      select: { id: true, number: true },
    }),
    prisma.bill.findMany({
      where: { id: { in: ids("Bill") } },
      select: { id: true, number: true },
    }),
    prisma.task.findMany({
      where: { id: { in: ids("Task") } },
      select: { id: true, title: true },
    }),
  ]);
  const names = new Map<string, string>();
  for (const b of bookings)
    names.set(
      `Booking:${b.id}`,
      [b.docNumber ? `№ ${b.docNumber}` : null, b.projectName, b.client.name]
        .filter(Boolean)
        .join(" · "),
    );
  for (const u of users) names.set(`AdminUser:${u.id}`, u.username);
  for (const [type, list] of [
    ["Client", clients],
    ["Equipment", equipment],
    ["Vehicle", vehicles],
  ] as const)
    for (const row of list) names.set(`${type}:${row.id}`, row.name);
  for (const [type, list] of [
    ["Invoice", invoices],
    ["Bill", bills],
  ] as const)
    for (const row of list) names.set(`${type}:${row.id}`, `№ ${row.number}`);
  for (const row of tasks) names.set(`Task:${row.id}`, row.title);
  return rows.map((row) => {
    const before = safeAuditSnapshot(row.before),
      after = safeAuditSnapshot(row.after);
    const snapshot = JSON.parse(after ?? before ?? "{}") as Record<
      string,
      unknown
    >;
    const fallback = [
      snapshot.username,
      snapshot.projectName,
      snapshot.name,
      snapshot.number,
    ].find((v) => typeof v === "string");
    const referenceLabels = Object.fromEntries(
      [...names.entries()].map(([key, label]) => [
        key.slice(key.indexOf(":") + 1),
        label,
      ]),
    );
    return {
      ...row,
      before,
      after,
      referenceLabels,
      entityLabel:
        names.get(`${row.entityType}:${row.entityId}`) ?? fallback ?? null,
    };
  });
}
