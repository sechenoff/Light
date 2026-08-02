import { redirect } from "next/navigation";

// admin-01: /admin/settings был визуальным моком — все кнопки звали
// alert('Настройки пока только для чтения') / alert('Недоступно в демо-режиме'),
// бэкенда у них нет. Реальные настройки организации живут на /settings/organization
// (форма с PATCH /api/settings/organization). Чтобы не было двух «Настроек» и
// нерабочих тумблеров — редиректим на рабочую страницу.
export default function AdminSettingsRedirect() {
  redirect("/settings/organization");
}
