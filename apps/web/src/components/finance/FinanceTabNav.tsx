"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { useCurrentUser } from "@/hooks/useCurrentUser";

const TABS = [
  { href: "/finance", label: "Сводка" },
  { href: "/finance/invoices", label: "Счета по броням" },
  { href: "/finance/bills", label: "Счета на оплату" },
  { href: "/finance/payments", label: "Платежи" },
  { href: "/finance/debts", label: "Долги", badgeKey: "debts" as const },
  { href: "/finance/expenses", label: "Расходы" },
];

// F1: кладовщику доступны только «Счета» — остальные финансовые роуты SA-only
// (rolesGuard на API + useRequireRole на страницах). Раньше таб-нав показывал все
// 5 вкладок, и WAREHOUSE кликал в 403/редирект. Фильтруем по роли.
const WAREHOUSE_ALLOWED = new Set(["/finance/invoices"]);
// Роль взыскания видит ровно один раздел финансов — свой реестр долгов.
const COLLECTOR_ALLOWED = new Set(["/finance/debts"]);

// Число должников знают только сводка и реестр долгов. Остальные вкладки
// показывают последнее известное значение, чтобы бейдж не пропадал и таб-бар
// не прыгал при переходах внутри раздела. Отдельного запроса за числом нет.
let lastDebtCount: number | undefined;

// Запас в px, после которого лента считается «докрученной до конца».
const SCROLL_END_TOLERANCE = 4;

export function FinanceTabNav({ debtCount }: { debtCount?: number }) {
  const pathname = usePathname();
  const { user } = useCurrentUser();
  const navRef = useRef<HTMLElement>(null);
  const [hasMoreRight, setHasMoreRight] = useState(false);
  const tabs =
    user?.role === "WAREHOUSE"
      ? TABS.filter((t) => WAREHOUSE_ALLOWED.has(t.href))
      : user?.role === "COLLECTOR"
        ? TABS.filter((t) => COLLECTOR_ALLOWED.has(t.href))
        : TABS;

  useEffect(() => {
    if (debtCount !== undefined) lastDebtCount = debtCount;
  }, [debtCount]);
  const shownDebtCount = debtCount ?? lastDebtCount;

  const updateFade = useCallback(() => {
    const nav = navRef.current;
    if (!nav) return;
    setHasMoreRight(nav.scrollLeft + nav.clientWidth < nav.scrollWidth - SCROLL_END_TOLERANCE);
  }, []);

  // На узком экране активная вкладка может оказаться за правым краем ленты —
  // докручиваем саму ленту (не scrollIntoView: тот сдвинул бы и страницу).
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const active = nav.querySelector<HTMLElement>('[aria-current="page"]');
    if (active && nav.scrollWidth > nav.clientWidth) {
      const offset = active.getBoundingClientRect().left - nav.getBoundingClientRect().left;
      nav.scrollLeft += offset - (nav.clientWidth - active.offsetWidth) / 2;
    }
    updateFade();
    window.addEventListener("resize", updateFade);
    return () => window.removeEventListener("resize", updateFade);
  }, [pathname, tabs.length, updateFade]);

  // Фон и нижняя граница — на обёртке: маска затухания на самом <nav> гасила бы
  // их вместе с вкладками, и правый край полосы проваливался в фон страницы.
  return (
    <div className="min-w-0 max-w-full border-b border-border bg-surface">
      <nav
        ref={navRef}
        onScroll={updateFade}
        aria-label="Разделы финансов"
        className={`flex min-w-0 max-w-full overflow-x-auto px-3 sm:px-6 ${
          hasMoreRight ? "[mask-image:linear-gradient(to_right,black_calc(100%_-_32px),transparent)]" : ""
        }`}
      >
        {tabs.map((tab) => {
          const active =
            tab.href === "/finance"
              ? pathname === "/finance"
              : pathname === tab.href || pathname.startsWith(tab.href + "/");
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={`shrink-0 whitespace-nowrap px-4 py-3.5 text-[13px] font-medium border-b-2 -mb-px transition-colors ${
                active
                  ? "text-accent border-accent font-semibold"
                  : "text-ink-2 border-transparent hover:text-ink"
              }`}
            >
              {tab.label}
              {tab.badgeKey === "debts" &&
                shownDebtCount !== undefined &&
                shownDebtCount > 0 && (
                  <span className="ml-1.5 inline-block bg-rose-soft text-rose text-[10.5px] font-semibold px-1.5 py-0.5 rounded-full">
                    {shownDebtCount}
                  </span>
                )}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
