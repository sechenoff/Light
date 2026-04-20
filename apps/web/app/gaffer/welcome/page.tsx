"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  completeOnboarding,
  listContacts,
  createContact,
  deleteContact,
  GafferApiError,
  type GafferContact,
} from "../../../src/lib/gafferApi";
import { useGafferUser } from "../../../src/components/gaffer/GafferUserContext";
import { toast } from "../../../src/components/ToastProvider";
import { ROLE_OPTIONS } from "../../../src/components/gaffer/projectWizardShared";

type Step = 1 | 2 | 3;

export default function GafferWelcomePage() {
  const { user, loading, refresh } = useGafferUser();
  const router = useRouter();

  const [step, setStep] = useState<Step>(1);
  const [team, setTeam] = useState<GafferContact[]>([]);
  const [vendors, setVendors] = useState<GafferContact[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [completing, setCompleting] = useState(false);

  // If already onboarded — skip to dashboard
  useEffect(() => {
    if (!loading && user?.onboardingCompletedAt) {
      router.replace("/gaffer");
    }
  }, [loading, user, router]);

  // Preload team + vendors once; jump to the furthest step user has data for,
  // so reloading mid-onboarding doesn't restart from zero.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      listContacts({ type: "TEAM_MEMBER" }),
      listContacts({ type: "VENDOR" }),
    ])
      .then(([t, v]) => {
        if (cancelled) return;
        const teamActive = t.items.filter((c) => !c.isArchived);
        const vendorsActive = v.items.filter((c) => !c.isArchived);
        setTeam(teamActive);
        setVendors(vendorsActive);
        if (teamActive.length === 0) setStep(1);
        else if (vendorsActive.length === 0) setStep(2);
        else setStep(3);
      })
      .catch(() => {
        // Non-fatal: keep step 1, user can still add.
      })
      .finally(() => {
        if (!cancelled) setInitialLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleFinish() {
    if (completing) return;
    if (team.length === 0 || vendors.length === 0) {
      toast.error("Нужно добавить хотя бы одного в команду и один рентал");
      return;
    }
    setCompleting(true);
    try {
      await completeOnboarding();
      await refresh();
      router.push("/gaffer/projects/new");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось завершить настройку");
      setCompleting(false);
    }
  }

  return (
    <div className="min-h-screen bg-surface">
      {/* Progress bar */}
      <div className="bg-accent text-white px-6 pt-6 pb-5">
        <div className="flex items-center justify-center gap-1.5 mb-3">
          {[1, 2, 3].map((s) => (
            <div
              key={s}
              className={`h-1.5 rounded-full transition-all ${
                s === step
                  ? "w-10 bg-white"
                  : s < step
                    ? "w-6 bg-white/80"
                    : "w-6 bg-white/25"
              }`}
            />
          ))}
        </div>
        <div
          className="text-center text-[10.5px] uppercase tracking-[1.4px] text-accent-border font-semibold"
          style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
        >
          {step === 1 && "Шаг 1 · Как это работает"}
          {step === 2 && "Шаг 2 · Твоя команда"}
          {step === 3 && "Шаг 3 · Рентал"}
        </div>
      </div>

      {initialLoading ? (
        <div className="px-5 pt-10 pb-10 text-center text-[12.5px] text-ink-3">
          Загружаем…
        </div>
      ) : (
        <>
          {step === 1 && (
            <Step1
              name={user?.name || user?.email?.split("@")[0] || null}
              onNext={() => setStep(2)}
            />
          )}

          {step === 2 && (
            <Step2
              team={team}
              onAdd={(c) => setTeam((prev) => [...prev, c])}
              onRemove={(id) => setTeam((prev) => prev.filter((c) => c.id !== id))}
              onBack={() => setStep(1)}
              onNext={() => setStep(3)}
            />
          )}

          {step === 3 && (
            <Step3
              vendors={vendors}
              onAdd={(c) => setVendors((prev) => [...prev, c])}
              onRemove={(id) => setVendors((prev) => prev.filter((c) => c.id !== id))}
              onBack={() => setStep(2)}
              onFinish={handleFinish}
              finishing={completing}
            />
          )}
        </>
      )}
    </div>
  );
}

// ─── Step 1 — Instructions ──────────────────────────────────────────────────

function Step1({ name, onNext }: { name: string | null; onNext: () => void }) {
  return (
    <>
      <div className="text-center px-6 pt-7 pb-5">
        <h2
          className="text-[22px] font-semibold text-ink tracking-tight mb-1.5"
          style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}
        >
          Привет{name ? `, ${name}` : ""}!
        </h2>
        <p className="text-ink-2 text-[13px] leading-relaxed m-0">
          Это простой учёт съёмок, долгов и выплат.
          <br />
          Настроим за минуту — три шага.
        </p>
      </div>

      <div className="px-5 pb-4 grid gap-[14px]">
        {[
          {
            n: "1",
            title: "Соберём команду и рентал",
            desc: "С кем работаешь: осветители, best boy, пультовики, рентал-партнёры. Это одноразовая настройка — потом всё добавишь в проект одним кликом.",
          },
          {
            n: "2",
            title: "Создаёшь проект",
            desc: "Название, заказчик, дата, бюджет. Выбираешь людей и рентал из своих списков — расчёт смен и тарифов автоматически.",
          },
          {
            n: "3",
            title: "Считаешь деньги",
            desc: "Пришёл перевод от клиента — «+ поступление». Выплатил команде — «+ выплата». Дашборд показывает, сколько вам должны и сколько должны вы.",
          },
        ].map((s) => (
          <div key={s.n} className="grid gap-3" style={{ gridTemplateColumns: "36px 1fr" }}>
            <div className="w-8 h-8 rounded-full bg-accent-soft border border-accent-border text-accent flex items-center justify-center font-mono font-semibold text-[13px] shrink-0">
              {s.n}
            </div>
            <div>
              <h4 className="text-[14px] font-semibold text-ink mt-1 mb-0.5">{s.title}</h4>
              <p className="text-[12.5px] text-ink-2 m-0 leading-relaxed">{s.desc}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="mx-5 mb-[18px] px-[14px] py-3 bg-emerald-soft border border-emerald-border rounded-lg text-[12px] text-emerald leading-relaxed">
        <b className="font-semibold">Важно:</b> первые два шага — обязательные.
        Без команды и рентала проект не посчитать.
      </div>

      <div className="px-5 pb-[22px] pt-1">
        <button
          onClick={onNext}
          className="w-full bg-accent-bright hover:bg-accent text-white font-medium rounded px-4 py-[12px] text-[14px] transition-colors"
        >
          Начать → собрать команду
        </button>
      </div>
    </>
  );
}

// ─── Step 2 — Team ──────────────────────────────────────────────────────────

function Step2({
  team,
  onAdd,
  onRemove,
  onBack,
  onNext,
}: {
  team: GafferContact[];
  onAdd: (c: GafferContact) => void;
  onRemove: (id: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [telegram, setTelegram] = useState("");
  const [role, setRole] = useState<string>("");
  const [shiftRate, setShiftRate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Укажи имя");
      return;
    }
    setSaving(true);
    try {
      const rate = Number(shiftRate);
      const shiftRateValue =
        Number.isFinite(rate) && rate > 0 ? String(rate) : undefined;
      const { contact } = await createContact({
        type: "TEAM_MEMBER",
        name: trimmed,
        phone: phone.trim() || undefined,
        telegram: telegram.trim() || undefined,
        roleLabel: role || null,
        shiftRate: shiftRateValue,
      });
      onAdd(contact);
      setName("");
      setPhone("");
      setTelegram("");
      setRole("");
      setShiftRate("");
    } catch (err) {
      if (err instanceof GafferApiError) setError(err.message);
      else setError("Не удалось добавить");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(id: string, contactName: string) {
    if (!confirm(`Убрать ${contactName} из команды?`)) return;
    try {
      await deleteContact(id);
      onRemove(id);
    } catch (err) {
      if (err instanceof GafferApiError) toast.error(err.message);
      else toast.error("Не удалось удалить");
    }
  }

  const canProceed = team.length >= 1;

  return (
    <>
      <div className="px-5 pt-6 pb-3">
        <h2 className="text-[18px] font-semibold text-ink mb-1">Твоя команда</h2>
        <p className="text-[12.5px] text-ink-2 leading-relaxed">
          Добавь людей, с которыми работаешь: осветителей, best boy, пультовиков.
          Нужен хотя бы один — потом всегда можно добавить ещё.
        </p>
      </div>

      {team.length > 0 && (
        <div className="px-5 pb-3 space-y-2">
          {team.map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between px-3 py-2 bg-surface border border-border rounded-md"
            >
              <div className="min-w-0 flex-1 pr-2">
                <div className="text-[13.5px] font-medium text-ink truncate">{c.name}</div>
                <div className="text-[11.5px] text-ink-3 truncate">
                  {c.roleLabel || "—"}
                  {c.phone ? ` · ${c.phone}` : ""}
                  {c.telegram ? ` · ${c.telegram}` : ""}
                </div>
              </div>
              <button
                onClick={() => handleRemove(c.id, c.name)}
                aria-label={`Убрать ${c.name}`}
                className="text-ink-3 hover:text-rose transition-colors text-[14px] px-2 py-1 shrink-0"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={handleAdd} className="px-5 pb-3">
        <div className="border border-border rounded-md p-3 bg-surface space-y-2">
          <input
            type="text"
            placeholder="Имя *"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={saving}
            autoComplete="off"
            className="w-full px-[10px] py-[8px] border border-border rounded text-[13px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright disabled:opacity-60"
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              type="tel"
              placeholder="Телефон"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={saving}
              autoComplete="off"
              className="w-full px-[10px] py-[8px] border border-border rounded text-[13px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright disabled:opacity-60"
            />
            <input
              type="text"
              placeholder="@telegram"
              value={telegram}
              onChange={(e) => setTelegram(e.target.value)}
              disabled={saving}
              autoComplete="off"
              className="w-full px-[10px] py-[8px] border border-border rounded text-[13px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright disabled:opacity-60"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              disabled={saving}
              className="w-full px-[10px] py-[8px] border border-border rounded text-[13px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright disabled:opacity-60"
            >
              <option value="">Роль</option>
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <input
              type="number"
              min="0"
              step="100"
              placeholder="Ставка за смену, ₽"
              value={shiftRate}
              onChange={(e) => setShiftRate(e.target.value)}
              disabled={saving}
              className="w-full px-[10px] py-[8px] border border-border rounded text-[13px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright disabled:opacity-60"
            />
          </div>
          {error && (
            <p className="text-rose text-[12px]" role="alert">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={saving || !name.trim()}
            className="w-full bg-accent-soft hover:bg-accent-border text-accent border border-accent-border font-medium rounded px-3 py-[9px] text-[13px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? "Добавляем…" : "+ Добавить в команду"}
          </button>
        </div>
      </form>

      <div className="px-5 pb-[22px] pt-2 grid gap-2">
        <button
          onClick={onNext}
          disabled={!canProceed}
          className="w-full bg-accent-bright hover:bg-accent text-white font-medium rounded px-4 py-[12px] text-[14px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {canProceed
            ? "Далее → рентал"
            : "Добавь хотя бы одного человека"}
        </button>
        <button
          onClick={onBack}
          className="w-full text-ink-3 hover:text-ink transition-colors text-[12px] py-1"
        >
          ← Назад
        </button>
      </div>
    </>
  );
}

// ─── Step 3 — Vendors ───────────────────────────────────────────────────────

function Step3({
  vendors,
  onAdd,
  onRemove,
  onBack,
  onFinish,
  finishing,
}: {
  vendors: GafferContact[];
  onAdd: (c: GafferContact) => void;
  onRemove: (id: string) => void;
  onBack: () => void;
  onFinish: () => void;
  finishing: boolean;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [telegram, setTelegram] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Укажи название рентала");
      return;
    }
    setSaving(true);
    try {
      const { contact } = await createContact({
        type: "VENDOR",
        name: trimmed,
        phone: phone.trim() || undefined,
        telegram: telegram.trim() || undefined,
        note: note.trim() || undefined,
      });
      onAdd(contact);
      setName("");
      setPhone("");
      setTelegram("");
      setNote("");
    } catch (err) {
      if (err instanceof GafferApiError) setError(err.message);
      else setError("Не удалось добавить");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(id: string, vendorName: string) {
    if (!confirm(`Убрать рентал ${vendorName}?`)) return;
    try {
      await deleteContact(id);
      onRemove(id);
    } catch (err) {
      if (err instanceof GafferApiError) toast.error(err.message);
      else toast.error("Не удалось удалить");
    }
  }

  const canFinish = vendors.length >= 1 && !finishing;

  return (
    <>
      <div className="px-5 pt-6 pb-3">
        <h2 className="text-[18px] font-semibold text-ink mb-1">Рентал</h2>
        <p className="text-[12.5px] text-ink-2 leading-relaxed">
          Компании, у которых берёшь свет в аренду. Нужен хотя бы один —
          без рентала проект не считается.
        </p>
      </div>

      {vendors.length > 0 && (
        <div className="px-5 pb-3 space-y-2">
          {vendors.map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between px-3 py-2 bg-surface border border-border rounded-md"
            >
              <div className="min-w-0 flex-1 pr-2">
                <div className="text-[13.5px] font-medium text-ink truncate">{c.name}</div>
                <div className="text-[11.5px] text-ink-3 truncate">
                  {c.phone || "—"}
                  {c.telegram ? ` · ${c.telegram}` : ""}
                  {c.note ? ` · ${c.note}` : ""}
                </div>
              </div>
              <button
                onClick={() => handleRemove(c.id, c.name)}
                aria-label={`Убрать ${c.name}`}
                className="text-ink-3 hover:text-rose transition-colors text-[14px] px-2 py-1 shrink-0"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={handleAdd} className="px-5 pb-3">
        <div className="border border-border rounded-md p-3 bg-surface space-y-2">
          <input
            type="text"
            placeholder="Название рентала *"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={saving}
            autoComplete="off"
            className="w-full px-[10px] py-[8px] border border-border rounded text-[13px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright disabled:opacity-60"
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              type="tel"
              placeholder="Телефон"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={saving}
              autoComplete="off"
              className="w-full px-[10px] py-[8px] border border-border rounded text-[13px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright disabled:opacity-60"
            />
            <input
              type="text"
              placeholder="@telegram"
              value={telegram}
              onChange={(e) => setTelegram(e.target.value)}
              disabled={saving}
              autoComplete="off"
              className="w-full px-[10px] py-[8px] border border-border rounded text-[13px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright disabled:opacity-60"
            />
          </div>
          <input
            type="text"
            placeholder="Комментарий (необязательно)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={saving}
            autoComplete="off"
            className="w-full px-[10px] py-[8px] border border-border rounded text-[13px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright disabled:opacity-60"
          />
          {error && (
            <p className="text-rose text-[12px]" role="alert">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={saving || !name.trim()}
            className="w-full bg-accent-soft hover:bg-accent-border text-accent border border-accent-border font-medium rounded px-3 py-[9px] text-[13px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? "Добавляем…" : "+ Добавить рентал"}
          </button>
        </div>
      </form>

      <div className="px-5 pb-[22px] pt-2 grid gap-2">
        <button
          onClick={onFinish}
          disabled={!canFinish}
          className="w-full bg-accent-bright hover:bg-accent text-white font-medium rounded px-4 py-[12px] text-[14px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {finishing
            ? "Готовим проект…"
            : vendors.length >= 1
              ? "Создать первый проект →"
              : "Добавь хотя бы один рентал"}
        </button>
        <button
          onClick={onBack}
          disabled={finishing}
          className="w-full text-ink-3 hover:text-ink transition-colors text-[12px] py-1 disabled:opacity-50"
        >
          ← Назад к команде
        </button>
      </div>
    </>
  );
}
