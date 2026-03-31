import type { LightingAnalysis, VisionInput } from "./types";

/**
 * Контракт для любого vision-провайдера в пайплайне анализа освещения.
 *
 * Для подключения нового провайдера (OpenAI Vision, Anthropic, локальная модель…):
 * 1. Реализовать этот интерфейс
 * 2. Зарегистрировать в vision/index.ts
 */
export interface VisionProvider {
  /** Идентификатор провайдера для логирования */
  readonly name: string;

  /**
   * Анализирует кинематографический кадр.
   * Возвращает вероятную реконструкцию схемы освещения.
   * Бросает ошибку если провайдер недоступен или ответ невалиден.
   */
  analyzePhoto(input: VisionInput): Promise<LightingAnalysis>;

  /**
   * Генерирует PNG-изображение схемы освещения «вид сверху».
   * Возвращает null если провайдер не поддерживает генерацию изображений.
   */
  generateDiagram(description: string): Promise<Buffer | null>;
}
