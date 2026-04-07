import path from "path";

// Set env vars BEFORE any app imports — this file runs as a setupFile in vitest
// so these values are available when test files are evaluated.
const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1,test-key-2";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
// Используем mock-провайдер в тестах — gemini.ts требует нативный require(),
// который не поддерживается в vitest ESM-режиме.
process.env.VISION_PROVIDER = "mock";
