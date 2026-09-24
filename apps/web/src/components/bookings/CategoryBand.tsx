/**
 * Полоса-заголовок категории над группой позиций — тот же рисунок, что у полос
 * каталога (CatalogBrowser) и групп экрана согласования (ApprovalReviewView).
 * Группы собирает groupByCategory (src/lib) в порядке, в каком строки пришли
 * с сервера.
 */

export const CATEGORY_BAND_TEXT =
  "font-cond text-[10px] font-semibold uppercase tracking-wider text-ink-3";

/**
 * Первая строка группы в таблице. Каждая категория — свой <tbody>, поэтому
 * заголовок размечен как th scope="rowgroup" на всю ширину.
 */
export function CategoryBandRow({
  category,
  colSpan,
  cellClassName = "px-4 py-1.5",
}: {
  category: string;
  colSpan: number;
  cellClassName?: string;
}) {
  return (
    <tr className="border-t border-border bg-surface-subtle">
      <th scope="rowgroup" colSpan={colSpan} className={`${cellClassName} text-left ${CATEGORY_BAND_TEXT}`}>
        {category}
      </th>
    </tr>
  );
}

/** Та же полоса над группой в мобильном списке (вместо таблицы). */
export function CategoryBandHeading({ category }: { category: string }) {
  return (
    <p className={`border-y border-border bg-surface-subtle px-4 py-1.5 first:border-t-0 ${CATEGORY_BAND_TEXT}`}>
      {category}
    </p>
  );
}
