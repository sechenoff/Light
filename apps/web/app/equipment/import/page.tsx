import { redirect } from "next/navigation";

export default function EquipmentImportPage() {
  // Импорт оборудования живёт на /admin/more (таб «Импорт оборудования»),
  // а не на главном /admin — редиректим сразу к нужному разделу.
  redirect("/admin/more");
}
