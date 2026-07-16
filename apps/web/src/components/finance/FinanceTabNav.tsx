"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useCurrentUser } from "@/hooks/useCurrentUser";

const TABS = [
  { href: "/finance", label: "Сводка" },
  { href: "/finance/invoices", label: "Счета" },
  { href: "/finance/payments", label: "Платежи" },
  { href: "/finance/debts", label: "Долги", badgeKey: "debts" as const },
  { href: "/finance/expenses", label: "Расходы" },
];

// F1: кладовщику доступны только «Счета» — остальные финансовые роуты SA-only
// (rolesGuard на API + useRequireRole на страницах). Раньше таб-нав показывал все
// 5 вкладок, и WAREHOUSE кликал в 403/редирект. Фильтруем по роли.
const WAREHOUSE_ALLOWED = new Set(["/finance/invoices"]);

export function FinanceTabNav({ debtCount }: { debtCount?: number }) {
  const pathname = usePathname();
  const { user } = useCurrentUser();
  const tabs = user?.role === "WAREHOUSE" ? TABS.filter((t) => WAREHOUSE_ALLOWED.has(t.href)) : TABS;

  return (
    <div className="flex border-b border-border bg-surface px-6">
      {tabs.map((tab) => {
        const active =
          tab.href === "/finance"
            ? pathname === "/finance"
            : pathname === tab.href || pathname.startsWith(tab.href + "/");
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`px-4 py-3.5 text-[13px] font-medium border-b-2 -mb-px transition-colors ${
              active
                ? "text-accent border-accent font-semibold"
                : "text-ink-2 border-transparent hover:text-ink"
            }`}
          >
            {tab.label}
            {tab.badgeKey === "debts" &&
              debtCount !== undefined &&
              debtCount > 0 && (
                <span className="ml-1.5 inline-block bg-rose-soft text-rose text-[10.5px] font-semibold px-1.5 py-0.5 rounded-full">
                  {debtCount}
                </span>
              )}
          </Link>
        );
      })}
    </div>
  );
}
