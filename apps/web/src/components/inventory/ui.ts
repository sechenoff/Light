/**
 * Общие классы оформления раздела «Инвентаризация».
 *
 * Только токены дизайн-системы (ink / surface / border / accent / rose / …):
 * ни сырых hex, ни числовых оттенков Tailwind. Белый текст на цветной заливке —
 * `text-surface` (ночью заливки светлеют, и `text-white` пропал бы).
 */

/** Видимый фокус с клавиатуры — у всех интерактивных элементов раздела. */
export const FOCUS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-bright";

/** Карточка-панель (мокап `.card`). */
export const CARD = "overflow-hidden rounded-lg border border-border bg-surface shadow-xs";

/** Основная кнопка (мокап `.btn`). */
export const BTN_PRIMARY = `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded border border-accent-bright bg-accent-bright px-3 py-1 text-xs font-semibold leading-[1.6] text-surface transition-colors hover:border-accent hover:bg-accent disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-subtle disabled:text-ink-3 ${FOCUS}`;

/** Второстепенная кнопка (мокап `.btn-ghost`). */
export const BTN_GHOST = `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded border border-border bg-surface px-3 py-1 text-xs font-semibold leading-[1.6] text-ink-2 transition-colors hover:border-border-strong hover:bg-surface-muted hover:text-ink disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS}`;

/** Текстовая ссылка-действие (мокап `.link`). */
export const LINK = `whitespace-nowrap rounded-sm text-[11.5px] font-semibold text-accent-bright hover:text-accent hover:underline ${FOCUS}`;

/** Заголовок карточки: Plex Condensed, жирный. */
export const CARD_TITLE = "font-cond text-base font-bold leading-tight text-ink";
