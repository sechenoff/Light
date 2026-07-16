"use client";

/**
 * ResumedSessionBanner — amber-плашка над чек-листом, когда createSession
 * вернул уже существующую ACTIVE-сессию (`resumed: true`).
 *
 * Зачем: createSession идемпотентен — повторное открытие той же брони молча
 * продолжает старую сессию со всеми отметками/доборами. Раньше оператор не
 * видел разницы между «чистым стартом» и «продолжением» — плашка делает
 * resume явным (и показывает, когда сессию начали).
 *
 * Осознанно БЕЗ кнопки «Начать заново»: cancelSession лишь помечает сессию
 * CANCELLED и не откатывает ScanRecord/статусы юнитов/доборы — «сброс» из
 * киоска создал бы рассинхрон. Разбор нештатных сессий — задача менеджера.
 */

interface ResumedSessionBannerProps {
  /** ISO-время начала сессии (ScanSession.startedAt); null — не показываем время. */
  startedAt: string | null;
  /** Закрыть плашку (локально, до конца текущего чек-листа). */
  onDismiss: () => void;
}

/** «12.07, 14:05» по Москве; null при непарсибельном входе. */
function formatStartedAt(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const date = d.toLocaleDateString("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
  });
  const time = d.toLocaleTimeString("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${date}, ${time}`;
}

export function ResumedSessionBanner({
  startedAt,
  onDismiss,
}: ResumedSessionBannerProps) {
  const started = formatStartedAt(startedAt);
  return (
    <div
      role="status"
      className="flex items-start gap-2 border-b border-amber-border bg-amber-soft px-3 py-2.5 lg:px-4"
    >
      <span aria-hidden="true" className="text-[14px] leading-snug">
        ⏳
      </span>
      <p className="flex-1 text-[12px] leading-snug text-amber">
        <span className="font-semibold">
          Продолжена незавершённая сессия
        </span>
        {started ? ` — начата ${started}.` : "."}{" "}
        Доборы и принятые позиции сохранены.
      </p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Скрыть уведомление о продолженной сессии"
        className="-mr-1 -mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded text-[16px] leading-none text-amber transition-colors hover:bg-amber-soft"
      >
        ✕
      </button>
    </div>
  );
}
