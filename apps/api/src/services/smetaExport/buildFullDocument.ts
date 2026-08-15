import Decimal from "decimal.js";

import { buildSmetaFromPersistedEstimate } from "./buildDocument";
import type {
  SmetaFullExportDocument,
  SmetaOrgInfo,
  SmetaTransportLine,
  SmetaTransportSection,
} from "./types";

type MoneyLike = string | number | { toString(): string };

/** BookingVehicle + связанная Vehicle — форма, которую отдают include-запросы роутов. */
export type FullSmetaVehicleRow = {
  withGenerator: boolean;
  shiftHours: MoneyLike | null;
  kmOutsideMkad: number | null;
  ttkEntry: boolean;
  subtotalRub: MoneyLike | null;
  vehicle: { name: string };
};

/**
 * Транспортный блок полной сметы из машин брони. Возвращает null, если машин нет
 * или ни одна не имеет посчитанной суммы — блок «Транспорт: 0 ₽» клиенту не нужен.
 */
export function buildTransportSection(
  vehicles: FullSmetaVehicleRow[] | null | undefined,
): SmetaTransportSection | null {
  if (!vehicles || vehicles.length === 0) return null;

  const lines: SmetaTransportLine[] = vehicles.map((v) => {
    const details: string[] = [];
    if (v.withGenerator) details.push("с генератором");
    const hours = v.shiftHours != null ? Number(v.shiftHours.toString()) : null;
    if (hours && Number.isFinite(hours)) details.push(`смена ${hours} ч`);
    if (v.kmOutsideMkad) details.push(`за МКАД ${v.kmOutsideMkad} км`);
    if (v.ttkEntry) details.push("въезд в ТТК");
    return {
      name: v.vehicle.name,
      details: details.length > 0 ? details.join(" · ") : null,
      sum: new Decimal(v.subtotalRub?.toString() ?? "0").toDecimalPlaces(2).toString(),
    };
  });

  const subtotal = lines.reduce((acc, l) => acc.add(new Decimal(l.sum)), new Decimal(0));
  if (subtotal.lte(0)) return null;

  return { lines, subtotal: subtotal.toDecimalPlaces(2).toString() };
}

/**
 * Полная смета: main + (опционально) addon + (опционально) транспорт.
 * grandTotal = сумма всех присутствующих блоков — то, что клиент платит фактически.
 */
export function buildFullSmeta(args: {
  booking: Parameters<typeof buildSmetaFromPersistedEstimate>[0]["booking"] & {
    vehicles?: FullSmetaVehicleRow[] | null;
  };
  main: Parameters<typeof buildSmetaFromPersistedEstimate>[0]["estimate"];
  addon: Parameters<typeof buildSmetaFromPersistedEstimate>[0]["estimate"] | null;
  org?: SmetaOrgInfo | null;
  /** Booking.manualFinalAmount — сумма, о которой договорились вручную. */
  agreedTotal?: MoneyLike | null;
}): SmetaFullExportDocument {
  const mainDoc = buildSmetaFromPersistedEstimate({
    booking: args.booking,
    estimate: { ...args.main, kind: "MAIN" },
    org: args.org ?? null,
  });
  const addonDoc = args.addon
    ? buildSmetaFromPersistedEstimate({
        booking: args.booking,
        estimate: { ...args.addon, kind: "ADDON" },
        org: args.org ?? null,
      })
    : null;
  const transport = buildTransportSection(args.booking.vehicles);

  const mainTotal = new Decimal(mainDoc.totalAfterDiscount);
  const addonTotal = addonDoc ? new Decimal(addonDoc.totalAfterDiscount) : new Decimal(0);
  const transportTotal = transport ? new Decimal(transport.subtotal) : new Decimal(0);
  const grandTotal = mainTotal.add(addonTotal).add(transportTotal).toDecimalPlaces(2).toString();

  // Договорной итог не заменяет расчёт молча: обе цифры уходят в документ, и
  // рендерер показывает разницу отдельной строкой. Иначе платёжный документ
  // расходился бы со счётом — тот договорную сумму уже чтит.
  const agreed =
    args.agreedTotal != null
      ? new Decimal(args.agreedTotal.toString()).toDecimalPlaces(2).toString()
      : null;

  return { main: mainDoc, addon: addonDoc, transport, grandTotal, agreedTotal: agreed };
}
