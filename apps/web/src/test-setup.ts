import "@testing-library/jest-dom";

// jsdom не реализует scrollIntoView (используется формой брони для
// автоскролла к невалидному шагу) — глушим, чтобы клики в тестах не падали.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// jsdom не реализует IntersectionObserver вовсе, а на нём держится автоподгрузка
// списков при доскролле. Заглушка не просто глушит конструктор, а ведёт реестр
// наблюдаемых узлов: тест дёргает triggerIntersection() и проверяет, что
// подгрузилась ровно одна страница.
type ObserverEntry = { callback: IntersectionObserverCallback; nodes: Set<Element> };
const observers = new Set<ObserverEntry>();

/** Сообщить всем живым наблюдателям, что их цели попали (или ушли) из вида. */
export function triggerIntersection(isIntersecting = true): void {
  for (const { callback, nodes } of Array.from(observers)) {
    const entries = Array.from(nodes).map(
      (target) =>
        ({
          target,
          isIntersecting,
          intersectionRatio: isIntersecting ? 1 : 0,
        }) as IntersectionObserverEntry,
    );
    if (entries.length > 0) callback(entries, null as unknown as IntersectionObserver);
  }
}

/** Сколько наблюдателей сейчас подписано — гарантия, что отписка отрабатывает. */
export function activeObserverCount(): number {
  return observers.size;
}

if (typeof globalThis.IntersectionObserver === "undefined") {
  class MockIntersectionObserver implements IntersectionObserver {
    readonly root: Element | Document | null = null;
    readonly rootMargin: string;
    readonly thresholds: ReadonlyArray<number> = [];
    private entry: ObserverEntry;

    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.rootMargin = options?.rootMargin ?? "";
      this.entry = { callback, nodes: new Set() };
      observers.add(this.entry);
    }
    observe(target: Element): void {
      this.entry.nodes.add(target);
    }
    unobserve(target: Element): void {
      this.entry.nodes.delete(target);
    }
    disconnect(): void {
      this.entry.nodes.clear();
      observers.delete(this.entry);
    }
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  globalThis.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
}
