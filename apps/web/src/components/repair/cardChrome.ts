/**
 * Общая «фурнитура» карточки ремонта: классы кнопок, карточек и чипов плюс
 * один текстовый хелпер.
 *
 * Вынесено отдельно, потому что карточку собирают три файла (страница, срок
 * возврата, модалка закрытия), и разъехавшиеся классы кнопок читаются как
 * разные по важности действия — хотя разница только в том, кто их отрисовал.
 * JSX здесь нет намеренно: это данные, а не компонент.
 */

import { pluralize } from "../../lib/format";

export const BTN_PRIMARY =
  "inline-flex items-center justify-center gap-1.5 rounded border border-accent-bright bg-accent-bright px-3 py-2.5 text-xs font-semibold text-surface transition-colors hover:border-accent hover:bg-accent disabled:opacity-60 lg:py-1.5";
/** Зелёная «починил» — единственное действие, ради которого сюда заходят. */
export const BTN_OK =
  "inline-flex items-center justify-center gap-1.5 rounded border border-emerald bg-emerald px-3 py-2.5 text-xs font-semibold text-surface transition-opacity hover:opacity-90 disabled:opacity-60 lg:py-1.5";
export const BTN_MINI =
  "inline-flex items-center justify-center gap-1.5 rounded border border-border bg-surface px-3 py-2.5 text-xs font-semibold text-ink-2 transition-colors hover:border-accent-border hover:bg-accent-soft hover:text-accent-bright disabled:opacity-60 lg:py-1.5";
/** Деструктивное действие красится только на наведении: промах не должен пугать. */
export const BTN_MINI_ROSE =
  "inline-flex items-center justify-center gap-1.5 rounded border border-border bg-surface px-3 py-2.5 text-xs font-semibold text-ink-2 transition-colors hover:border-rose-border hover:bg-rose-soft hover:text-rose disabled:opacity-60 lg:py-1.5";

export const CARD = "overflow-hidden rounded-lg border border-border bg-surface shadow-xs";
export const CARD_ZONE = "px-3.5 py-2.5";

export const CHIP =
  "rounded-xl border px-2.5 py-1.5 text-[11px] font-semibold leading-[1.6] transition-colors lg:py-px";
export const CHIP_OFF =
  "border-border bg-surface text-ink-2 hover:border-accent-border hover:bg-accent-soft hover:text-accent-bright";
export const CHIP_ON = "border-accent bg-accent text-surface";

/**
 * Пункт мета-строки («взят 2 дня назад · записей ещё нет · …»).
 *
 * Разделитель «·» рисует ::before самого пункта и заезжает в зазор слева
 * (`-ml-3.5` = ширина точки = `gap-x-3.5` контейнера). У первого пункта строки
 * точка уходит за левый край и срезается `overflow-hidden` контейнера — поэтому
 * при переносе «·» не повисает ни в конце строки, ни в начале следующей.
 */
export const META_ITEM =
  "-ml-3.5 inline-flex items-center before:w-3.5 before:shrink-0 before:text-center before:font-normal before:text-border-strong before:content-['·']";

/** «4 дня» — склонение в одном месте, чтобы не плодить «4 день» по экрану. */
export function daysText(n: number): string {
  return `${n} ${pluralize(n, "день", "дня", "дней")}`;
}
