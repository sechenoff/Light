"use client";

/**
 * Полоса занятости на 14 дней вперёд: по клетке на день, начиная с сегодня.
 *
 * Отвечает на главный операционный вопрос — «свободна ли машина на нужные
 * даты» — без перехода в календарь. Занятые дни закрашены accent-цветом,
 * свободные — светлой подложкой; сегодня подчёркнуто снизу.
 */
export function OccupancyStrip({
  occupancy,
  className = "",
}: {
  occupancy: boolean[];
  className?: string;
}) {
  const busyCount = occupancy.filter(Boolean).length;
  const label =
    busyCount === 0
      ? "Ближайшие 14 дней свободны"
      : `Занята ${busyCount} из ${occupancy.length} ближайших дней`;

  return (
    <div className={className}>
      <div
        className="flex gap-[3px]"
        role="img"
        aria-label={label}
        title={label}
      >
        {occupancy.map((busy, i) => (
          <span
            key={i}
            className={
              "h-4 flex-1 rounded-[2px] " +
              (busy ? "bg-accent-bright" : "bg-surface-subtle border border-border") +
              (i === 0 ? " ring-1 ring-inset ring-ink-3" : "")
            }
          />
        ))}
      </div>
      <div className="mt-1 flex items-center justify-between text-[11px] text-ink-3">
        <span>сегодня</span>
        <span>+14 дней</span>
      </div>
    </div>
  );
}
