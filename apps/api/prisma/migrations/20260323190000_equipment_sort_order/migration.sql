-- Add persistent manual ordering for equipment editor.
ALTER TABLE "Equipment" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- Seed initial order by creation time to keep stable list.
WITH ordered AS (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "createdAt" ASC) - 1 AS rn
  FROM "Equipment"
)
UPDATE "Equipment"
SET "sortOrder" = ordered.rn
FROM ordered
WHERE "Equipment"."id" = ordered."id";

CREATE INDEX "Equipment_sortOrder_idx" ON "Equipment"("sortOrder");
