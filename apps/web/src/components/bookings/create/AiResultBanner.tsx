"use client";

type Props = {
  resolved: number;
  total: number;
  unmatched: string[];
  successDismissed?: boolean;
  onDismissSuccess: () => void;
  onAddOffCatalog: (phrase: string) => void;
  onIgnoreUnmatched: () => void;
};

export function AiResultBanner({
  resolved,
  total,
  unmatched,
  successDismissed = false,
  onDismissSuccess,
  onAddOffCatalog,
  onIgnoreUnmatched,
}: Props) {
  const hasSuccess = !successDismissed && total > 0;
  const hasUnmatched = unmatched.length > 0;

  if (!hasSuccess && !hasUnmatched) return null;

  return (
    <div className="flex flex-col gap-2 px-5 pb-3 pt-0">
      {hasSuccess && (
        <div className="flex items-start gap-2.5 rounded border border-emerald-border bg-emerald-soft px-3 py-2 text-[12.5px]">
          <span className="mt-0.5 text-[14px]">✓</span>
          <div className="flex-1">
            <div className="font-semibold text-emerald">Распознано {resolved} из {total}</div>
            <div className="mt-0.5 text-[12px] text-ink-2">Проверьте количества и скорректируйте при необходимости</div>
          </div>
          <button
            type="button"
            aria-label="Закрыть"
            onClick={onDismissSuccess}
            className="text-ink-3 hover:text-ink-2"
          >
            ×
          </button>
        </div>
      )}

      {hasUnmatched && (
        <div className="rounded border border-rose-border bg-rose-soft px-3 py-2 text-[12.5px]">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-rose">Не найдено в каталоге ({unmatched.length})</span>
            <button
              type="button"
              onClick={onIgnoreUnmatched}
              className="text-[11px] text-ink-3 hover:text-ink-2"
            >
              Игнорировать
            </button>
          </div>
          <ul className="mt-1.5 flex flex-col gap-1">
            {unmatched.map((phrase) => (
              <li key={phrase} className="flex items-center justify-between text-[12px]">
                <span className="text-ink-2">«{phrase}»</span>
                <button
                  type="button"
                  onClick={() => onAddOffCatalog(phrase)}
                  className="text-[11px] font-medium text-accent-bright hover:underline"
                >
                  Добавить вручную
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
