"use client";

type Props = {
  fileName: string;
};

const HINTS = [
  "Разбираем структуру таблицы...",
  "Сопоставляем с каталогом...",
  "Генерируем описания изменений...",
];

export function AnalysisProgress({ fileName }: Props) {
  return (
    <div className="flex flex-col items-center py-16 text-center">
      {/* Спиннер */}
      <div className="mb-6 h-12 w-12 animate-spin rounded-full border-[3px] border-border border-t-accent" />

      <div className="mb-1 text-base font-medium text-ink-1">Анализируем файл...</div>
      <div className="mb-8 text-sm text-ink-3 truncate max-w-xs">{fileName}</div>

      <ul className="space-y-2 text-sm text-ink-2">
        {HINTS.map((hint) => (
          <li key={hint} className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-accent-soft border border-accent" />
            {hint}
          </li>
        ))}
      </ul>
    </div>
  );
}
