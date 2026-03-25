import fs from "node:fs/promises";
import path from "node:path";

import { commitEquipmentImport, previewEquipmentImport } from "../src/services/equipmentImport";

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    throw new Error("Usage: tsx scripts/import-xlsx.ts <absolute-path-to-xlsx>");
  }

  const absolute = path.resolve(filePath);
  const buffer = await fs.readFile(absolute);

  const preview = await previewEquipmentImport({ buffer });
  const mapping = preview.suggestedMapping;

  if (!mapping.category || !mapping.name || !mapping.rentalRatePerShift) {
    throw new Error(
      `Auto-mapping failed. Required mapped fields: category, name, rentalRatePerShift. Got: ${JSON.stringify(mapping, null, 2)}`,
    );
  }

  if (!mapping.quantity && !mapping.serialNumber && !mapping.internalInventoryNumber) {
    throw new Error(
      `Auto-mapping failed: need quantity or serial/internal inventory columns. Got: ${JSON.stringify(mapping, null, 2)}`,
    );
  }

  const result = await commitEquipmentImport({
    buffer,
    mapping,
  });

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        file: absolute,
        sheet: preview.sheetName,
        mapping,
        result,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

