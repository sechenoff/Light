import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";

import { useAutoLoadMore } from "../useAutoLoadMore";
import { triggerIntersection, activeObserverCount } from "../../../test-setup";

/**
 * Хук отдаёт ref, который обязан оказаться на реальном узле — поэтому проверяем
 * его через компонент-стенд, а не через renderHook: без привязки к DOM
 * наблюдатель не создаётся вовсе, и любой «зелёный» тест был бы ложным.
 */
function Harness(props: {
  hasMore: boolean;
  loading: boolean;
  disabled?: boolean;
  maxAutoPages?: number;
  onLoadMore: () => void;
}) {
  const { sentinelRef, budgetExhausted } = useAutoLoadMore(props);
  return (
    <div>
      <div ref={sentinelRef} data-testid="sentinel" />
      <span data-testid="budget">{budgetExhausted ? "исчерпан" : "есть"}</span>
    </div>
  );
}

const budget = () => screen.getByTestId("budget").textContent;

describe("useAutoLoadMore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("подгружает страницу, когда сентинел попал в поле зрения", () => {
    const onLoadMore = vi.fn();
    render(<Harness hasMore loading={false} onLoadMore={onLoadMore} />);

    act(() => triggerIntersection(true));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("не подгружает, пока сентинел вне поля зрения", () => {
    const onLoadMore = vi.fn();
    render(<Harness hasMore loading={false} onLoadMore={onLoadMore} />);

    act(() => triggerIntersection(false));
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it("не наблюдает, когда следующей страницы нет", () => {
    const onLoadMore = vi.fn();
    render(<Harness hasMore={false} loading={false} onLoadMore={onLoadMore} />);

    expect(activeObserverCount()).toBe(0);
    act(() => triggerIntersection(true));
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it("во время загрузки повторных запросов не шлёт", () => {
    const onLoadMore = vi.fn();
    render(<Harness hasMore loading onLoadMore={onLoadMore} />);

    act(() => triggerIntersection(true));
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it("после ошибки автоподгрузка выключена, после «Повторить» — снова работает", () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(<Harness hasMore loading={false} disabled onLoadMore={onLoadMore} />);

    act(() => triggerIntersection(true));
    expect(onLoadMore).not.toHaveBeenCalled();

    rerender(<Harness hasMore loading={false} disabled={false} onLoadMore={onLoadMore} />);
    act(() => triggerIntersection(true));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("продолжает цикл, если после догрузки сентинел так и остался на экране", () => {
    // IntersectionObserver сообщает только об ИЗМЕНЕНИИ пересечения. Короткая
    // страница (список почищен групповым действием) залипла бы навсегда, если бы
    // наблюдатель не пересоздавался после каждой догрузки.
    const onLoadMore = vi.fn();
    const { rerender } = render(<Harness hasMore loading={false} onLoadMore={onLoadMore} />);

    act(() => triggerIntersection(true));
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    // Запрос ушёл и вернулся, а сентинел с экрана не уходил.
    rerender(<Harness hasMore loading onLoadMore={onLoadMore} />);
    rerender(<Harness hasMore loading={false} onLoadMore={onLoadMore} />);
    act(() => triggerIntersection(true));
    expect(onLoadMore).toHaveBeenCalledTimes(2);
  });

  it("бюджет автостраниц останавливает каскад, скролл пользователя его возобновляет", () => {
    const onLoadMore = vi.fn();
    render(<Harness hasMore loading={false} maxAutoPages={2} onLoadMore={onLoadMore} />);

    act(() => triggerIntersection(true));
    act(() => triggerIntersection(true));
    expect(onLoadMore).toHaveBeenCalledTimes(2);
    expect(budget()).toBe("исчерпан");

    act(() => triggerIntersection(true));
    expect(onLoadMore).toHaveBeenCalledTimes(2);

    // Человек скроллит сам — значит список ведёт он, ограничивать незачем.
    act(() => window.dispatchEvent(new Event("scroll")));
    expect(budget()).toBe("есть");
    act(() => triggerIntersection(true));
    expect(onLoadMore).toHaveBeenCalledTimes(3);
  });

  it("отписывается при размонтировании", () => {
    const onLoadMore = vi.fn();
    const { unmount } = render(<Harness hasMore loading={false} onLoadMore={onLoadMore} />);
    expect(activeObserverCount()).toBe(1);

    unmount();
    expect(activeObserverCount()).toBe(0);
  });

  it("зовёт самую свежую версию колбэка, а не захваченную при подписке", () => {
    // loadMore на странице пересоздаётся каждый рендер и замыкает курсор:
    // устаревшая копия молча тянула бы одну и ту же страницу.
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Harness hasMore loading={false} onLoadMore={first} />);
    rerender(<Harness hasMore loading={false} onLoadMore={second} />);

    act(() => triggerIntersection(true));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
