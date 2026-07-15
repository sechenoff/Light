// Поиск по каталогу с пониманием кириллицы: менеджер печатает «нова»/«шторм»,
// а названия в каталоге на латинице (NOVA, STORM). Матчим в три слоя:
// прямое вхождение → транслит запроса RU→LAT → словарик частых алиасов.
// Серверный аналог для AI-потока — SlangAlias (equipmentMatcher); здесь —
// лёгкий клиентский фильтр без запросов к API.

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/** Побуквенный транслит нижнего регистра; не-кириллица проходит как есть. */
export function transliterateRu(s: string): string {
  let out = "";
  for (const ch of s) out += TRANSLIT[ch] ?? ch;
  return out;
}

// Частые запросы, где транслит не совпадает с английским написанием
// («шторм» → "shtorm" ≠ "storm"). Ключи — в нижнем регистре.
const QUERY_ALIASES: Record<string, string> = {
  "шторм": "storm",
  "сторм": "storm",
  "скай": "sky",
  "скайпанель": "skypanel",
  "апутура": "aputure",
  "апьюче": "aputure",
  "фреснель": "fresnel",
  "френель": "fresnel",
  "хейзер": "hazer",
  "пайп": "pipe",
  "астера": "astera",
  "кино": "kino",
};

export type SearchableCatalogRow = {
  name: string;
  brand?: string | null;
  model?: string | null;
  category: string;
};

/** true, если строка каталога подходит под запрос (пустой запрос — всегда true). */
export function matchesCatalogRow(row: SearchableCatalogRow, query: string): boolean {
  const q = query.trim().toLocaleLowerCase("ru-RU");
  if (!q) return true;
  const haystack = [row.name, row.brand ?? "", row.model ?? "", row.category]
    .join(" ")
    .toLocaleLowerCase("ru-RU");
  if (haystack.includes(q)) return true;
  const translit = transliterateRu(q);
  if (translit !== q && haystack.includes(translit)) return true;
  const alias = QUERY_ALIASES[q];
  return Boolean(alias && haystack.includes(alias));
}
