-- COUNT-mode reports: Repair and ProblemItem accept bookingItemId + quantity
-- instead of requiring a specific EquipmentUnit. SQLite cannot ALTER COLUMN
-- nullability or ADD FOREIGN KEY in place, so we recreate the tables via
-- the standard PRAGMA / temp-table swap pattern.

PRAGMA foreign_keys=OFF;

-- ============================================================================
-- Repair: unitId now nullable + new columns (bookingItemId, quantity)
-- ============================================================================
CREATE TABLE "new_Repair" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "unitId" TEXT,
    "bookingItemId" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'WAITING_REPAIR',
    "urgency" TEXT NOT NULL DEFAULT 'NORMAL',
    "reason" TEXT NOT NULL,
    "sourceBookingId" TEXT,
    "createdBy" TEXT NOT NULL,
    "assignedTo" TEXT,
    "partsCost" DECIMAL NOT NULL DEFAULT 0,
    "totalTimeHours" DECIMAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "closedAt" DATETIME,
    CONSTRAINT "Repair_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "EquipmentUnit" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Repair_bookingItemId_fkey" FOREIGN KEY ("bookingItemId") REFERENCES "BookingItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Repair_sourceBookingId_fkey" FOREIGN KEY ("sourceBookingId") REFERENCES "Booking" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_Repair" (
    "id", "unitId", "status", "urgency", "reason", "sourceBookingId",
    "createdBy", "assignedTo", "partsCost", "totalTimeHours",
    "createdAt", "updatedAt", "closedAt"
)
SELECT
    "id", "unitId", "status", "urgency", "reason", "sourceBookingId",
    "createdBy", "assignedTo", "partsCost", "totalTimeHours",
    "createdAt", "updatedAt", "closedAt"
FROM "Repair";

DROP TABLE "Repair";
ALTER TABLE "new_Repair" RENAME TO "Repair";

CREATE INDEX "Repair_unitId_idx" ON "Repair"("unitId");
CREATE INDEX "Repair_bookingItemId_idx" ON "Repair"("bookingItemId");
CREATE INDEX "Repair_status_idx" ON "Repair"("status");
CREATE INDEX "Repair_assignedTo_idx" ON "Repair"("assignedTo");

-- ============================================================================
-- ProblemItem: equipmentUnitId now nullable + new columns (bookingItemId, quantity)
-- ============================================================================
CREATE TABLE "new_ProblemItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "equipmentUnitId" TEXT,
    "bookingItemId" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "sourceBookingId" TEXT,
    "reason" TEXT NOT NULL,
    "comment" TEXT NOT NULL,
    "expectedBackDate" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'SEARCHING',
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    "resolvedBy" TEXT,
    "resolutionNote" TEXT,
    CONSTRAINT "ProblemItem_equipmentUnitId_fkey" FOREIGN KEY ("equipmentUnitId") REFERENCES "EquipmentUnit" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ProblemItem_bookingItemId_fkey" FOREIGN KEY ("bookingItemId") REFERENCES "BookingItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_ProblemItem" (
    "id", "equipmentUnitId", "sourceBookingId", "reason", "comment",
    "expectedBackDate", "status", "createdBy", "createdAt",
    "resolvedAt", "resolvedBy", "resolutionNote"
)
SELECT
    "id", "equipmentUnitId", "sourceBookingId", "reason", "comment",
    "expectedBackDate", "status", "createdBy", "createdAt",
    "resolvedAt", "resolvedBy", "resolutionNote"
FROM "ProblemItem";

DROP TABLE "ProblemItem";
ALTER TABLE "new_ProblemItem" RENAME TO "ProblemItem";

CREATE INDEX "ProblemItem_status_idx" ON "ProblemItem"("status");
CREATE INDEX "ProblemItem_equipmentUnitId_idx" ON "ProblemItem"("equipmentUnitId");
CREATE INDEX "ProblemItem_bookingItemId_idx" ON "ProblemItem"("bookingItemId");
CREATE INDEX "ProblemItem_sourceBookingId_idx" ON "ProblemItem"("sourceBookingId");

PRAGMA foreign_keys=ON;
