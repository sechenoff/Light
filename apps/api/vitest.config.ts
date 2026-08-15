import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    setupFiles: ["./src/__tests__/setup.ts"],
    // Почти каждый интеграционный файл поднимает СВОЮ SQLite-базу через
    // execSync("npx prisma db push --force-reset") в beforeAll — это запуск
    // отдельного процесса Prisma CLI. Дефолтные 10 с на хук закладывались под
    // лёгкий setup: когда полтора десятка таких файлов стартуют параллельно,
    // они не укладываются, и файл падает с «Hook timed out» ещё до первой
    // проверки. Лимиты подняты под реальную стоимость харнесса (2026-08-05).
    // На сами утверждения это не влияет: бюджеты производительности
    // проверяются внутри тестов явными assert'ами по времени.
    hookTimeout: 60_000,
    testTimeout: 20_000,
  },
});
