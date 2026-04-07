/**
 * Утилита для генерации аббревиатуры штрихкода оборудования.
 * Паттерн: LR-{ABBREV}{NUM}-{SEQ} (например, "LR-SKY60-003")
 */

/** Маппинг кириллических категорий/слов → латинские аббревиатуры */
const CYRILLIC_ABBREV_MAP: Record<string, string> = {
  // Категории
  "led панели": "LED",
  "лед панели": "LED",
  "светодиодные панели": "LED",
  "галогенные приборы": "HAL",
  "гмн приборы": "HMI",
  "гми приборы": "HMI",
  "гмнi приборы": "HMI",
  "фрезнели": "FRS",
  "прожекторы": "PRJ",
  "рефлекторы": "REF",
  "флуоресцентные": "FLR",
  "флуоресцент": "FLR",
  "rgb": "RGB",
  "матрицы": "MTX",
  "пятно": "SPT",
  "заливка": "FLD",
  "прочее": "OTH",
  "аксессуары": "ACC",
  "штативы": "STD",
  "кабели": "CBL",
  "диффузоры": "DIF",
  "генераторы": "GEN",
  "кейсы": "CAS",
  "сетки": "GRD",
  "рамки": "FRM",
  // Английские категории
  "led": "LED",
  "hmi": "HMI",
  "fresnel": "FRS",
  "par": "PAR",
  "softbox": "SBX",
  "chimera": "CHM",
};

/** Маппинг кириллических слов → латинские для имён приборов */
const NAME_WORD_MAP: Record<string, string> = {
  "скайпанель": "SKY",
  "скайпанел": "SKY",
  "арри": "ARR",
  "кино": "KNO",
  "астра": "AST",
  "лайт": "LGT",
  "панель": "PNL",
  "прибор": "DEV",
};

/**
 * Транслитерирует кириллические символы в латиницу.
 * Используется как запасной вариант для неизвестных слов.
 */
function transliterate(text: string): string {
  const map: Record<string, string> = {
    а: "A", б: "B", в: "V", г: "G", д: "D", е: "E", ё: "YO",
    ж: "ZH", з: "Z", и: "I", й: "Y", к: "K", л: "L", м: "M",
    н: "N", о: "O", п: "P", р: "R", с: "S", т: "T", у: "U",
    ф: "F", х: "KH", ц: "TS", ч: "CH", ш: "SH", щ: "SCH",
    ъ: "", ы: "Y", ь: "", э: "E", ю: "YU", я: "YA",
  };
  return text
    .toLowerCase()
    .split("")
    .map((ch) => map[ch] ?? ch.toUpperCase())
    .join("");
}

/**
 * Извлекает числовой суффикс из имени прибора (например, "S60" → "60", "M18" → "18").
 */
function extractNumericSuffix(name: string): string {
  const match = name.match(/(\d+)/);
  return match ? match[1] : "";
}

/**
 * Генерирует аббревиатуру категории.
 */
function categoryAbbrev(category: string): string {
  const lower = category.toLowerCase().trim();
  // Ищем прямое совпадение
  if (CYRILLIC_ABBREV_MAP[lower]) {
    return CYRILLIC_ABBREV_MAP[lower];
  }
  // Ищем частичное совпадение (первое подходящее)
  for (const [key, abbrev] of Object.entries(CYRILLIC_ABBREV_MAP)) {
    if (lower.includes(key) || key.includes(lower)) {
      return abbrev;
    }
  }
  // Запасной вариант: транслитерация первых 3 букв
  return transliterate(category).replace(/[^A-Z0-9]/g, "").slice(0, 3);
}

/**
 * Генерирует аббревиатуру для имени прибора.
 */
function nameAbbrev(equipmentName: string): string {
  const lower = equipmentName.toLowerCase().trim();
  // Ищем известные кириллические слова
  for (const [key, abbrev] of Object.entries(NAME_WORD_MAP)) {
    if (lower.includes(key)) {
      return abbrev;
    }
  }
  // Берём первое «латинское» слово из имени (например, "Skypanel" → "SKY")
  const latinWord = equipmentName.match(/[A-Za-z]{2,}/);
  if (latinWord) {
    return latinWord[0].toUpperCase().slice(0, 3);
  }
  // Запасной: транслитерация
  return transliterate(equipmentName).replace(/[^A-Z0-9]/g, "").slice(0, 3);
}

/**
 * Генерирует ID штрихкода в формате `LR-{ABBREV}{NUM}-{SEQ}`.
 *
 * @param equipmentName - Название оборудования (например, "Skypanel S60")
 * @param category      - Категория оборудования (например, "LED панели")
 * @param sequenceNum   - Порядковый номер единицы (1-999+)
 * @returns Строка вида "LR-SKY60-003"
 */
export function generateBarcodeId(
  equipmentName: string,
  category: string,
  sequenceNum: number,
): string {
  const abbrev = categoryAbbrev(category) || nameAbbrev(equipmentName);
  const numSuffix = extractNumericSuffix(equipmentName);
  const seq = String(sequenceNum).padStart(3, "0");
  return `LR-${abbrev}${numSuffix}-${seq}`;
}
