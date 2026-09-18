-- CreateTable
CREATE TABLE "BookingProject" (
    "bookingId" TEXT NOT NULL PRIMARY KEY,
    "restFactor" DECIMAL NOT NULL DEFAULT 0.5,
    "billingCycle" TEXT NOT NULL DEFAULT 'WEEKLY',
    "paymentTermsDays" INTEGER NOT NULL DEFAULT 7,
    "revision" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "BookingProject_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProjectDay" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookingId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'SHOOT',
    CONSTRAINT "ProjectDay_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "BookingProject" ("bookingId") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProjectLot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookingId" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "nameSnapshot" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "ratePerShift" DECIMAL NOT NULL,
    "fromDate" TEXT NOT NULL,
    "throughDate" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "issuedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectLot_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "BookingProject" ("bookingId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectLot_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProjectLotUnit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lotId" TEXT NOT NULL,
    "equipmentUnitId" TEXT NOT NULL,
    "returnedAt" DATETIME,
    CONSTRAINT "ProjectLotUnit_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "ProjectLot" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectLotUnit_equipmentUnitId_fkey" FOREIGN KEY ("equipmentUnitId") REFERENCES "EquipmentUnit" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProjectLotReturn" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lotId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "lastBillableDate" TEXT NOT NULL,
    "returnedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    CONSTRAINT "ProjectLotReturn_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "ProjectLot" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProjectBillingPeriod" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookingId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "fromDate" TEXT NOT NULL,
    "throughDate" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'PERIOD',
    "correctsId" TEXT,
    "amount" DECIMAL NOT NULL,
    "documentJson" TEXT NOT NULL DEFAULT '{}',
    "linesJson" TEXT NOT NULL,
    "dueDate" DATETIME NOT NULL,
    "invoiceId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectBillingPeriod_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "BookingProject" ("bookingId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectBillingPeriod_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProjectEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookingId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectEvent_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "BookingProject" ("bookingId") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProjectCharge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookingId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectCharge_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "BookingProject" ("bookingId") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Additive SQLite migration: retain Booking/Invoice rows, indexes and triggers.
ALTER TABLE "Booking" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'STANDARD';
ALTER TABLE "Invoice" ADD COLUMN "adjustmentAmount" DECIMAL NOT NULL DEFAULT 0;


-- CreateIndex
CREATE UNIQUE INDEX "ProjectDay_bookingId_date_key" ON "ProjectDay"("bookingId", "date");

-- CreateIndex
CREATE INDEX "ProjectLot_bookingId_status_idx" ON "ProjectLot"("bookingId", "status");

-- CreateIndex
CREATE INDEX "ProjectLot_equipmentId_fromDate_throughDate_idx" ON "ProjectLot"("equipmentId", "fromDate", "throughDate");

-- CreateIndex
CREATE INDEX "ProjectLotUnit_equipmentUnitId_returnedAt_idx" ON "ProjectLotUnit"("equipmentUnitId", "returnedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectLotUnit_lotId_equipmentUnitId_key" ON "ProjectLotUnit"("lotId", "equipmentUnitId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectBillingPeriod_invoiceId_key" ON "ProjectBillingPeriod"("invoiceId");

-- CreateIndex
CREATE INDEX "ProjectBillingPeriod_bookingId_fromDate_idx" ON "ProjectBillingPeriod"("bookingId", "fromDate");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectBillingPeriod_bookingId_requestKey_key" ON "ProjectBillingPeriod"("bookingId", "requestKey");

-- CreateIndex
CREATE INDEX "ProjectEvent_bookingId_createdAt_idx" ON "ProjectEvent"("bookingId", "createdAt");

-- CreateIndex
CREATE INDEX "ProjectCharge_bookingId_date_idx" ON "ProjectCharge"("bookingId", "date");

