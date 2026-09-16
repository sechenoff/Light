/**
 * Сумма прописью для платёжных документов: «Пятьдесят две тысячи сто два
 * рубля 00 копеек». Копейки — цифрами, как принято в счетах и платёжках.
 *
 * Род согласуется по разрядам: рубли и миллионы — мужской («один рубль»,
 * «два миллиона»), тысячи — женский («одна тысяча», «две тысячи»).
 */
import Decimal from "decimal.js";

const ONES_M = ["", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const ONES_F = ["", "одна", "две", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const TEENS = [
  "десять", "одиннадцать", "двенадцать", "тринадцать", "четырнадцать",
  "пятнадцать", "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать",
];
const TENS = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто"];
const HUNDREDS = ["", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот"];

type Forms = readonly [one: string, few: string, many: string];

const RUBLE: Forms = ["рубль", "рубля", "рублей"];
const KOPECK: Forms = ["копейка", "копейки", "копеек"];
/** Разряды от младшего к старшему: тысячи, миллионы, миллиарды. */
const SCALES: ReadonlyArray<{ forms: Forms; feminine: boolean }> = [
  { forms: ["тысяча", "тысячи", "тысяч"], feminine: true },
  { forms: ["миллион", "миллиона", "миллионов"], feminine: false },
  { forms: ["миллиард", "миллиарда", "миллиардов"], feminine: false },
];

/** Русская плюрализация: 1 → one, 2–4 → few, остальное (и 11–14) → many. */
export function pluralForm(n: number, forms: Forms): string {
  const abs = Math.abs(Math.trunc(n));
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1];
  return forms[2];
}

/** Число 1…999 словами; род влияет только на «один/одна», «два/две». */
function tripletToWords(n: number, feminine: boolean): string {
  const ones = feminine ? ONES_F : ONES_M;
  const words: string[] = [];
  const h = Math.floor(n / 100);
  const t = Math.floor((n % 100) / 10);
  const o = n % 10;
  if (h > 0) words.push(HUNDREDS[h]);
  if (t === 1) {
    words.push(TEENS[o]);
  } else {
    if (t >= 2) words.push(TENS[t]);
    if (o > 0) words.push(ones[o]);
  }
  return words.join(" ");
}

/** Целое неотрицательное число словами (мужской род для последнего разряда). */
export function integerToWords(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error(`integerToWords: bad value ${value}`);
  const n = Math.trunc(value);
  if (n === 0) return "ноль";
  const parts: string[] = [];
  let rest = n;
  let scaleIdx = -1; // -1 — единицы (без названия разряда)
  while (rest > 0) {
    const triplet = rest % 1000;
    if (triplet > 0) {
      const scale = scaleIdx >= 0 ? SCALES[scaleIdx] : null;
      if (scaleIdx >= SCALES.length) throw new Error("integerToWords: value too large");
      const words = tripletToWords(triplet, scale?.feminine ?? false);
      parts.unshift(scale ? `${words} ${pluralForm(triplet, scale.forms)}` : words);
    }
    rest = Math.floor(rest / 1000);
    scaleIdx += 1;
  }
  return parts.join(" ");
}

/**
 * «Пятьдесят две тысячи сто два рубля 00 копеек». Первая буква — заглавная,
 * как в бланках; отрицательные суммы в счетах не встречаются — ошибка.
 */
export function rublesInWords(amount: Decimal | string | number): string {
  const dec = new Decimal(amount).toDecimalPlaces(2);
  if (dec.isNegative()) throw new Error("rublesInWords: negative amount");
  const rubles = dec.floor().toNumber();
  const kopecks = dec.sub(dec.floor()).mul(100).round().toNumber();
  const rubleWords = integerToWords(rubles);
  const text = `${rubleWords} ${pluralForm(rubles, RUBLE)} ${String(kopecks).padStart(2, "0")} ${pluralForm(kopecks, KOPECK)}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
