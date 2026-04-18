import { redirect } from "next/navigation";

// Редирект для обратной совместимости — история задач переехала в /tasks/archive
export default function HistoryRedirect() {
  redirect("/tasks/archive");
}
