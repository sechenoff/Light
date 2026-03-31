import type { VisionProvider } from "./provider";
import { MockVisionProvider } from "./mock";

export type { VisionProvider };
export type { LightingAnalysis, SuggestedEquipmentItem, VisionInput } from "./types";
export { LightingAnalysisSchema, SuggestedEquipmentItemSchema, parseLightingAnalysis } from "./types";

/**
 * Фабрика: возвращает провайдер по значению переменной окружения VISION_PROVIDER.
 *
 * Поддерживаемые значения:
 *   mock   — детерминированный mock (по умолчанию)
 *   gemini — Google Gemini Flash (требует GEMINI_API_KEY)
 *
 * Чтобы добавить новый провайдер:
 *   1. Создать файл vision/<name>.ts, реализовать VisionProvider
 *   2. Добавить case ниже
 */
function createVisionProvider(): VisionProvider {
  const providerName = process.env.VISION_PROVIDER ?? "mock";

  switch (providerName) {
    case "mock":
      return new MockVisionProvider();

    case "gemini": {
      // Ленивый импорт — Gemini-провайдер инициализируется только при явном выборе.
      // Это предотвращает падение при старте если GEMINI_API_KEY не задан.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { GeminiVisionProvider } = require("../gemini") as typeof import("../gemini");
      return new GeminiVisionProvider();
    }

    default:
      throw new Error(
        `Неизвестный VISION_PROVIDER="${providerName}". Допустимые значения: mock, gemini`,
      );
  }
}

/**
 * Активный экземпляр vision-провайдера.
 * Используется во всех роутах и сервисах, которым нужен анализ изображений.
 */
export const visionProvider: VisionProvider = createVisionProvider();
