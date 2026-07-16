"use client";

import Link from "next/link";
import { StatusPill } from "./StatusPill";
import type { AvailabilityItem, AvailabilityStatus } from "@/hooks/useAvailability";

function availabilityPill(status: AvailabilityStatus) {
  const variant = status === "AVAILABLE" ? "full" : status === "PARTIAL" ? "limited" : "none";
  const label =
    status === "AVAILABLE" ? "Доступно" : status === "PARTIAL" ? "Частично" : "Занято";
  return <StatusPill variant={variant} label={label} />;
}

export interface AvailabilityCheckProps {
  items: AvailabilityItem[] | null;
  loading: boolean;
  error: string | null;
  /** Показать «Повторить» рядом с ошибкой. */
  onRetry?: () => void;
  /** Подсказка в idle-состоянии (до первой проверки). */
  idleHint?: string;
  /**
   * Если задан — рядом с каждой позицией появляется ссылка «+ Бронь»
   * с предзаполненными датами и оборудованием.
   */
  buildBookingHref?: (item: AvailabilityItem) => string;
}

/**
 * Переиспользуемый рендер результатов проверки доступности. Инпуты (даты, поиск,
 * кнопка) остаются на стороне потребителя — компонент отвечает только за список
 * позиций и состояния (loading / idle / empty / error).
 */
export function AvailabilityCheck({
  items,
  loading,
  error,
  onRetry,
  idleHint,
  buildBookingHref,
}: AvailabilityCheckProps) {
  if (error) {
    return (
      <div className="text-xs text-rose bg-rose-soft border border-rose-border rounded p-2 flex items-center justify-between gap-2">
        <span>{error}</span>
        {onRetry && (
          <button onClick={onRetry} className="text-rose underline shrink-0">
            Повторить
          </button>
        )}
      </div>
    );
  }

  if (loading && items === null) {
    return <p className="text-xs text-ink-3 text-center py-2">Проверяю…</p>;
  }

  if (items === null) {
    return idleHint ? (
      <p className="text-xs text-ink-3 text-center py-2">{idleHint}</p>
    ) : null;
  }

  if (items.length === 0) {
    return <p className="text-xs text-ink-3 text-center py-2">Ничего не найдено</p>;
  }

  return (
    <ul className="space-y-1.5">
      {items.map((item) => (
        <li key={item.equipmentId} className="flex items-center justify-between gap-2 text-xs">
          <span className="text-ink-2 truncate">{item.name}</span>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-ink-3 mono-num">
              {item.occupiedQuantity}/{item.totalQuantity}
            </span>
            {availabilityPill(item.availability)}
            {buildBookingHref && item.availability !== "UNAVAILABLE" && (
              <Link
                href={buildBookingHref(item)}
                className="text-accent-bright hover:text-accent underline whitespace-nowrap"
              >
                + Бронь
              </Link>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
