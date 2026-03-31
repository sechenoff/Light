import type { VisionProvider } from "./provider";
import type { LightingAnalysis, VisionInput } from "./types";

/**
 * Mock-реализация VisionProvider для разработки и тестов.
 * Не обращается к внешним API, возвращает детерминированный ответ.
 *
 * Активируется через VISION_PROVIDER=mock в .env
 */
export class MockVisionProvider implements VisionProvider {
  readonly name = "mock";

  async analyzePhoto(_input: VisionInput): Promise<LightingAnalysis> {
    // Имитируем небольшую задержку как у реального провайдера
    await delay(300);

    return {
      description:
        "Вероятная реконструкция: трёхточечное освещение с ключевым светом (Key) слева под углом 45°, " +
        "заполняющим светом (Fill) справа с половинной интенсивностью и контровым светом (Back) сзади " +
        "для отделения субъекта от фона. Фон предположительно освещён отдельным прибором снизу.",
      equipment: [
        { name: "Arri Fresnel 1 кВт", quantity: 1, category: "Осветительные приборы" },
        { name: "Kinoflo 4ft 4bank", quantity: 1, category: "Осветительные приборы" },
        { name: "LED панель 200 Вт", quantity: 1, category: "Осветительные приборы" },
        { name: "Софтбокс 80×80 см", quantity: 1, category: "Рассеиватели и отражатели" },
        { name: "Отражатель 5-в-1", quantity: 1, category: "Рассеиватели и отражатели" },
        { name: "Стойка световая", quantity: 3, category: "Штативы и стойки" },
      ],
    };
  }

  async generateDiagram(_description: string): Promise<Buffer | null> {
    await delay(100);
    return Buffer.from(PLACEHOLDER_PNG_BASE64, "base64");
  }
}

/** 1×1 белый PNG */
const PLACEHOLDER_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVQI12NgAAAAAgAB4iG8MwAAAABJRU5ErkJggg==";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
