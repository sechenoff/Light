"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  createProject,
  listContacts,
  GafferApiError,
  type GafferContact,
} from "../../../../src/lib/gafferApi";
import { toast } from "../../../../src/components/ToastProvider";

export default function GafferNewProjectPage() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [clientId, setClientId] = useState("");
  const [shootDate, setShootDate] = useState("");
  const [clientPlanAmount, setClientPlanAmount] = useState("0");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Clients list
  const [clients, setClients] = useState<GafferContact[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await listContacts({ type: "CLIENT", isArchived: false });
        if (!cancelled) setClients(res.items);
      } catch {
        if (!cancelled) setClients([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!title.trim()) errs.title = "Укажите название";
    if (!clientId) errs.clientId = "Выберите заказчика";
    if (!shootDate) errs.shootDate = "Укажите дату съёмки";
    if (Object.keys(errs).length) {
      setErrors(errs);
      return;
    }
    setErrors({});
    setLoading(true);
    try {
      const res = await createProject({
        title: title.trim(),
        clientId,
        shootDate,
        clientPlanAmount: clientPlanAmount.trim() || "0",
        note: note.trim() || undefined,
      });
      toast.success("Проект создан");
      router.push(`/gaffer/projects/${res.project.id}`);
    } catch (err) {
      if (err instanceof GafferApiError) {
        if (err.code === "INVALID_CLIENT_TYPE") {
          setErrors({ clientId: "Контакт должен быть типа «Заказчик»" });
        } else if (err.code === "CLIENT_ARCHIVED") {
          setErrors({ clientId: "Этот заказчик в архиве" });
        } else {
          toast.error(err.message);
        }
      } else {
        toast.error("Не удалось создать проект");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-surface">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 pt-4 pb-3 border-b border-border">
        <Link href="/gaffer/projects" className="text-accent-bright hover:text-accent transition-colors text-[13px]">
          ← Назад
        </Link>
        <h1 className="text-[17px] font-semibold text-ink">Новый проект</h1>
      </div>

      <form onSubmit={handleSubmit} className="px-4 py-5 space-y-4">
        {/* Title */}
        <div>
          <label className="block text-[12px] text-ink-2 mb-1" htmlFor="p-title">
            Название <span className="text-rose">*</span>
          </label>
          <input
            id="p-title"
            autoFocus
            maxLength={100}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Рекламная съёмка Ромашка"
            className={`w-full px-[11px] py-[9px] border rounded text-[13.5px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright ${
              errors.title ? "border-rose-border" : "border-border"
            }`}
          />
          {errors.title && <p className="text-rose text-[11.5px] mt-1">{errors.title}</p>}
        </div>

        {/* Client select */}
        <div>
          <label className="block text-[12px] text-ink-2 mb-1" htmlFor="p-client">
            Заказчик <span className="text-rose">*</span>
          </label>
          {clients === null ? (
            <div className="h-[39px] bg-border rounded animate-pulse" />
          ) : (
            <select
              id="p-client"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className={`w-full px-[11px] py-[9px] border rounded text-[13.5px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright ${
                errors.clientId ? "border-rose-border" : "border-border"
              }`}
            >
              <option value="">— Выберите заказчика —</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          {errors.clientId && <p className="text-rose text-[11.5px] mt-1">{errors.clientId}</p>}
          <p className="text-[11px] text-ink-3 mt-1">
            Нужного заказчика нет?{" "}
            <Link
              href="/gaffer/contacts/new?type=CLIENT"
              className="text-accent-bright hover:text-accent"
            >
              Создать контакт
            </Link>
          </p>
        </div>

        {/* Shoot date */}
        <div>
          <label className="block text-[12px] text-ink-2 mb-1" htmlFor="p-date">
            Дата съёмки <span className="text-rose">*</span>
          </label>
          <input
            id="p-date"
            type="date"
            value={shootDate}
            onChange={(e) => setShootDate(e.target.value)}
            className={`w-full px-[11px] py-[9px] border rounded text-[13.5px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright ${
              errors.shootDate ? "border-rose-border" : "border-border"
            }`}
          />
          {errors.shootDate && <p className="text-rose text-[11.5px] mt-1">{errors.shootDate}</p>}
        </div>

        {/* Plan amount */}
        <div>
          <label className="block text-[12px] text-ink-2 mb-1" htmlFor="p-amount">
            Плановая сумма от заказчика
          </label>
          <div className="relative">
            <input
              id="p-amount"
              type="number"
              min="0"
              step="1"
              value={clientPlanAmount}
              onChange={(e) => setClientPlanAmount(e.target.value)}
              className="w-full px-[11px] py-[9px] pr-7 border border-border rounded text-[13.5px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright"
            />
            <span className="absolute right-[11px] top-1/2 -translate-y-1/2 text-ink-3 text-[13px]">₽</span>
          </div>
        </div>

        {/* Note */}
        <div>
          <label className="block text-[12px] text-ink-2 mb-1" htmlFor="p-note">
            Заметка
          </label>
          <textarea
            id="p-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="Любая дополнительная информация…"
            className="w-full px-[11px] py-[9px] border border-border rounded text-[13.5px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright resize-none"
          />
        </div>

        {/* Submit */}
        <button
          type="submit"
          disabled={loading || !title.trim()}
          className="w-full bg-accent-bright hover:bg-accent text-white font-medium rounded px-4 py-3 text-[14px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? "Создаём…" : "Создать проект"}
        </button>
      </form>
    </div>
  );
}
