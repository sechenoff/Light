-- Add Booking.issuedAt for honest «взято {date}» on /in-work cards.
-- Nullable, no backfill — historical bookings keep `issuedAt = null` and
-- the frontend falls back gracefully to confirmedAt-derived label.
ALTER TABLE "Booking" ADD COLUMN "issuedAt" DATETIME;
