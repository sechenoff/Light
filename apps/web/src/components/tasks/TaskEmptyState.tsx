"use client";

export function TaskEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <div className="text-3xl mb-3" aria-hidden="true">✓</div>
      <p className="text-sm font-medium text-ink-2">На сегодня всё. Хорошая работа.</p>
      <p className="text-xs text-ink-3 mt-1">Нажми «+ Создать задачу» или клавишу N</p>
    </div>
  );
}
