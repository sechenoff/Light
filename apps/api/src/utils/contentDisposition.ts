function asciiFallbackName(name: string, fallback: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/["\\]/g, "")
    .trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

/** RFC 5987 + ASCII fallback для безопасной выдачи имен файлов с кириллицей. */
export function buildAttachmentContentDisposition(fileName: string, fallbackName: string): string {
  const ascii = asciiFallbackName(fileName, fallbackName);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
