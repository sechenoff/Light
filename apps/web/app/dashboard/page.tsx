import { redirect } from "next/navigation";

// dd-01 / nav-dashboard-orphan: /dashboard был осиротевшим дублем /day без
// useRequireRole и без пункта в меню. Корень "/" и так ведёт на /day. Чтобы не
// держать второй (незащищённый) источник правды для дашборда — редиректим сюда.
// Виджеты MiniCalendar / QuickAvailabilityCheck перенесены на /day (dd-02).
export default function DashboardRedirect() {
  redirect("/day");
}
