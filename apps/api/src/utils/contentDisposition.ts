/**
 * Кириллица в имени файла живёт в `filename*=UTF-8''…` — его читают и браузеры,
 * и наш фронт (`getFileNameFromContentDisposition`). Именно оттуда берётся
 * «29.08.2026 Петя Куб 33565-смета.pdf».
 *
 * Рядом обязан стоять ASCII-вариант `filename="…"`: по RFC 6266 в нём допустим
 * только US-ASCII, и его читают старые клиенты. Раньше кириллица оттуда просто
 * вырезалась, и запасное имя вырождалось в «29.08.2026   33565-.pdf» — без имени
 * клиента и без слова «смета». Теперь она транслитерируется: смысл сохраняется,
 * требование RFC тоже.
 */

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "sch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

function transliterate(input: string): string {
  let out = "";
  for (const ch of input) {
    const lower = ch.toLowerCase();
    const mapped = TRANSLIT[lower];
    if (mapped === undefined) {
      out += ch;
      continue;
    }
    // Заглавную кириллическую букву отдаём заглавной латиницей: «Петя» → «Petya».
    out += ch === lower ? mapped : mapped.charAt(0).toUpperCase() + mapped.slice(1);
  }
  return out;
}

function asciiFallbackName(name: string, fallback: string): string {
  const cleaned = transliterate(name)
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/["\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

/** RFC 6266: ASCII-имя для старых клиентов + UTF-8 для всех остальных. */
export function buildAttachmentContentDisposition(fileName: string, fallbackName: string): string {
  const ascii = asciiFallbackName(fileName, fallbackName);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
