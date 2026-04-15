/**
 * Русская форма существительного в зависимости от числа.
 *
 * @param n — число
 * @param forms — три формы: [одна, две-четыре, пять+] например ['карточка', 'карточки', 'карточек']
 */
export function pluralRu(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(n);
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1];
  return forms[2];
}
