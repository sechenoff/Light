import { apiFetchRaw } from "./api";
import { getFileNameFromContentDisposition } from "./download";
import { toast } from "../components/ToastProvider";

/**
 * Скачивание и печать сметы.
 *
 * Живёт отдельным модулем, потому что нужно в двух местах — на карточке брони
 * и в панели «Расчёт» на форме правки. Рецепт печати нетривиальный (блоб +
 * скрытый iframe + отдельная ветка Safari), и третья копия неизбежно бы
 * разошлась с остальными.
 */

/** Путь к полной смете брони: оборудование + доборы + транспорт + реквизиты. */
export function fullEstimatePath(bookingId: string, format: "pdf" | "xlsx"): string {
  return `/api/bookings/${bookingId}/full-estimate/export/${format}`;
}

const NO_ESTIMATE = "Смета ещё не сформирована — сохраните бронь";

async function fetchEstimateBlob(
  path: string,
  notFoundMessage: string = NO_ESTIMATE,
  init?: RequestInit,
): Promise<Blob | null> {
  const res = await apiFetchRaw(path, { method: "GET", credentials: "include", ...init });
  if (!res.ok) {
    // Документ собирается из выбора пользователя (отчёт по долгам) — сервер
    // объясняет отказ человеческими словами, и прятать их за общей фразой
    // «не найдено» значит заставить гадать, что не так с выбором.
    const detail = await res
      .json()
      .then((b: { message?: string }) => (typeof b?.message === "string" ? b.message : null))
      .catch(() => null);
    if (detail) {
      toast.error(detail);
      return null;
    }
    // У старых черновиков без снапшота full-estimate отвечает 404
    // MAIN_ESTIMATE_NOT_FOUND — говорим об этом человеческими словами.
    toast.error(notFoundMessage);
    return null;
  }
  // Сервер может сообщить, что часть выбранного в документ не попала
  // (долг успели погасить, бронь отменили). Тело ответа — сам файл, поэтому
  // сообщение приезжает заголовком; молча отдавать документ короче, чем
  // показывал экран, нельзя.
  const notice = res.headers.get("x-export-notice");
  if (notice) {
    try {
      toast.info(decodeURIComponent(notice));
    } catch {
      /* битый percent-encoding — не роняем сам экспорт */
    }
  }
  const blob = await res.blob();
  const disposition = res.headers.get("content-disposition") ?? "";
  // Имя файла даёт сервер («Иванов-05.08-смета.pdf»); заголовок кладём на blob,
  // чтобы вызывающая сторона могла его достать без второго запроса.
  (blob as Blob & { __disposition?: string }).__disposition = disposition;
  return blob;
}

/** Скачивает файл, называя его так же, как назвал сервер. */
export async function downloadEstimate(
  path: string,
  fallbackName: string,
  notFoundMessage?: string,
  init?: RequestInit,
): Promise<void> {
  try {
    const blob = await fetchEstimateBlob(path, notFoundMessage, init);
    if (!blob) return;
    const disposition = (blob as Blob & { __disposition?: string }).__disposition ?? "";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = getFileNameFromContentDisposition(disposition, fallbackName);
    // Ссылку кладём в документ: Firefox игнорирует click() у элемента вне DOM.
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Снимать blob сразу нельзя — Safari успевает отменить начатую загрузку.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {
    toast.error("Не удалось скачать файл");
  }
}

/**
 * Печатает сам A4-PDF, а не админскую страницу: документ грузится блобом и
 * отправляется в печать из скрытого iframe. Safari печатать PDF из iframe не
 * умеет — там открываем вкладку и подсказываем ⌘P.
 */
export async function printEstimate(path: string, notFoundMessage?: string, init?: RequestInit): Promise<void> {
  try {
    const blob = await fetchEstimateBlob(path, notFoundMessage, init);
    if (!blob) return;
    const url = URL.createObjectURL(blob);

    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    if (isSafari) {
      const win = window.open(url, "_blank");
      if (win) {
        toast.info("PDF открыт в новой вкладке — нажмите ⌘P для печати");
      } else {
        toast.error("Браузер заблокировал вкладку — скачайте PDF кнопкой рядом");
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return;
    }

    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    iframe.src = url;
    iframe.onload = () => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } catch {
        window.open(url, "_blank");
      }
    };
    document.body.appendChild(iframe);
    // Убираем iframe и blob после диалога печати; 60 с хватает и медленному принтеру.
    window.setTimeout(() => {
      iframe.remove();
      URL.revokeObjectURL(url);
    }, 60_000);
  } catch {
    toast.error("Не удалось подготовить смету к печати");
  }
}
