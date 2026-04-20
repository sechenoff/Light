-- AlterTable
ALTER TABLE "GafferProject" ADD COLUMN "clientDueAt" DATETIME;

-- AlterTable
ALTER TABLE "GafferProjectMember" ADD COLUMN "dueAt" DATETIME;

-- AlterTable
ALTER TABLE "GafferContact" ADD COLUMN "shiftHours" INTEGER DEFAULT 10;

-- AlterTable
ALTER TABLE "GafferContact" ADD COLUMN "rateCardId" TEXT;

-- AlterTable
ALTER TABLE "GafferContact" ADD COLUMN "rateCardPosition" TEXT;
