-- Booking financial fields
ALTER TABLE "Booking" ADD COLUMN "totalEstimateAmount" DECIMAL NOT NULL DEFAULT 0;
ALTER TABLE "Booking" ADD COLUMN "discountAmount" DECIMAL NOT NULL DEFAULT 0;
ALTER TABLE "Booking" ADD COLUMN "finalAmount" DECIMAL NOT NULL DEFAULT 0;
ALTER TABLE "Booking" ADD COLUMN "paymentStatus" TEXT NOT NULL DEFAULT 'NOT_PAID';
ALTER TABLE "Booking" ADD COLUMN "expectedPaymentDate" DATETIME;
ALTER TABLE "Booking" ADD COLUMN "actualPaymentDate" DATETIME;
ALTER TABLE "Booking" ADD COLUMN "paymentComment" TEXT;
ALTER TABLE "Booking" ADD COLUMN "isFullyPaid" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Booking" ADD COLUMN "amountPaid" DECIMAL NOT NULL DEFAULT 0;
ALTER TABLE "Booking" ADD COLUMN "amountOutstanding" DECIMAL NOT NULL DEFAULT 0;

-- Payments
CREATE TABLE "Payment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "bookingId" TEXT,
  "amount" DECIMAL NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'RUB',
  "paymentDate" DATETIME,
  "plannedPaymentDate" DATETIME,
  "paymentMethod" TEXT NOT NULL DEFAULT 'OTHER',
  "direction" TEXT NOT NULL DEFAULT 'INCOME',
  "status" TEXT NOT NULL DEFAULT 'PLANNED',
  "payerName" TEXT,
  "comment" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "Payment_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "Payment_bookingId_idx" ON "Payment"("bookingId");
CREATE INDEX "Payment_status_idx" ON "Payment"("status");
CREATE INDEX "Payment_direction_idx" ON "Payment"("direction");
CREATE INDEX "Payment_plannedPaymentDate_idx" ON "Payment"("plannedPaymentDate");
CREATE INDEX "Payment_paymentDate_idx" ON "Payment"("paymentDate");

-- Expenses
CREATE TABLE "Expense" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "bookingId" TEXT,
  "category" TEXT NOT NULL DEFAULT 'OTHER',
  "name" TEXT NOT NULL,
  "amount" DECIMAL NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'RUB',
  "expenseDate" DATETIME NOT NULL,
  "comment" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "Expense_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "Expense_bookingId_idx" ON "Expense"("bookingId");
CREATE INDEX "Expense_category_idx" ON "Expense"("category");
CREATE INDEX "Expense_expenseDate_idx" ON "Expense"("expenseDate");

-- Booking finance events
CREATE TABLE "BookingFinanceEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "bookingId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "statusFrom" TEXT,
  "statusTo" TEXT,
  "amountDelta" DECIMAL,
  "payloadJson" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BookingFinanceEvent_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "BookingFinanceEvent_bookingId_idx" ON "BookingFinanceEvent"("bookingId");
CREATE INDEX "BookingFinanceEvent_createdAt_idx" ON "BookingFinanceEvent"("createdAt");
