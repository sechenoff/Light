export type ParsedFilename = {
  /** null если дата не распознана */
  date: Date | null;
  /** Пустая строка если не распознано */
  clientName: string;
  /** null если суммы нет в имени файла */
  amount: number | null;
  /** true если в имени есть маркер дубля (N) */
  isDuplicate: boolean;
};

// Маппинг коротких/полных форм месяцев на номер (1-based)
const MONTH_MAP: Record<string, number> = {
  янв: 1, январь: 1, января: 1,
  фев: 2, февраль: 2, февраля: 2,
  мар: 3, март: 3, марта: 3,
  апр: 4, апрель: 4, апреля: 4,
  май: 5, мая: 5,
  июн: 6, июнь: 6, июня: 6,
  июл: 7, июль: 7, июля: 7,
  авг: 8, август: 8, августа: 8,
  сен: 9, сентябрь: 9, сентября: 9,
  окт: 10, октябрь: 10, октября: 10,
  ноя: 11, ноябрь: 11, ноября: 11,
  дек: 12, декабрь: 12, декабря: 12,
};

/**
 * Парсит имя файла сметы в структурированные данные.
 * @param filename - имя файла (с расширением или без)
 * @param year - год по умолчанию (используется если год не найден в имени)
 */
export function parseLegacyFilename(filename: string, year: number): ParsedFilename {
  const fallback: ParsedFilename = {
    date: null,
    clientName: "",
    amount: null,
    isDuplicate: false,
  };

  if (!filename) return fallback;

  // Убираем расширение (.xlsx, .xls, .XLS, .XLSX)
  const nameWithoutExt = filename.replace(/\.xlsx?$/i, "").trim();

  // Проверяем маркер дубля в конце: (N) где N — цифра
  const isDuplicate = /\s*\(\d+\)\s*$/.test(nameWithoutExt);
  // Убираем маркер дубля для дальнейшего парсинга
  const clean = nameWithoutExt.replace(/\s*\(\d+\)\s*$/, "").trim();

  // ─── Паттерн 1: DD.MM ClientName Amount ───────────────────────────────────
  // Примеры: "04.04 Романов 22137", "17.04 Незрим  106332"
  const p1 = /^(\d{1,2})\.(\d{1,2})\s+(.+?)\s+(\d+)$/.exec(clean);
  if (p1) {
    const day = parseInt(p1[1], 10);
    const month = parseInt(p1[2], 10);
    const clientName = p1[3].trim();
    const amount = parseInt(p1[4], 10);
    return {
      date: new Date(year, month - 1, day),
      clientName,
      amount,
      isDuplicate,
    };
  }

  // ─── Паттерн 2: DD_MM_YY ClientName ──────────────────────────────────────
  // Примеры: "06_04_26 Бильярд", "15_03_26 Студия"
  const p2 = /^(\d{1,2})_(\d{1,2})_(\d{2})\s+(.+?)$/.exec(clean);
  if (p2) {
    const day = parseInt(p2[1], 10);
    const month = parseInt(p2[2], 10);
    const yy = parseInt(p2[3], 10);
    const fullYear = yy < 50 ? 2000 + yy : 1900 + yy;
    const clientName = p2[4].trim();
    return {
      date: new Date(fullYear, month - 1, day),
      clientName,
      amount: null,
      isDuplicate,
    };
  }

  // ─── Паттерн 3: D-DD месяц ClientName ────────────────────────────────────
  // Примеры: "8-16 марта Геннадий", "1-5 апреля Клиент", "3-7 янв Клиент"
  const p3 = /^(\d{1,2})[-–](\d{1,2})\s+([а-яё]+)\s+(.+?)$/i.exec(clean);
  if (p3) {
    const day = parseInt(p3[1], 10);
    const monthStr = p3[3].toLowerCase();
    const monthNum = MONTH_MAP[monthStr];
    const clientName = p3[4].trim();
    if (monthNum) {
      return {
        date: new Date(year, monthNum - 1, day),
        clientName,
        amount: null,
        isDuplicate,
      };
    }
  }

  return { ...fallback, isDuplicate };
}
