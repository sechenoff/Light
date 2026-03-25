-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AppSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AppSetting" ("key", "updatedAt", "value") SELECT "key", "updatedAt", "value" FROM "AppSetting";
DROP TABLE "AppSetting";
ALTER TABLE "new_AppSetting" RENAME TO "AppSetting";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
