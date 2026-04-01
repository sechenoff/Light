-- CreateTable
CREATE TABLE "SlangAlias" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "phraseNormalized" TEXT NOT NULL,
    "phraseOriginal" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "confidence" REAL NOT NULL DEFAULT 1.0,
    "source" TEXT NOT NULL DEFAULT 'approved_candidate',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SlangAlias_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SlangLearningCandidate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "rawPhrase" TEXT NOT NULL,
    "normalizedPhrase" TEXT NOT NULL,
    "proposedEquipmentId" TEXT,
    "proposedEquipmentName" TEXT,
    "confidence" REAL NOT NULL DEFAULT 0.5,
    "contextJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reviewedAt" DATETIME,
    "reviewedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "SlangAlias_phraseNormalized_idx" ON "SlangAlias"("phraseNormalized");

-- CreateIndex
CREATE INDEX "SlangAlias_equipmentId_idx" ON "SlangAlias"("equipmentId");

-- CreateIndex
CREATE UNIQUE INDEX "SlangAlias_phraseNormalized_equipmentId_key" ON "SlangAlias"("phraseNormalized", "equipmentId");

-- CreateIndex
CREATE INDEX "SlangLearningCandidate_status_idx" ON "SlangLearningCandidate"("status");

-- CreateIndex
CREATE INDEX "SlangLearningCandidate_normalizedPhrase_idx" ON "SlangLearningCandidate"("normalizedPhrase");
