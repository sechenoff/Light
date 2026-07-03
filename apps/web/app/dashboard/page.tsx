import { redirect } from "next/navigation";

// dd-01 / nav-dashboard-orphan: /dashboard был осиротевшим дублем /day без
// useRequireRole и без пункта в меню. Корень "/" и так ведёт на /day. Чтобы не
// держать второй (незащищённый) источник правды для дашборда — редиректим сюда.
// MD-5: QuickAvailabilityCheck смонтирован на /day (SUPER_ADMIN). MiniCalendar
// не монтируется — вместо него пункт «Календарь» в меню (компонент сохранён).
export default function DashboardRedirect() {
  redirect("/day");
}
