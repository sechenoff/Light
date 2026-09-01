"use client";

/**
 * Лента фотографий поломки.
 *
 * Снимки делает кладовщик на приёмке, сервер отдаёт их с самого начала — а
 * карточка ремонта поле `photos` просто не читала. Техник видел одну строку
 * причины и шёл искать кладовщика, чтобы спросить «а что там было-то».
 * Поэтому лента стоит выше журнала работ: это первое, на что смотрят перед
 * тем, как взяться за прибор.
 *
 * Картинка тянется обычным <img> по относительному пути: адрес ведёт на
 * Next-прокси того же origin, и вместе с запросом уходит сессионная кука.
 * `next/image` здесь не годится — оптимизатор ходит за файлом с сервера, без
 * куки пользователя, и получит 401.
 */

import { useCallback, useEffect, useState } from "react";

import { pluralize } from "../../lib/format";
import { RepairIcon } from "./RepairRiskBadge";
import { formatDayMonth } from "./types";

export interface RepairPhoto {
  id: string;
  /** `/api/repairs/:id/photos/:photoId` — тот же origin, что и страница. */
  url: string;
}

/** Подпись «3 снимка · 9 авг, Сергей Лапин» — кого спрашивать, если непонятно. */
export function photoStripCaption(
  count: number,
  takenAt: string | null,
  takenBy: string | null,
): string {
  const head = `${count} ${pluralize(count, "снимок", "снимка", "снимков")}`;
  const when = takenAt ? formatDayMonth(takenAt) : null;
  const tail = [when, takenBy].filter(Boolean).join(", ");
  return tail ? `${head} · ${tail}` : head;
}

export function RepairPhotoStrip({ photos }: { photos: RepairPhoto[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const close = useCallback(() => setOpenIndex(null), []);
  const step = useCallback(
    (delta: number) =>
      setOpenIndex((i) => (i === null ? null : (i + delta + photos.length) % photos.length)),
    [photos.length],
  );

  useEffect(() => {
    if (openIndex === null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
      if (e.key === "ArrowRight") step(1);
      if (e.key === "ArrowLeft") step(-1);
    }
    window.addEventListener("keydown", onKey);
    // Пока открыт просмотр, страница под ним не должна ехать.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [openIndex, close, step]);

  if (photos.length === 0) {
    return (
      <p className="rounded border border-dashed border-border-strong bg-surface-muted px-3 py-4 text-center text-[11.5px] leading-[1.45] text-ink-3">
        Снимков с приёмки нет.
        <br />
        Их делает кладовщик, когда принимает сломанное — если снимков нет, спросите его напрямую.
      </p>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {photos.map((p, i) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setOpenIndex(i)}
            aria-label={`Открыть снимок ${i + 1} из ${photos.length}`}
            className="group relative aspect-[4/3] overflow-hidden rounded border border-border bg-surface-subtle transition-colors hover:border-accent-border"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- поток за сессионной кукой, оптимизатор Next до него не дотянется */}
            <img
              src={p.url}
              alt={`Снимок поломки ${i + 1}`}
              loading="lazy"
              className="h-full w-full object-cover transition-transform duration-150 group-hover:scale-[1.03]"
            />
          </button>
        ))}
      </div>

      {/* Подложка просмотра — `scrim`, он тёмный в обеих темах, поэтому здесь
          text-white уместен (это тот самый задокументированный случай, когда
          белый не заменяется на text-surface). */}
      {openIndex !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Снимок поломки"
          onClick={close}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-scrim/85 px-4 py-6"
        >
          <div className="flex w-full max-w-4xl items-center gap-3">
            <span className="mono-num text-xs font-semibold text-white/70">
              {openIndex + 1} / {photos.length}
            </span>
            <button
              type="button"
              aria-label="Закрыть просмотр"
              onClick={close}
              className="ml-auto inline-flex items-center gap-1.5 rounded border border-white/25 px-2.5 py-1 text-xs font-semibold text-white/80 hover:bg-white/10"
            >
              <RepairIcon name="x" />
              Закрыть
            </button>
          </div>

          {/* eslint-disable-next-line @next/next/no-img-element -- см. комментарий выше */}
          <img
            src={photos[openIndex].url}
            alt={`Снимок поломки ${openIndex + 1}`}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[75vh] w-auto max-w-full rounded border border-white/15 object-contain"
          />

          {photos.length > 1 && (
            <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                aria-label="Предыдущий снимок"
                onClick={() => step(-1)}
                className="inline-flex items-center rounded border border-white/25 px-3 py-1 text-xs font-semibold text-white/80 hover:bg-white/10"
              >
                <RepairIcon name="chev" className="rotate-180" />
              </button>
              <button
                type="button"
                aria-label="Следующий снимок"
                onClick={() => step(1)}
                className="inline-flex items-center rounded border border-white/25 px-3 py-1 text-xs font-semibold text-white/80 hover:bg-white/10"
              >
                <RepairIcon name="chev" />
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
