-- AlterTable
ALTER TABLE "Booking" ADD COLUMN "estimateOptionalNote" TEXT;
ALTER TABLE "Booking" ADD COLUMN "estimateIncludeOptionalInExport" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Estimate" ADD COLUMN "optionalNote" TEXT;
ALTER TABLE "Estimate" ADD COLUMN "includeOptionalInExport" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Estimate" ADD COLUMN "hoursSummaryText" TEXT;
