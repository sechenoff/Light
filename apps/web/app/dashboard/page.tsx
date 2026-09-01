import { redirect } from "next/navigation";

// dd-01 / nav-dashboard-orphan: /dashboard был осиротевшим дублем /day без
// useRequireRole и без пункта в меню. Корень "/" и так ведёт на /day. Чтобы не
// держать второй (незащищённый) источник правды для дашборда — редиректим сюда.
// MD-5: QuickAvailabilityCheck смонтирован на /day (SUPER_ADMIN). MiniCalendar
// удалён (2026-08-05): звал несуществующий /api/calendar/occupancy и нигде не
// монтировался — вместо него пункт «Календарь» в меню.
export default function DashboardRedirect() {
  redirect("/day");
}
