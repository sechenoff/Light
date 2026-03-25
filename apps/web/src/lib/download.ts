/** Поддерживает filename*=UTF-8''... и обычный filename="...". */
export function getFileNameFromContentDisposition(
  contentDisposition: string | null | undefined,
  fallback: string,
): string {
  const cd = contentDisposition ?? "";
  const utf8Match = cd.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      // fallback below
    }
  }
  const basicMatch = cd.match(/filename="([^"]+)"/i);
  if (basicMatch?.[1]) return basicMatch[1];
  return fallback;
}
