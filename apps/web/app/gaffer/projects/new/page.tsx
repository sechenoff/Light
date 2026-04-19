"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  createProject,
  createContact,
  listContacts,
  listContactsWithAggregates,
  GafferApiError,
  type GafferContact,
  type GafferContactWithAggregates,
} from "../../../../src/lib/gafferApi";
import { formatRub, pluralize } from "../../../../src/lib/format";
import { toast } from "../../../../src/components/ToastProvider";

// ─── Constants ────────────────────────────────────────────────────────────────

const DRAFT_KEY = "gaffer:projects-new:draft";

const ROLE_OPTIONS = [
  "Осветитель / Grip",
  "Best Boy",
  "Key Grip",
  "Пультовик",
  "DIT",
  "Gaffer",
] as const;

// ─── Types ────────────────────────────────────────────────────────────────────

interface NewProjectDraft {
  title: string;
  clientId: string;
  shootDate: string;
  clientPlanAmount: string;
  lightBudgetAmount: string;
  note: string;
}

interface SelectedMember {
  contactId: string;
  shifts: number;
  hours: number;
  plannedAmount: number;
}

interface SelectedVendor {
  contactId: string;
  plannedAmount: number;
}

// ─── Cost computation helper ──────────────────────────────────────────────────

function calcMemberCost(
  shiftRate: number,
  ot1Rate: number,
  ot2Rate: number,
  ot3Rate: number,
  shifts: number,
  hoursPerShift: number,
): { total: number; otText: string | null } {
  const BASE = 10;
  const T1_MAX = 8;
  const T2_MAX = 14; // cumulative: tier 2 covers hours 9–14 = 6 hours
  const otPerShift = Math.max(0, hoursPerShift - BASE);
  const ot1 = Math.min(otPerShift, T1_MAX);
  const ot2 = Math.min(Math.max(0, otPerShift - T1_MAX), T2_MAX - T1_MAX);
  const ot3 = Math.max(0, otPerShift - T2_MAX);
  const perShift = shiftRate + Math.round(ot1 * ot1Rate + ot2 * ot2Rate + ot3 * ot3Rate);
  const total = Math.round(perShift * shifts);
  if (otPerShift === 0) return { total, otText: null };
  const tier = ot3 > 0 ? 3 : ot2 > 0 ? 2 : 1;
  const otText = `+${otPerShift} ч ОТ · тир ${tier}`;
  return { total, otText };
}

function deriveOtRates(shiftRate: number): {
  overtimeTier1Rate: number;
  overtimeTier2Rate: number;
  overtimeTier3Rate: number;
} {
  const hourRate = Math.round(shiftRate / 10);
  return {
    overtimeTier1Rate: hourRate,
    overtimeTier2Rate: hourRate * 2,
    overtimeTier3Rate: hourRate * 4,
  };
}

// ─── Small UI components ──────────────────────────────────────────────────────

function WizardStep({
  n,
  title,
  subtitle,
}: {
  n: number;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex items-baseline gap-3 px-4 pt-6 pb-2">
      <span className="w-6 h-6 rounded-full bg-accent-bright text-white text-[12px] font-bold flex items-center justify-center shrink-0">
        {n}
      </span>
      <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
      <span className="text-[11.5px] text-ink-3">{subtitle}</span>
    </div>
  );
}

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-1 rounded text-[12px] font-medium border transition-colors ${
        active
          ? "bg-accent-bright text-white border-accent-bright"
          : "bg-surface text-ink-2 border-border hover:bg-[#fafafa]"
      }`}
    >
      {children}
    </button>
  );
}

function SummaryRow({
  label,
  sub,
  value,
  tone = "neutral",
  big = false,
}: {
  label: string;
  sub?: string;
  value: string;
  tone?: "neutral" | "rose" | "emerald";
  big?: boolean;
}) {
  const isEmerald = tone === "emerald";
  return (
    <div
      className={`px-3 py-2.5 flex items-center justify-between border-b border-border last:border-b-0 ${
        isEmerald ? "bg-emerald-soft border-t border-emerald-border" : ""
      }`}
    >
      <div>
        <div className="text-[13px] font-medium text-ink">{label}</div>
        {sub && <div className="text-[11px] text-ink-3">{sub}</div>}
      </div>
      <div
        className={`mono-num font-semibold ${big ? "text-[16px]" : "text-[13.5px]"} ${
          tone === "rose" ? "text-rose" : tone === "emerald" ? "text-emerald" : "text-ink"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

function GafferNewProjectContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // ── Form state ──
  const [title, setTitle] = useState("");
  const [clientId, setClientId] = useState("");
  const [shootDate, setShootDate] = useState("");
  const [clientPlanAmount, setClientPlanAmount] = useState("0");
  const [lightBudgetAmount, setLightBudgetAmount] = useState("0");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // ── Data ──
  const [clients, setClients] = useState<GafferContactWithAggregates[] | null>(null);
  const [teamContacts, setTeamContacts] = useState<GafferContact[] | null>(null);

  // ── Step 1: inline new client form ──
  const [clientFormOpen, setClientFormOpen] = useState(false);
  const [newClientName, setNewClientName] = useState("");
  const [newClientPhone, setNewClientPhone] = useState("");
  const [newClientTelegram, setNewClientTelegram] = useState("");
  const [newClientNote, setNewClientNote] = useState("");
  const [savingClient, setSavingClient] = useState(false);

  // ── Step 5: team ──
  const [selectedMembers, setSelectedMembers] = useState<SelectedMember[]>([]);
  const [bulkShifts, setBulkShifts] = useState<number | null>(1);
  const [bulkHours, setBulkHours] = useState<number | null>(10);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [newMemberName, setNewMemberName] = useState("");
  const [newMemberRole, setNewMemberRole] = useState<string>(ROLE_OPTIONS[0]);
  const [newMemberShiftRate, setNewMemberShiftRate] = useState("");
  const [newMemberContact, setNewMemberContact] = useState(""); // phone or @telegram
  const [savingMember, setSavingMember] = useState(false);

  // ── Step 4: vendors (rentals) ──
  const [selectedVendors, setSelectedVendors] = useState<SelectedVendor[]>([]);
  const [vendorContacts, setVendorContacts] = useState<GafferContact[] | null>(null);
  const [addVendorOpen, setAddVendorOpen] = useState(false);
  const [newVendorName, setNewVendorName] = useState("");
  const [newVendorContact, setNewVendorContact] = useState(""); // phone or @telegram
  const [savingVendor, setSavingVendor] = useState(false);

  const clientFormRef = useRef<HTMLDetailsElement>(null);
  const memberFormRef = useRef<HTMLDetailsElement>(null);

  // ── Restore draft from sessionStorage on mount ──
  useEffect(() => {
    const crewAmount = searchParams.get("crewAmount");
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (raw) {
      try {
        const draft: NewProjectDraft = JSON.parse(raw);
        setTitle(draft.title);
        setClientId(draft.clientId);
        setShootDate(draft.shootDate);
        setLightBudgetAmount(draft.lightBudgetAmount);
        setNote(draft.note);
        setClientPlanAmount(crewAmount ? crewAmount : draft.clientPlanAmount);
      } catch {
        // malformed draft — ignore
      }
      sessionStorage.removeItem(DRAFT_KEY);
    } else if (crewAmount) {
      setClientPlanAmount(crewAmount);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Pre-select client from ?clientId= param ──
  const preselectedClientId = searchParams.get("clientId") ?? "";

  // ── Load clients ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await listContactsWithAggregates({ type: "CLIENT", isArchived: false });
        if (!cancelled) {
          setClients(res.items);
          if (
            preselectedClientId &&
            res.items.some((c) => c.id === preselectedClientId)
          ) {
            setClientId(preselectedClientId);
          }
        }
      } catch {
        if (!cancelled) setClients([]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Load team contacts ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await listContacts({ type: "TEAM_MEMBER", isArchived: false });
        if (!cancelled) setTeamContacts(res.items);
      } catch {
        if (!cancelled) setTeamContacts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Load vendor contacts ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await listContacts({ type: "VENDOR", isArchived: false });
        if (!cancelled) setVendorContacts(res.items);
      } catch {
        if (!cancelled) setVendorContacts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Client dropdown label helper ──
  function clientOptionLabel(c: GafferContactWithAggregates): string {
    const parts: string[] = [c.name];
    if (c.projectCount > 0) {
      parts.push(
        `${c.projectCount} ${pluralize(c.projectCount, "проект", "проекта", "проектов")}`,
      );
    }
    if (c.remainingToMe !== "0" && Number(c.remainingToMe) > 0) {
      parts.push(`долг ${formatRub(+c.remainingToMe)}`);
    }
    return parts.join(" · ");
  }

  // ── Create inline client ──
  async function handleCreateClient(e: React.FormEvent) {
    e.preventDefault();
    if (!newClientName.trim()) return;
    setSavingClient(true);
    try {
      const phoneVal = newClientPhone.trim() || undefined;
      const tgVal = newClientTelegram.trim() || undefined;
      const res = await createContact({
        type: "CLIENT",
        name: newClientName.trim(),
        phone: phoneVal,
        telegram: tgVal,
        note: newClientNote.trim() || undefined,
      });
      toast.success("Клиент создан");
      // Refresh clients list and select the new one
      setClients((prev) => {
        const newItem: GafferContactWithAggregates = {
          ...res.contact,
          asClientCount: 0,
          asMemberCount: 0,
          projectCount: 0,
          remainingToMe: "0",
          remainingFromMe: "0",
        };
        return prev ? [...prev, newItem] : [newItem];
      });
      setClientId(res.contact.id);
      // Reset and close form
      setNewClientName("");
      setNewClientPhone("");
      setNewClientTelegram("");
      setNewClientNote("");
      setClientFormOpen(false);
    } catch (err) {
      if (err instanceof GafferApiError) toast.error(err.message);
      else toast.error("Не удалось создать клиента");
    } finally {
      setSavingClient(false);
    }
  }

  // ── Team member toggle ──
  function toggleMember(contactId: string) {
    setSelectedMembers((prev) => {
      if (prev.some((m) => m.contactId === contactId)) {
        return prev.filter((m) => m.contactId !== contactId);
      }
      // Add with current bulk defaults
      const contact = teamContacts?.find((c) => c.id === contactId);
      if (!contact) return prev;
      const shifts = bulkShifts ?? 1;
      const hours = bulkHours ?? 10;
      const { total } = calcMemberCost(
        +contact.shiftRate,
        +contact.overtimeTier1Rate,
        +contact.overtimeTier2Rate,
        +contact.overtimeTier3Rate,
        shifts,
        hours,
      );
      return [...prev, { contactId, shifts, hours, plannedAmount: total }];
    });
  }

  function recomputeMember(m: SelectedMember): SelectedMember {
    const contact = teamContacts?.find((c) => c.id === m.contactId);
    if (!contact) return m;
    const { total } = calcMemberCost(
      +contact.shiftRate,
      +contact.overtimeTier1Rate,
      +contact.overtimeTier2Rate,
      +contact.overtimeTier3Rate,
      m.shifts,
      m.hours,
    );
    return { ...m, plannedAmount: total };
  }

  function applyBulkShifts(n: number) {
    setBulkShifts(n);
    setSelectedMembers((prev) =>
      prev.map((m) => recomputeMember({ ...m, shifts: n })),
    );
  }

  function applyBulkHours(n: number) {
    setBulkHours(n);
    setSelectedMembers((prev) =>
      prev.map((m) => recomputeMember({ ...m, hours: n })),
    );
  }

  function updateMemberField(
    contactId: string,
    field: "shifts" | "hours",
    value: number,
  ) {
    setSelectedMembers((prev) =>
      prev.map((m) => {
        if (m.contactId !== contactId) return m;
        const updated = { ...m, [field]: value };
        return recomputeMember(updated);
      }),
    );
    if (field === "shifts") setBulkShifts(null);
    if (field === "hours") setBulkHours(null);
  }

  // ── Create inline team member ──
  async function handleCreateMember(e: React.FormEvent) {
    e.preventDefault();
    if (!newMemberName.trim() || !newMemberShiftRate.trim()) return;
    setSavingMember(true);
    try {
      const shiftRate = Number(newMemberShiftRate) || 0;
      const otRates = deriveOtRates(shiftRate);
      // Parse phone/telegram: if starts with @ → telegram, else phone
      const contactVal = newMemberContact.trim();
      const isTg = contactVal.startsWith("@");
      const res = await createContact({
        type: "TEAM_MEMBER",
        name: newMemberName.trim(),
        phone: !isTg && contactVal ? contactVal : undefined,
        telegram: isTg ? contactVal : undefined,
        shiftRate: String(shiftRate),
        overtimeTier1Rate: String(otRates.overtimeTier1Rate),
        overtimeTier2Rate: String(otRates.overtimeTier2Rate),
        overtimeTier3Rate: String(otRates.overtimeTier3Rate),
        roleLabel: newMemberRole || null,
      });
      toast.success("Осветитель добавлен");
      setTeamContacts((prev) => (prev ? [...prev, res.contact] : [res.contact]));
      // Auto-select
      const shifts = bulkShifts ?? 1;
      const hours = bulkHours ?? 10;
      const { total } = calcMemberCost(shiftRate, otRates.overtimeTier1Rate, otRates.overtimeTier2Rate, otRates.overtimeTier3Rate, shifts, hours);
      setSelectedMembers((prev) => [
        ...prev,
        { contactId: res.contact.id, shifts, hours, plannedAmount: total },
      ]);
      // Reset
      setNewMemberName("");
      setNewMemberRole(ROLE_OPTIONS[0]);
      setNewMemberShiftRate("");
      setNewMemberContact("");
      setAddMemberOpen(false);
    } catch (err) {
      if (err instanceof GafferApiError) toast.error(err.message);
      else toast.error("Не удалось добавить осветителя");
    } finally {
      setSavingMember(false);
    }
  }

  // ── Vendor toggle ──
  function toggleVendor(contactId: string) {
    setSelectedVendors((prev) => {
      if (prev.some((v) => v.contactId === contactId)) {
        return prev.filter((v) => v.contactId !== contactId);
      }
      return [...prev, { contactId, plannedAmount: 0 }];
    });
  }

  function updateVendorAmount(contactId: string, amount: number) {
    setSelectedVendors((prev) =>
      prev.map((v) => (v.contactId === contactId ? { ...v, plannedAmount: amount } : v)),
    );
  }

  // ── Create inline vendor ──
  async function handleCreateVendor(e: React.FormEvent) {
    e.preventDefault();
    if (!newVendorName.trim()) return;
    setSavingVendor(true);
    try {
      const contactVal = newVendorContact.trim();
      const isTg = contactVal.startsWith("@");
      const res = await createContact({
        type: "VENDOR",
        name: newVendorName.trim(),
        phone: !isTg && contactVal ? contactVal : undefined,
        telegram: isTg ? contactVal : undefined,
      });
      toast.success("Рентал добавлен");
      setVendorContacts((prev) => (prev ? [...prev, res.contact] : [res.contact]));
      setSelectedVendors((prev) => [...prev, { contactId: res.contact.id, plannedAmount: 0 }]);
      setNewVendorName("");
      setNewVendorContact("");
      setAddVendorOpen(false);
    } catch (err) {
      if (err instanceof GafferApiError) toast.error(err.message);
      else toast.error("Не удалось добавить рентал");
    } finally {
      setSavingVendor(false);
    }
  }

  // ── Computed values ──
  const teamTotal = selectedMembers.reduce((s, m) => s + m.plannedAmount, 0);
  const vendorTotal = selectedVendors.reduce((s, v) => s + v.plannedAmount, 0);
  const clientPlan = Number(clientPlanAmount) || 0;
  const lightBudget = vendorTotal; // derived from rental picker
  const margin = clientPlan - lightBudget - teamTotal;
  const totalShifts = selectedMembers.reduce((s, m) => s + m.shifts, 0);

  const canSubmit = Boolean(title.trim() && clientId && shootDate);

  // ── Submit ──
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
      const teamPayload = selectedMembers
        .filter((m) => m.shifts > 0 && m.hours > 0)
        .map((m) => {
          const contact = teamContacts?.find((c) => c.id === m.contactId);
          return {
            contactId: m.contactId,
            plannedAmount: String(m.plannedAmount),
            roleLabel: contact?.roleLabel ?? undefined,
          };
        });
      const vendorPayload = selectedVendors
        .filter((v) => v.plannedAmount > 0)
        .map((v) => ({
          contactId: v.contactId,
          plannedAmount: String(v.plannedAmount),
        }));
      const membersPayload = [...teamPayload, ...vendorPayload];

      const res = await createProject({
        title: title.trim(),
        clientId,
        shootDate,
        clientPlanAmount: clientPlanAmount.trim() || "0",
        lightBudgetAmount: String(vendorTotal),
        note: note.trim() || undefined,
        members: membersPayload.length > 0 ? membersPayload : undefined,
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

  const inputClass =
    "w-full px-[11px] py-[9px] border border-border rounded text-[13.5px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright";
  const inputErrorClass =
    "w-full px-[11px] py-[9px] border border-rose-border rounded text-[13.5px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border";
  const sectionClass = "mx-4 mb-4 border border-border rounded bg-surface p-4";

  return (
    <div className="min-h-screen bg-surface pb-20">
      {/* ─── Top bar ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-surface">
        <Link
          href="/gaffer/projects"
          className="text-accent-bright hover:text-accent text-[13px] font-medium"
        >
          ← Проекты
        </Link>
        <div className="w-7 h-7 rounded-full bg-accent-soft text-accent text-[11px] font-semibold flex items-center justify-center">
          КЛ
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        {/* ═══════════════════════════════ STEP 1 — Клиент ═══════════════ */}
        <WizardStep n={1} title="Клиент" subtitle="кто платит за съёмку" />
        <section className={sectionClass}>
          {clients === null ? (
            <div className="h-[39px] bg-border rounded animate-pulse" />
          ) : (
            <select
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className={errors.clientId ? inputErrorClass : inputClass}
            >
              <option value="">— Выберите заказчика —</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {clientOptionLabel(c)}
                </option>
              ))}
            </select>
          )}
          {errors.clientId && (
            <p className="text-rose text-[11.5px] mt-1">{errors.clientId}</p>
          )}

          {/* Inline new client form */}
          <details
            ref={clientFormRef}
            open={clientFormOpen}
            onToggle={(e) => setClientFormOpen((e.target as HTMLDetailsElement).open)}
            className="mt-3"
          >
            <summary className="cursor-pointer text-[12.5px] text-accent-bright font-medium select-none">
              + Новый клиент
            </summary>
            <div className="mt-3 space-y-2.5">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11.5px] text-ink-2 mb-0.5">
                    Название / ФИО <span className="text-rose">*</span>
                  </label>
                  <input
                    value={newClientName}
                    onChange={(e) => setNewClientName(e.target.value)}
                    placeholder="Напр. Синий Кит Медиа"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-[11.5px] text-ink-2 mb-0.5">Телефон</label>
                  <input
                    value={newClientPhone}
                    onChange={(e) => setNewClientPhone(e.target.value)}
                    placeholder="+7 999 999-99-99"
                    className={inputClass}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11.5px] text-ink-2 mb-0.5">Telegram</label>
                  <input
                    value={newClientTelegram}
                    onChange={(e) => setNewClientTelegram(e.target.value)}
                    placeholder="@username"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-[11.5px] text-ink-2 mb-0.5">Комментарий</label>
                  <input
                    value={newClientNote}
                    onChange={(e) => setNewClientNote(e.target.value)}
                    placeholder="на кого работает, продюсер…"
                    className={inputClass}
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setClientFormOpen(false);
                    if (clientFormRef.current) clientFormRef.current.open = false;
                  }}
                  className="px-3 py-2 text-[13px] text-ink-2 hover:text-ink rounded transition-colors"
                >
                  Отмена
                </button>
                <button
                  type="button"
                  disabled={savingClient || !newClientName.trim()}
                  onClick={handleCreateClient}
                  className="bg-accent-bright hover:bg-accent text-white font-medium rounded px-3 py-2 text-[13px] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {savingClient ? "Сохраняем…" : "Создать и выбрать"}
                </button>
              </div>
            </div>
          </details>
        </section>

        {/* ═══════════════════════════════ STEP 2 — Проект ════════════════ */}
        <WizardStep n={2} title="Проект" subtitle="название и дата" />
        <section className={sectionClass}>
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-[11.5px] text-ink-2 mb-0.5">
                Название <span className="text-rose">*</span>
              </label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Клип «Синяя волна»"
                maxLength={100}
                className={errors.title ? inputErrorClass : inputClass}
              />
              {errors.title && (
                <p className="text-rose text-[11.5px] mt-0.5">{errors.title}</p>
              )}
            </div>
            <div>
              <label className="block text-[11.5px] text-ink-2 mb-0.5">
                Дата съёмки <span className="text-rose">*</span>
              </label>
              <input
                type="date"
                value={shootDate}
                onChange={(e) => setShootDate(e.target.value)}
                className={errors.shootDate ? inputErrorClass : inputClass}
              />
              {errors.shootDate && (
                <p className="text-rose text-[11.5px] mt-0.5">{errors.shootDate}</p>
              )}
            </div>
          </div>
          <div className="mt-2.5">
            <label className="block text-[11.5px] text-ink-2 mb-0.5">
              Комментарий (необязательно)
            </label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Любая дополнительная информация…"
              className={inputClass}
            />
          </div>
        </section>

        {/* ═══════════════════════════════ STEP 3 — Сумма от клиента ══════ */}
        <WizardStep n={3} title="Сумма от клиента" subtitle="общая договорённость" />
        <section className={sectionClass}>
          <label className="block text-[11.5px] text-ink-2 mb-0.5">
            Договорная сумма с заказчиком (что получу за проект)
          </label>
          <div className="relative">
            <input
              type="number"
              min="0"
              step="1"
              value={clientPlanAmount}
              onChange={(e) => setClientPlanAmount(e.target.value)}
              className="w-full px-[11px] py-[9px] pr-7 border border-border rounded text-[16px] font-semibold mono-num bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright"
            />
            <span className="absolute right-[11px] top-1/2 -translate-y-1/2 text-ink-3 text-[13px]">
              ₽
            </span>
          </div>
          <p className="mt-1.5 text-[11.5px] text-ink-3">
            Это не прибыль — из неё гаффер платит ренталу за свет и команде за смены. Остаток — маржа.
          </p>
          {/* Calculator roundtrip button */}
          <button
            type="button"
            onClick={() => {
              const draft: NewProjectDraft = {
                title,
                clientId,
                shootDate,
                clientPlanAmount,
                lightBudgetAmount,
                note,
              };
              sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
              router.push("/gaffer/crew-calculator?returnTo=/gaffer/projects/new");
            }}
            className="mt-2.5 w-full flex items-center justify-center gap-1.5 px-3 py-2 border border-border bg-surface hover:bg-[#fafafa] text-accent-bright text-[12.5px] rounded transition-colors"
          >
            Калькулятор команды осветителей
          </button>
        </section>

        {/* ═══════════════════════════════ STEP 4 — Аренда света ══════════ */}
        <WizardStep n={4} title="Аренда света" subtitle="рентал(ы) и сколько им заплатить" />
        <section className={sectionClass}>
          {vendorContacts === null ? (
            <div className="h-20 bg-border rounded animate-pulse" />
          ) : (
            <>
              {/* Vendor contact grid */}
              <div className="grid grid-cols-2 gap-2">
                {vendorContacts.map((c) => {
                  const isSelected = selectedVendors.some((v) => v.contactId === c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => toggleVendor(c.id)}
                      className={`text-left rounded-md p-2.5 border transition-colors ${
                        isSelected
                          ? "border-accent-bright bg-accent-soft"
                          : "border-border bg-surface hover:bg-[#fafafa]"
                      }`}
                    >
                      <div className="text-[13px] font-semibold text-ink">{c.name}</div>
                      <div className="text-[11.5px] text-ink-3">
                        {c.phone || c.telegram || "—"}
                      </div>
                    </button>
                  );
                })}
                {/* Add new vendor button */}
                <button
                  type="button"
                  onClick={() => setAddVendorOpen(true)}
                  className="text-[12.5px] text-accent-bright rounded-md border border-dashed border-accent-border bg-surface hover:bg-accent-soft p-2.5 text-left"
                >
                  + Новый рентал
                </button>
              </div>

              {/* Inline new vendor form */}
              {addVendorOpen && (
                <div className="mt-3 border border-border rounded-md p-3 space-y-2.5 bg-surface">
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] font-semibold text-ink">Новый рентал</span>
                    <button
                      type="button"
                      onClick={() => setAddVendorOpen(false)}
                      className="text-ink-3 hover:text-ink text-[14px]"
                      aria-label="Закрыть форму"
                    >
                      ✕
                    </button>
                  </div>
                  <div>
                    <label className="block text-[11.5px] text-ink-2 mb-0.5">
                      Название <span className="text-rose">*</span>
                    </label>
                    <input
                      value={newVendorName}
                      onChange={(e) => setNewVendorName(e.target.value)}
                      placeholder="Напр. Svetobaza"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="block text-[11.5px] text-ink-2 mb-0.5">
                      Телефон или @telegram
                    </label>
                    <input
                      value={newVendorContact}
                      onChange={(e) => setNewVendorContact(e.target.value)}
                      placeholder="+7 999 ... или @handle"
                      className={inputClass}
                    />
                  </div>
                  <button
                    type="button"
                    disabled={savingVendor || !newVendorName.trim()}
                    onClick={handleCreateVendor}
                    className="w-full bg-accent-bright hover:bg-accent text-white font-medium rounded px-3 py-2 text-[13px] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {savingVendor ? "Сохраняем…" : "Добавить рентал"}
                  </button>
                </div>
              )}

              {/* Per-vendor amount rows */}
              {selectedVendors.length > 0 && (
                <div className="mt-3 border border-border rounded-md overflow-hidden bg-surface">
                  <div className="flex items-baseline justify-between px-3 py-2 bg-surface-2 border-b border-border">
                    <span className="eyebrow">Суммы ренталов</span>
                    <span className="text-[11px] text-ink-3">
                      введите сумму для каждого
                    </span>
                  </div>
                  {selectedVendors.map((v) => {
                    const contact = vendorContacts.find((c) => c.id === v.contactId);
                    if (!contact) return null;
                    return (
                      <div
                        key={v.contactId}
                        className="px-3 py-2.5 border-b border-border last:border-b-0"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="text-[13px] font-semibold text-ink truncate">
                              {contact.name}
                            </div>
                            <div className="text-[11.5px] text-ink-3 truncate">
                              {contact.phone || contact.telegram || "—"}
                            </div>
                          </div>
                          <div className="relative shrink-0 w-[140px]">
                            <input
                              type="number"
                              min="0"
                              step="1"
                              value={v.plannedAmount || ""}
                              onChange={(e) =>
                                updateVendorAmount(
                                  v.contactId,
                                  Math.max(0, Number(e.target.value) || 0),
                                )
                              }
                              placeholder="0"
                              className="w-full px-2 py-1.5 pr-6 border border-border rounded text-[13.5px] mono-num bg-surface text-ink text-right focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright"
                            />
                            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-3 text-[12px]">
                              ₽
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {/* Sum row */}
                  <div className="px-3 py-2 bg-surface-2 border-t border-border flex items-center justify-between">
                    <span className="text-[12px] font-medium text-ink-2">
                      Итого по ренталам
                    </span>
                    <span className="text-[14px] font-semibold text-ink mono-num">
                      {formatRub(vendorTotal)}
                    </span>
                  </div>
                </div>
              )}

              {selectedVendors.length === 0 && !addVendorOpen && (
                <p className="mt-2 text-[11.5px] text-ink-3">
                  Один или несколько ренталов. Сумма по каждому — что им заплатить за оборудование.
                </p>
              )}
            </>
          )}
        </section>

        {/* ═══════════════════════════════ STEP 5 — Команда ═══════════════ */}
        <WizardStep n={5} title="Команда" subtitle="кто работает на смене" />
        <section className={sectionClass}>
          {teamContacts === null ? (
            <div className="h-20 bg-border rounded animate-pulse" />
          ) : (
            <>
              {/* Team contact grid */}
              <div className="grid grid-cols-2 gap-2">
                {teamContacts.map((c) => {
                  const isSelected = selectedMembers.some((m) => m.contactId === c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => toggleMember(c.id)}
                      className={`text-left rounded-md p-2.5 border transition-colors ${
                        isSelected
                          ? "border-accent-bright bg-accent-soft"
                          : "border-border bg-surface hover:bg-[#fafafa]"
                      }`}
                    >
                      <div className="text-[13px] font-semibold text-ink">{c.name}</div>
                      <div className="text-[11.5px] text-ink-3">{c.roleLabel || "—"}</div>
                      <div className="text-[11.5px] text-ink-2 mono-num">
                        {formatRub(+c.shiftRate)} / смена
                      </div>
                    </button>
                  );
                })}
                {/* Add new member button */}
                <button
                  type="button"
                  onClick={() => setAddMemberOpen(true)}
                  className="text-[12.5px] text-accent-bright rounded-md border border-dashed border-accent-border bg-surface hover:bg-accent-soft p-2.5 text-left"
                >
                  + Новый осветитель
                </button>
              </div>

              {/* Inline new member form */}
              {addMemberOpen && (
                <div className="mt-3 border border-border rounded-md p-3 space-y-2.5 bg-surface">
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] font-semibold text-ink">Новый осветитель</span>
                    <button
                      type="button"
                      onClick={() => setAddMemberOpen(false)}
                      className="text-ink-3 hover:text-ink text-[14px]"
                      aria-label="Закрыть форму"
                    >
                      ✕
                    </button>
                  </div>
                  <div>
                    <label className="block text-[11.5px] text-ink-2 mb-0.5">
                      Имя <span className="text-rose">*</span>
                    </label>
                    <input
                      value={newMemberName}
                      onChange={(e) => setNewMemberName(e.target.value)}
                      placeholder="Алексей Смирнов"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="block text-[11.5px] text-ink-2 mb-0.5">Роль</label>
                    <select
                      value={newMemberRole}
                      onChange={(e) => setNewMemberRole(e.target.value)}
                      className={inputClass}
                    >
                      {ROLE_OPTIONS.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11.5px] text-ink-2 mb-0.5">
                      Ставка за смену (10 ч) <span className="text-rose">*</span>
                    </label>
                    <div className="relative">
                      <input
                        type="number"
                        min="0"
                        step="100"
                        value={newMemberShiftRate}
                        onChange={(e) => setNewMemberShiftRate(e.target.value)}
                        placeholder="5000"
                        className="w-full px-[11px] py-[9px] pr-7 border border-border rounded text-[13.5px] mono-num bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright"
                      />
                      <span className="absolute right-[11px] top-1/2 -translate-y-1/2 text-ink-3 text-[13px]">
                        ₽
                      </span>
                    </div>
                    {newMemberShiftRate && Number(newMemberShiftRate) > 0 && (
                      <p className="mt-0.5 text-[11px] text-ink-3">
                        ОТ: тир 1 = {formatRub(Math.round(Number(newMemberShiftRate) / 10))}/ч,
                        тир 2 = {formatRub(Math.round(Number(newMemberShiftRate) / 10) * 2)}/ч,
                        тир 3 = {formatRub(Math.round(Number(newMemberShiftRate) / 10) * 4)}/ч
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="block text-[11.5px] text-ink-2 mb-0.5">
                      Телефон или @telegram
                    </label>
                    <input
                      value={newMemberContact}
                      onChange={(e) => setNewMemberContact(e.target.value)}
                      placeholder="+7 999 ... или @handle"
                      className={inputClass}
                    />
                  </div>
                  <button
                    type="button"
                    disabled={savingMember || !newMemberName.trim() || !newMemberShiftRate.trim()}
                    onClick={handleCreateMember}
                    className="w-full bg-accent-bright hover:bg-accent text-white font-medium rounded px-3 py-2 text-[13px] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {savingMember ? "Сохраняем…" : "Добавить осветителя"}
                  </button>
                </div>
              )}

              {/* Bulk presets strip */}
              <div className="mt-4 bg-surface-2 border border-border rounded-md p-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] text-ink-3 uppercase tracking-wide">Смен</span>
                  {[1, 2, 3].map((n) => (
                    <Pill key={n} active={bulkShifts === n} onClick={() => applyBulkShifts(n)}>
                      {n}
                    </Pill>
                  ))}
                  <Pill active={bulkShifts === null} onClick={() => setBulkShifts(null)}>свой</Pill>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] text-ink-3 uppercase tracking-wide">Часов</span>
                  {[10, 12, 14, 16].map((n) => (
                    <Pill key={n} active={bulkHours === n} onClick={() => applyBulkHours(n)}>
                      {n}
                    </Pill>
                  ))}
                  <Pill active={bulkHours === null} onClick={() => setBulkHours(null)}>свой</Pill>
                </div>
              </div>

              {/* Per-member shift table */}
              {selectedMembers.length > 0 && (
                <div className="mt-3 border border-border rounded-md overflow-hidden bg-surface">
                  <div className="flex items-baseline justify-between px-3 py-2 bg-surface-2 border-b border-border">
                    <span className="eyebrow">Смены участников</span>
                    <span className="text-[11px] text-ink-3">
                      часы можно поменять индивидуально
                    </span>
                  </div>
                  {selectedMembers.map((m) => {
                    const contact = teamContacts.find((c) => c.id === m.contactId);
                    if (!contact) return null;
                    const { otText } = calcMemberCost(
                      +contact.shiftRate,
                      +contact.overtimeTier1Rate,
                      +contact.overtimeTier2Rate,
                      +contact.overtimeTier3Rate,
                      m.shifts,
                      m.hours,
                    );
                    return (
                      <div
                        key={m.contactId}
                        className="px-3 py-2.5 border-b border-border last:border-b-0"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="text-[13px] font-semibold text-ink">
                              {contact.name}
                            </div>
                            <div className="text-[11.5px] text-ink-3">
                              {contact.roleLabel || "—"} · {formatRub(+contact.shiftRate)}/смена
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <div className="text-[13.5px] font-semibold text-ink mono-num">
                              {formatRub(m.plannedAmount)}
                            </div>
                            {otText && (
                              <div className="text-[11px] text-ink-3">{otText}</div>
                            )}
                          </div>
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <label className="text-[11.5px] text-ink-2">
                            Смен
                            <input
                              type="number"
                              min={0}
                              step={1}
                              value={m.shifts}
                              onChange={(e) =>
                                updateMemberField(
                                  m.contactId,
                                  "shifts",
                                  Math.max(0, Number(e.target.value)),
                                )
                              }
                              className="block w-full mt-0.5 px-2 py-1 border border-border rounded text-[13px] bg-surface text-ink mono-num focus:ring-2 focus:ring-accent-border"
                            />
                          </label>
                          <label className="text-[11.5px] text-ink-2">
                            Часов
                            <input
                              type="number"
                              min={0}
                              step={1}
                              value={m.hours}
                              onChange={(e) =>
                                updateMemberField(
                                  m.contactId,
                                  "hours",
                                  Math.max(0, Number(e.target.value)),
                                )
                              }
                              className="block w-full mt-0.5 px-2 py-1 border border-border rounded text-[13px] bg-surface text-ink mono-num focus:ring-2 focus:ring-accent-border"
                            />
                          </label>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* OT callout */}
              <div className="mt-3 bg-amber-soft border border-amber-border rounded-md px-3 py-2.5 text-[11.5px] text-amber">
                <b>Переработки:</b> первые 8 ч сверх смены — тир 1 (×1 ставки часа), следующие
                6 ч — тир 2 (×2), далее — тир 3 (×4). Те же формулы, что в общем калькуляторе
                гаффера.
              </div>
            </>
          )}
        </section>

        {/* ═══════════════════════════════ STEP 6 — Итог ═══════════════════ */}
        <WizardStep n={6} title="Итог" subtitle="что сложилось" />
        <section className={sectionClass}>
          <div className="border border-border rounded-md overflow-hidden bg-surface">
            <SummaryRow
              label="От клиента"
              sub="договорная сумма"
              value={formatRub(clientPlan)}
              tone="neutral"
              big
            />
            <SummaryRow
              label="Должен ренталу"
              sub={
                selectedVendors.length > 0
                  ? `${selectedVendors.length} ${pluralize(
                      selectedVendors.length,
                      "рентал",
                      "рентала",
                      "ренталов",
                    )}`
                  : "рентал не выбран"
              }
              value={`− ${formatRub(lightBudget)}`}
              tone="rose"
            />
            <SummaryRow
              label="Должен команде"
              sub={
                selectedMembers.length > 0
                  ? `${selectedMembers.length} чел. · ${totalShifts} ${pluralize(
                      totalShifts,
                      "смена",
                      "смены",
                      "смен",
                    )}`
                  : "команда не выбрана"
              }
              value={`− ${formatRub(teamTotal)}`}
              tone="rose"
            />
            <SummaryRow
              label="Моя маржа"
              sub="после всех выплат"
              value={formatRub(margin)}
              tone={margin < 0 ? "rose" : "emerald"}
            />
          </div>
          <p className="mt-2 text-[11.5px] text-ink-3">
            Маржа пересчитывается вживую при изменении смен, часов или состава команды.
            После создания проекта суммы уйдут в дашборд.
          </p>
        </section>

        {/* ═══════════════════════════════ Sticky action bar ═══════════════ */}
        <div className="sticky bottom-0 inset-x-0 px-4 py-3 bg-surface border-t border-border flex items-center gap-2">
          <Link
            href="/gaffer/projects"
            className="flex-1 text-center px-4 py-2.5 border border-border rounded text-[13.5px] text-ink hover:bg-[#fafafa]"
          >
            Отмена
          </Link>
          <button
            type="submit"
            disabled={loading || !canSubmit}
            className="flex-1 bg-accent-bright hover:bg-accent text-white font-medium rounded px-4 py-2.5 text-[13.5px] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? "Создаём…" : "Создать проект"}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function GafferNewProjectPage() {
  return (
    <Suspense
      fallback={
        <div className="p-4 space-y-3 animate-pulse">
          <div className="h-5 bg-border rounded w-1/2" />
          <div className="h-4 bg-border rounded w-1/3" />
        </div>
      }
    >
      <GafferNewProjectContent />
    </Suspense>
  );
}
