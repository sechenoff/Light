import { redirect } from "next/navigation";

// «Настройки» — это настройки организации (форма с PATCH /api/settings/organization).
// Раньше редиректило на /admin → /admin/users, и человек попадал в список
// пользователей вместо настроек. Ведём сразу на рабочую страницу — так же,
// как это делает легаси-редирект /admin/settings.
export default function SettingsPage() {
  redirect("/settings/organization");
}
