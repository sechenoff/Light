"use client";

// ── Форматирование даты в русском формате ────────────────────────────────────

const WEEKDAYS = [
  "Воскресенье", "Понедельник", "Вторник", "Среда",
  "Четверг", "Пятница", "Суббота",
];
const MONTHS_GEN = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

function formatLongRuDate(d: Date): string {
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`;
}

// ── Props ─────────────────────────────────────────────────────────────────────

export function DayHeader({
  greeting,
  summary,
  date = new Date(),
}: {
  greeting: string;     // например, «доброе утро, Пётр 👋»
  summary: string;      // например, «3 выдачи · 2 возврата»
  date?: Date;
}) {
  return (
    <div className="bg-inverse text-on-inverse rounded-t-lg px-4 py-3 flex flex-col sm:flex-row sm:justify-between sm:items-center gap-1">
      <div className="text-sm">
        <span className="font-semibold">{formatLongRuDate(date)}</span>{" "}
        {/* inline-block: приветствие переносится на вторую строку целиком, а не
            оставляет эмодзи в одиночестве; слишком длинное имя всё равно
            переносится внутри блока, а не вылезает за шапку. Отступ — пробелом,
            а не margin: на переносе пробел схлопывается, и строка не съезжает. */}
        <span className="inline-block text-white/80">· {greeting}</span>
      </div>
      <div className="text-xs text-white/60 font-cond">{summary}</div>
    </div>
  );
}
