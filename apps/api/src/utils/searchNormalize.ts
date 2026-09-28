/**
 * Нормализация текста для поиска по каталогу (P11).
 *
 * В названиях позиций кириллица и латиница перемешаны: «Aputure СF16» набрано
 * с кириллической «С», «Соты для рамы 8х8» — с кириллической «х». Человек ищет
 * латиницей («cf16», «8x8») и не находит ничего (06.09). Поэтому обе стороны —
 * и запрос, и название — приводим к одному виду:
 *
 *   - нижний регистр по правилам ru-RU, «ё» → «е»;
 *   - кириллические буквы, неотличимые на глаз от латинских
 *     (а в е к м н о р с т у х), → латинские a b e k m h o p c t y x;
 *   - знак «×» → «x», а размер «8 × 8» / «8 х 8» → «8x8»;
 *   - пробелы схлопываются, края обрезаются.
 *
 * Замена посимвольная (кроме размеров и пробелов), поэтому вхождение, которое
 * было до нормализации, почти всегда сохраняется. `searchMatches` дополнительно
 * проверяет и сырое вхождение — чтобы правка не отняла ни одного прежнего
 * результата поиска.
 */

const LOOKALIKE_TO_LATIN: Readonly<Record<string, string>> = {
  а: "a",
  в: "b",
  е: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
};

const LOOKALIKE_RE = /[авекмнорстух]/g;
/** «8 x 8», «4x4x8»: знак размера между цифрами, пробелы вокруг него убираем. */
const DIMENSION_RE = /(\d)\s*[xх×]\s*(?=\d)/g;
const WHITESPACE_RE = /\s+/g;

/** Базовый вид для сравнения: регистр ru-RU и схлопнутые пробелы, без замены алфавита. */
function baseSearchText(text: string): string {
  return text.toLocaleLowerCase("ru-RU").replace(WHITESPACE_RE, " ").trim();
}

/** Приводит запрос или название к единому виду для поиска (см. шапку файла). */
export function normalizeSearchText(text: string): string {
  return baseSearchText(text)
    .replace(/ё/g, "е")
    .replace(/×/g, "x")
    .replace(LOOKALIKE_RE, (ch) => LOOKALIKE_TO_LATIN[ch] ?? ch)
    .replace(DIMENSION_RE, "$1x");
}

/**
 * Находится ли `needle` в `haystack`. Пустой запрос подходит всему.
 * Совпадение засчитывается и по сырому тексту, и по нормализованному.
 */
export function searchMatches(haystack: string, needle: string): boolean {
  const rawNeedle = baseSearchText(needle);
  if (rawNeedle.length === 0) return true;
  if (baseSearchText(haystack).includes(rawNeedle)) return true;
  return normalizeSearchText(haystack).includes(normalizeSearchText(needle));
}
