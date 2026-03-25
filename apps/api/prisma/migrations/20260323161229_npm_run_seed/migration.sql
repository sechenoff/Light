-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "comment" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Equipment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "importKey" TEXT NOT NULL,
    "stockTrackingMode" TEXT NOT NULL DEFAULT 'COUNT',
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brand" TEXT,
    "model" TEXT,
    "comment" TEXT,
    "totalQuantity" INTEGER NOT NULL DEFAULT 0,
    "rentalRatePerShift" DECIMAL NOT NULL,
    "rentalRateTwoShifts" DECIMAL,
    "rentalRatePerProject" DECIMAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "EquipmentUnit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "equipmentId" TEXT NOT NULL,
    "serialNumber" TEXT,
    "internalInventoryNumber" TEXT,
    "comment" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EquipmentUnit_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "projectName" TEXT NOT NULL,
    "startDate" DATETIME NOT NULL,
    "endDate" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "comment" TEXT,
    "discountPercent" DECIMAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "confirmedAt" DATETIME,
    CONSTRAINT "Booking_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BookingItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookingId" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BookingItem_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BookingItem_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BookingItemUnit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookingItemId" TEXT NOT NULL,
    "equipmentUnitId" TEXT NOT NULL,
    CONSTRAINT "BookingItemUnit_bookingItemId_fkey" FOREIGN KEY ("bookingItemId") REFERENCES "BookingItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BookingItemUnit_equipmentUnitId_fkey" FOREIGN KEY ("equipmentUnitId") REFERENCES "EquipmentUnit" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Estimate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookingId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "shifts" INTEGER NOT NULL,
    "subtotal" DECIMAL NOT NULL,
    "discountPercent" DECIMAL,
    "discountAmount" DECIMAL NOT NULL,
    "totalAfterDiscount" DECIMAL NOT NULL,
    "commentSnapshot" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Estimate_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EstimateLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "estimateId" TEXT NOT NULL,
    "equipmentId" TEXT,
    "categorySnapshot" TEXT NOT NULL,
    "nameSnapshot" TEXT NOT NULL,
    "brandSnapshot" TEXT,
    "modelSnapshot" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL NOT NULL,
    "lineSum" DECIMAL NOT NULL,
    CONSTRAINT "EstimateLine_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Client_name_key" ON "Client"("name");

-- CreateIndex
CREATE INDEX "Client_name_idx" ON "Client"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Equipment_importKey_key" ON "Equipment"("importKey");

-- CreateIndex
CREATE INDEX "Equipment_category_idx" ON "Equipment"("category");

-- CreateIndex
CREATE INDEX "Equipment_name_idx" ON "Equipment"("name");

-- CreateIndex
CREATE UNIQUE INDEX "EquipmentUnit_serialNumber_key" ON "EquipmentUnit"("serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "EquipmentUnit_internalInventoryNumber_key" ON "EquipmentUnit"("internalInventoryNumber");

-- CreateIndex
CREATE INDEX "EquipmentUnit_equipmentId_idx" ON "EquipmentUnit"("equipmentId");

-- CreateIndex
CREATE INDEX "Booking_startDate_idx" ON "Booking"("startDate");

-- CreateIndex
CREATE INDEX "Booking_endDate_idx" ON "Booking"("endDate");

-- CreateIndex
CREATE INDEX "Booking_status_idx" ON "Booking"("status");

-- CreateIndex
CREATE INDEX "BookingItem_equipmentId_idx" ON "BookingItem"("equipmentId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingItem_bookingId_equipmentId_key" ON "BookingItem"("bookingId", "equipmentId");

-- CreateIndex
CREATE INDEX "BookingItemUnit_equipmentUnitId_idx" ON "BookingItemUnit"("equipmentUnitId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingItemUnit_bookingItemId_equipmentUnitId_key" ON "BookingItemUnit"("bookingItemId", "equipmentUnitId");

-- CreateIndex
CREATE UNIQUE INDEX "Estimate_bookingId_key" ON "Estimate"("bookingId");

-- CreateIndex
CREATE INDEX "EstimateLine_estimateId_idx" ON "EstimateLine"("estimateId");
