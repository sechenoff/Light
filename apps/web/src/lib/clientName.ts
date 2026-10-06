/**
 * Ключ сравнения имён клиентов: без регистра, «ё» = «е», без кавычек,
 * пробелы схлопнуты. Зеркало `normalizeClientName` на сервере
 * (apps/api/src/services/clientNames.ts) — менять оба вместе: по нему сервер
 * решает, что «петя куб» — уже существующий «Петя Куб», а окно выбора — что
 * кнопку «создать нового» показывать не нужно.
 */
export function normalizeClientName(name: string): string {
  return name
    .normalize("NFC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[«»„“”"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
