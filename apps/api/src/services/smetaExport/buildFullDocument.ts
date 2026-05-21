import Decimal from "decimal.js";

import { buildSmetaFromPersistedEstimate } from "./buildDocument";
import type { SmetaFullExportDocument } from "./types";

/** Полная смета: main + (опционально) addon. Если addon=null, addonDoc=null. */
export function buildFullSmeta(args: {
  booking: Parameters<typeof buildSmetaFromPersistedEstimate>[0]["booking"];
  main: Parameters<typeof buildSmetaFromPersistedEstimate>[0]["estimate"];
  addon: Parameters<typeof buildSmetaFromPersistedEstimate>[0]["estimate"] | null;
}): SmetaFullExportDocument {
  const mainDoc = buildSmetaFromPersistedEstimate({
    booking: args.booking,
    estimate: { ...args.main, kind: "MAIN" },
  });
  const addonDoc = args.addon
    ? buildSmetaFromPersistedEstimate({
        booking: args.booking,
        estimate: { ...args.addon, kind: "ADDON" },
      })
    : null;
  const mainTotal = new Decimal(mainDoc.totalAfterDiscount);
  const addonTotal = addonDoc ? new Decimal(addonDoc.totalAfterDiscount) : new Decimal(0);
  const grandTotal = mainTotal.add(addonTotal).toDecimalPlaces(2).toString();
  return { main: mainDoc, addon: addonDoc, grandTotal };
}
