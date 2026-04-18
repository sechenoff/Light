"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createContact, GafferApiError } from "../../../../src/lib/gafferApi";
import { toast } from "../../../../src/components/ToastProvider";

export default function GafferNewContactPage() {
  const router = useRouter();
  const [type, setType] = useState<"CLIENT" | "TEAM_MEMBER">("CLIENT");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [telegram, setTelegram] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    setLoading(true);
    try {
      const res = await createContact({
        type,
        name: name.trim(),
        phone: phone.trim() || undefined,
        telegram: telegram.trim() || undefined,
        note: note.trim() || undefined,
      });
      toast.success("Контакт создан");
      router.push(`/gaffer/contacts/${res.contact.id}`);
    } catch (err) {
      if (err instanceof GafferApiError) {
        if (err.code === "INVALID_TELEGRAM") {
          setErrors({ telegram: "Некорректный Telegram — укажите @username или ссылку t.me/…" });
        } else {
          toast.error(err.message);
        }
      } else {
        toast.error("Не удалось создать контакт");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-surface">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 pt-4 pb-3 border-b border-border">
        <Link href="/gaffer/contacts" className="text-accent-bright hover:text-accent transition-colors text-[13px]">
          ← Назад
        </Link>
        <h1 className="text-[17px] font-semibold text-ink">Новый контакт</h1>
      </div>

      <form onSubmit={handleSubmit} className="px-4 py-5 space-y-4">
        {/* Type segmented */}
        <div>
          <p className="text-[12px] text-ink-2 mb-2">Тип контакта</p>
          <div className="grid grid-cols-2 border border-border rounded overflow-hidden">
            {(["CLIENT", "TEAM_MEMBER"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                className={`py-2.5 text-[13px] font-medium transition-colors ${
                  type === t
                    ? "bg-accent-bright text-white"
                    : "bg-surface text-ink-2 hover:bg-[#fafafa]"
                }`}
              >
                {t === "CLIENT" ? "Заказчик" : "Команда"}
              </button>
            ))}
          </div>
        </div>

        {/* Name */}
        <div>
          <label className="block text-[12px] text-ink-2 mb-1" htmlFor="c-name">
            Имя <span className="text-rose">*</span>
          </label>
          <input
            id="c-name"
            required
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ромашка Продакшн"
            className="w-full px-[11px] py-[9px] border border-border rounded text-[13.5px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright"
          />
        </div>

        {/* Phone */}
        <div>
          <label className="block text-[12px] text-ink-2 mb-1" htmlFor="c-phone">
            Телефон
          </label>
          <input
            id="c-phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+7 999 123-45-67"
            className="w-full px-[11px] py-[9px] border border-border rounded text-[13.5px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright"
          />
        </div>

        {/* Telegram */}
        <div>
          <label className="block text-[12px] text-ink-2 mb-1" htmlFor="c-telegram">
            Telegram
          </label>
          <input
            id="c-telegram"
            value={telegram}
            onChange={(e) => setTelegram(e.target.value)}
            placeholder="@username или t.me/…"
            className={`w-full px-[11px] py-[9px] border rounded text-[13.5px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright ${
              errors.telegram ? "border-rose-border focus:ring-rose-border" : "border-border"
            }`}
          />
          {errors.telegram && (
            <p className="text-rose text-[11.5px] mt-1">{errors.telegram}</p>
          )}
          <p className="text-[11px] text-ink-3 mt-1">@username или ссылка t.me/…</p>
        </div>

        {/* Note */}
        <div>
          <label className="block text-[12px] text-ink-2 mb-1" htmlFor="c-note">
            Заметка
          </label>
          <textarea
            id="c-note"
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
          disabled={loading || !name.trim()}
          className="w-full bg-accent-bright hover:bg-accent text-white font-medium rounded px-4 py-3 text-[14px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? "Создаём…" : "Создать"}
        </button>
      </form>
    </div>
  );
}
