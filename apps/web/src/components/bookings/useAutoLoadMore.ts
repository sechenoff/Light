"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Автоподгрузка следующей страницы, когда список доскроллен до низа.
 *
 * Возвращает ref на пустой элемент-сентинел, который надо поставить в конец
 * списка. Как только сентинел попадает в поле зрения — зовётся `onLoadMore`.
 *
 * Три неочевидные вещи, ради которых это отдельный хук, а не пара строк на месте:
 *
 * 1. **Наблюдатель пересоздаётся после каждой догрузки** (`loading` в зависимостях).
 *    IntersectionObserver сообщает только об ИЗМЕНЕНИИ пересечения. Если после
 *    догрузки сентинел так и не ушёл с экрана — нового события не будет, и список
 *    залипнет при живом курсоре. Свежий наблюдатель сразу сообщает текущее
 *    состояние, поэтому цикл продолжается сам.
 *
 * 2. **`onLoadMore` живёт в ref.** На странице броней она пересоздаётся каждый
 *    рендер (а рендеров много: чекбоксы, тосты, статусы), и в зависимостях
 *    эффекта она пересоздавала бы подписку на каждую перерисовку.
 *
 * 3. **Бюджет автостраниц.** Защита от каскада: если строки настолько мелкие
 *    (сильно отдалённый зум, огромный монитор), что целая страница помещается
 *    в экран, автоподгрузка утянула бы всю базу без единого действия человека.
 *    Любой скролл пользователя бюджет обнуляет — он ограничивает только цепочку
 *    подгрузок, идущую саму по себе.
 */

/** Запас до фактического низа — подгрузка успевает пройти незаметно. */
const ROOT_MARGIN = "0px 0px 400px 0px";
/** Сколько страниц подряд можно подтянуть без участия пользователя. */
const DEFAULT_MAX_AUTO_PAGES = 10;

interface UseAutoLoadMoreOptions {
  /** Есть ли следующая страница. */
  hasMore: boolean;
  /** Догрузка уже идёт — второй запрос не нужен. */
  loading: boolean;
  /** Приостановить автоподгрузку (например, после ошибки сети). */
  disabled?: boolean;
  maxAutoPages?: number;
  onLoadMore: () => void;
}

interface UseAutoLoadMoreResult {
  sentinelRef: React.RefObject<HTMLDivElement>;
  /** Бюджет исчерпан: дальше — только по кнопке. */
  budgetExhausted: boolean;
}

export function useAutoLoadMore({
  hasMore,
  loading,
  disabled = false,
  maxAutoPages = DEFAULT_MAX_AUTO_PAGES,
  onLoadMore,
}: UseAutoLoadMoreOptions): UseAutoLoadMoreResult {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef(0);
  const exhaustedRef = useRef(false);
  const [budgetExhausted, setBudgetExhausted] = useState(false);

  const loadRef = useRef(onLoadMore);
  loadRef.current = onLoadMore;

  // Скролл пользователя обнуляет бюджет: человек ведёт список сам, и ограничивать
  // его незачем. Прирост контента снизу scrollTop не меняет, так что событие
  // действительно означает действие пользователя, а не нашу же догрузку.
  useEffect(() => {
    function onUserScroll() {
      pagesRef.current = 0;
      if (exhaustedRef.current) {
        exhaustedRef.current = false;
        setBudgetExhausted(false);
      }
    }
    window.addEventListener("scroll", onUserScroll, { passive: true });
    return () => window.removeEventListener("scroll", onUserScroll);
  }, []);

  const request = useCallback(() => {
    pagesRef.current += 1;
    if (pagesRef.current >= maxAutoPages) {
      exhaustedRef.current = true;
      setBudgetExhausted(true);
    }
    loadRef.current();
  }, [maxAutoPages]);

  const active = hasMore && !disabled && !budgetExhausted;

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !active || loading) return;
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) request();
      },
      { rootMargin: ROOT_MARGIN },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [active, loading, request]);

  return { sentinelRef, budgetExhausted };
}
