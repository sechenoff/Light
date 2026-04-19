"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  getProject,
  updateProject,
  archiveProject,
  unarchiveProject,
  deleteProject,
  addProjectMember,
  updateProjectMember,
  removeProjectMember,
  createPayment,
  updatePayment,
  deletePayment,
  createContact,
  deleteContact,
  listContacts,
  listContactsWithAggregates,
  listPaymentMethods,
  GafferApiError,
  type GafferProject,
  type GafferProjectMember,
  type GafferPayment,
  type GafferContact,
  type GafferContactWithAggregates,
  type GafferPaymentMethod,
} from "../../../../src/lib/gafferApi";
import { formatRub, pluralize } from "../../../../src/lib/format";
import { formatShootDate } from "../../../../src/lib/gafferProjectUtils";
import { toast } from "../../../../src/components/ToastProvider";
import {
  ROLE_OPTIONS,
  calcMemberCost,
  deriveOtRates,
  WizardStep,
  Pill,
  HoursSlider,
  SummaryRow,
  type SelectedMember,
} from "../../../../src/components/gaffer/projectWizardShared";
import { MemberNumberField } from "../../../../src/components/gaffer/MemberNumberField";

// ── Status pill ─────────────────────────────────────────────────────────────

function StatusPillComp({ status }: { status: "OPEN" | "ARCHIVED" }) {
  if (status === "OPEN") {
    return (
      <span className="inline-flex items-center rounded-full border px-[8px] py-[2px] text-[10.5px] font-semibold bg-amber-soft text-amber border-amber-border uppercase tracking-[0.08em]"
        style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}>
        открыт
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full border px-[8px] py-[2px] text-[10.5px] font-semibold bg-slate-soft text-slate border-slate-border uppercase tracking-[0.08em]"
      style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}>
      в архиве
    </span>
  );
}

// ── Payment form ─────────────────────────────────────────────────────────────

interface PaymentFormData {
  amount: string;
  paidAt: string;
  paymentMethodId: string;
  comment: string;
}

function emptyPaymentForm(): PaymentFormData {
  const today = new Date().toISOString().slice(0, 10);
  return { amount: "", paidAt: today, paymentMethodId: "", comment: "" };
}

interface PaymentFormProps {
  direction: "IN" | "OUT";
  projectId: string;
  memberId?: string;
  methods: GafferPaymentMethod[];
  isArchived?: boolean;
  onDone: () => void;
  onCancel: () => void;
}

function PaymentForm({ direction, projectId, memberId, methods, isArchived, onDone, onCancel }: PaymentFormProps) {
  const [form, setForm] = useState<PaymentFormData>(emptyPaymentForm);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const detailsRef = useRef<HTMLDetailsElement>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.amount || Number(form.amount) <= 0) {
      setErr("Введите сумму");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await createPayment({
        projectId,
        direction,
        amount: form.amount,
        paidAt: form.paidAt,
        paymentMethodId: form.paymentMethodId || undefined,
        memberId: memberId || undefined,
        comment: form.comment.trim() || undefined,
      });
      setForm(emptyPaymentForm());
      detailsRef.current?.removeAttribute("open");
      onDone();
    } catch (e) {
      if (e instanceof GafferApiError) {
        if (e.code === "INVALID_AMOUNT") setErr("Некорректная сумма");
        else if (e.code === "PROJECT_ARCHIVED") setErr("Проект в архиве — изменения недоступны");
        else if (e.code === "MEMBER_REQUIRED_FOR_OUT") setErr("Укажите участника для выплаты");
        else setErr(e.message);
      } else {
        setErr("Не удалось сохранить");
      }
    } finally {
      setSaving(false);
    }
  }

  const summaryLabel = direction === "IN" ? "Новое поступление" : "Новая выплата";

  return (
    <details ref={detailsRef} className="group border border-dashed border-border rounded-md bg-accent-soft overflow-hidden mt-2">
      <summary className="cursor-pointer select-none px-3 py-2 text-[12px] font-semibold text-accent flex items-center gap-1 list-none">
        <span className="text-[14px] leading-none group-open:hidden">+</span>
        <span className="text-[14px] leading-none hidden group-open:inline">−</span>
        {summaryLabel}
      </summary>
      <div className="px-3 pb-3 pt-1 border-t border-dashed border-border">
        <form onSubmit={handleSubmit} className="space-y-2 mt-1">
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="block text-[11px] text-ink-3 mb-0.5">Сумма ₽</label>
              <input
                autoFocus
                type="number"
                min="0.01"
                step="0.01"
                value={form.amount}
                onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                className="w-full px-2 py-1.5 border border-border rounded text-[13px] bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-accent-border"
              />
            </div>
            <div className="flex-1">
              <label className="block text-[11px] text-ink-3 mb-0.5">Дата</label>
              <input
                type="date"
                value={form.paidAt}
                onChange={(e) => setForm((f) => ({ ...f, paidAt: e.target.value }))}
                className="w-full px-2 py-1.5 border border-border rounded text-[13px] bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-accent-border"
              />
            </div>
          </div>
          {methods.length > 0 && (
            <div>
              <label className="block text-[11px] text-ink-3 mb-1">Способ оплаты</label>
              <div className="flex flex-wrap gap-1.5">
                {methods.map((m) => {
                  const active = form.paymentMethodId === m.id;
                  return (
                    <label
                      key={m.id}
                      className={`cursor-pointer px-2.5 py-1 rounded-full border text-[11px] font-semibold transition ${active ? "bg-accent-bright text-white border-accent-bright" : "bg-surface text-ink-2 border-border hover:border-accent"}`}
                    >
                      <input
                        type="radio"
                        className="sr-only"
                        name={`pay-method-${direction}-${projectId}`}
                        checked={active}
                        onChange={() => setForm((f) => ({ ...f, paymentMethodId: m.id }))}
                      />
                      {m.name}
                    </label>
                  );
                })}
                <label
                  className={`cursor-pointer px-2.5 py-1 rounded-full border text-[11px] font-semibold transition ${form.paymentMethodId === "" ? "bg-accent-bright text-white border-accent-bright" : "bg-surface text-ink-2 border-border hover:border-accent"}`}
                >
                  <input
                    type="radio"
                    className="sr-only"
                    name={`pay-method-${direction}-${projectId}`}
                    checked={form.paymentMethodId === ""}
                    onChange={() => setForm((f) => ({ ...f, paymentMethodId: "" }))}
                  />
                  — не указан —
                </label>
              </div>
            </div>
          )}
          <div>
            <label className="block text-[11px] text-ink-3 mb-0.5">Комментарий</label>
            <input
              type="text"
              value={form.comment}
              onChange={(e) => setForm((f) => ({ ...f, comment: e.target.value }))}
              placeholder="Необязательно"
              className="w-full px-2 py-1.5 border border-border rounded text-[13px] bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-accent-border"
            />
          </div>
          {err && <p className="text-rose text-[11.5px]">{err}</p>}
          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              disabled={saving || isArchived}
              className="flex-1 bg-accent-bright hover:bg-accent text-white text-[12.5px] font-medium rounded px-3 py-2 transition-colors disabled:opacity-50"
            >
              {saving ? "Сохраняем…" : "Добавить"}
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 bg-surface border border-border text-ink text-[12.5px] rounded px-3 py-2 hover:bg-[#fafafa] transition-colors"
            >
              Отмена
            </button>
          </div>
        </form>
      </div>
    </details>
  );
}

// ── Payment row (feed-row layout) ─────────────────────────────────────────────

function PaymentRow({
  payment,
  methods,
  onDelete,
  onUpdate,
}: {
  payment: GafferPayment;
  methods: GafferPaymentMethod[];
  onDelete: (id: string) => void;
  onUpdate: () => void;
}) {
  const [showEditForm, setShowEditForm] = useState(false);
  const [editAmount, setEditAmount] = useState("");
  const [editPaidAt, setEditPaidAt] = useState("");
  const [editMethodId, setEditMethodId] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);
  const methodName = methods.find((m) => m.id === payment.paymentMethodId)?.name;
  const isIN = payment.direction === "IN";

  function startEdit() {
    setEditAmount(String(Number(payment.amount)));
    setEditPaidAt(payment.paidAt?.slice(0, 10) ?? new Date().toISOString().slice(0, 10));
    setEditMethodId(payment.paymentMethodId ?? "");
    setEditNote(payment.comment ?? "");
    setEditErr(null);
    setShowEditForm(true);
  }

  async function handleEditSave(e: React.FormEvent) {
    e.preventDefault();
    if (!editAmount || Number(editAmount) <= 0) {
      setEditErr("Введите сумму");
      return;
    }
    setEditSaving(true);
    setEditErr(null);
    try {
      await updatePayment(payment.id, {
        amount: editAmount,
        paidAt: editPaidAt,
        paymentMethodId: editMethodId || undefined,
        comment: editNote.trim() || undefined,
      });
      toast.success("Платёж обновлён");
      setShowEditForm(false);
      onUpdate();
    } catch (e) {
      if (e instanceof GafferApiError) {
        if (e.code === "PROJECT_ARCHIVED") setEditErr("Проект в архиве — изменения недоступны");
        else setEditErr(e.message);
      } else {
        setEditErr("Не удалось сохранить");
      }
    } finally {
      setEditSaving(false);
    }
  }

  return (
    <div className="border-b border-border last:border-b-0">
      {/* feed-row */}
      <div className="grid grid-cols-[auto_1fr_auto] gap-3 items-center py-2">
        <span className={`h-2 w-2 rounded-full shrink-0 ${isIN ? "bg-emerald" : "bg-rose"}`} />
        <div className="min-w-0">
          <span className={`text-[13px] font-semibold mono-num ${isIN ? "text-emerald" : "text-rose"}`}>
            {isIN ? "+" : "−"}{formatRub(payment.amount)}
          </span>
          <div className="text-[11px] text-ink-3 truncate">
            {formatShootDate(payment.paidAt)}
            {methodName && ` · ${methodName}`}
            {payment.comment && ` · ${payment.comment}`}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={startEdit}
            className="w-7 h-7 flex items-center justify-center text-ink-3 hover:text-ink rounded text-[14px]"
            aria-label="Редактировать платёж"
          >
            ✎
          </button>
          <button
            onClick={() => onDelete(payment.id)}
            className="w-7 h-7 flex items-center justify-center text-ink-3 hover:text-rose rounded text-[14px]"
            aria-label="Удалить платёж"
          >
            ×
          </button>
        </div>
      </div>
      {showEditForm && (
        <form onSubmit={handleEditSave} className="bg-[#fafafa] border border-border rounded p-3 mb-2 space-y-2">
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="block text-[11px] text-ink-3 mb-0.5">Сумма ₽</label>
              <input
                autoFocus
                type="number"
                min="0.01"
                step="0.01"
                value={editAmount}
                onChange={(e) => setEditAmount(e.target.value)}
                className="w-full px-2 py-1.5 border border-border rounded text-[13px] bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-accent-border"
              />
            </div>
            <div className="flex-1">
              <label className="block text-[11px] text-ink-3 mb-0.5">Дата</label>
              <input
                type="date"
                value={editPaidAt}
                onChange={(e) => setEditPaidAt(e.target.value)}
                className="w-full px-2 py-1.5 border border-border rounded text-[13px] bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-accent-border"
              />
            </div>
          </div>
          {methods.length > 0 && (
            <div>
              <label className="block text-[11px] text-ink-3 mb-0.5">Способ оплаты</label>
              <select
                value={editMethodId}
                onChange={(e) => setEditMethodId(e.target.value)}
                className="w-full px-2 py-1.5 border border-border rounded text-[13px] bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-accent-border"
              >
                <option value="">— не указан —</option>
                {methods.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="block text-[11px] text-ink-3 mb-0.5">Комментарий</label>
            <input
              type="text"
              value={editNote}
              onChange={(e) => setEditNote(e.target.value)}
              placeholder="Необязательно"
              className="w-full px-2 py-1.5 border border-border rounded text-[13px] bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-accent-border"
            />
          </div>
          {editErr && <p className="text-rose text-[11.5px]">{editErr}</p>}
          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              disabled={editSaving}
              className="flex-1 bg-accent-bright hover:bg-accent text-white text-[12.5px] font-medium rounded px-3 py-2 transition-colors disabled:opacity-50"
            >
              {editSaving ? "Сохраняем…" : "Сохранить"}
            </button>
            <button
              type="button"
              onClick={() => setShowEditForm(false)}
              className="flex-1 bg-surface border border-border text-ink text-[12.5px] rounded px-3 py-2 hover:bg-[#fafafa] transition-colors"
            >
              Отмена
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// ── Member row ────────────────────────────────────────────────────────────────

function MemberRow({
  member,
  methods,
  projectId,
  isArchived,
  onUpdate,
}: {
  member: GafferProjectMember;
  methods: GafferPaymentMethod[];
  projectId: string;
  isArchived?: boolean;
  onUpdate: () => void;
}) {
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [showEditForm, setShowEditForm] = useState(false);
  const [editPlannedAmount, setEditPlannedAmount] = useState("");
  const [editRoleLabel, setEditRoleLabel] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  function startEdit() {
    setEditPlannedAmount(String(Number(member.plannedAmount ?? 0)));
    setEditRoleLabel(member.roleLabel ?? "");
    setEditErr(null);
    setShowEditForm(true);
    setMenuOpen(false);
  }

  async function handleEditSave(e: React.FormEvent) {
    e.preventDefault();
    if (!editPlannedAmount || Number(editPlannedAmount) < 0) {
      setEditErr("Введите корректную сумму");
      return;
    }
    setEditSaving(true);
    setEditErr(null);
    try {
      await updateProjectMember(member.id, {
        plannedAmount: editPlannedAmount,
        roleLabel: editRoleLabel.trim() || undefined,
      });
      toast.success("Участник обновлён");
      setShowEditForm(false);
      onUpdate();
    } catch (e) {
      if (e instanceof GafferApiError) {
        if (e.code === "PROJECT_ARCHIVED") setEditErr("Проект в архиве — изменения недоступны");
        else setEditErr(e.message);
      } else {
        setEditErr("Не удалось сохранить");
      }
    } finally {
      setEditSaving(false);
    }
  }

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    if (menuOpen) document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [menuOpen]);

  async function handleDelete() {
    setDeleting(true);
    try {
      await removeProjectMember(member.id);
      toast.success("Участник удалён");
      onUpdate();
    } catch (e) {
      if (e instanceof GafferApiError && e.code === "MEMBER_HAS_PAYMENTS") {
        toast.error("Сначала удалите платежи участника");
      } else {
        toast.error("Не удалось удалить участника");
      }
    } finally {
      setDeleting(false);
      setShowDeleteModal(false);
    }
  }

  const remaining = Number(member.remaining ?? 0);
  const plannedAmt = Number(member.plannedAmount ?? 0);
  const paidAmt = Number(member.paidToMe ?? 0);
  const isClosed = plannedAmt > 0 && remaining === 0;
  const pct = plannedAmt > 0 ? Math.min(100, Math.round(paidAmt / plannedAmt * 100)) : 0;

  return (
    <div className="border-b border-border last:border-0 py-2.5">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          {/* Name + role */}
          <div className="flex items-baseline gap-1.5 flex-wrap">
            <span className="text-[13px] font-semibold text-ink">
              {member.contact?.name ?? "—"}
            </span>
            {member.roleLabel && (
              <span className="text-[11px] text-ink-3">{member.roleLabel}</span>
            )}
          </div>
          {/* Progress text */}
          <div className="text-[11.5px] text-ink-2 mt-0.5">
            <b className={isClosed ? "text-emerald" : "text-ink"}>{formatRub(paidAmt)}</b>
            {" / "}{formatRub(plannedAmt)}
            {isClosed && <span className="ml-1 text-emerald">· закрыт</span>}
            {!isClosed && remaining > 0 && (
              <span className="ml-1 text-amber">· ост. <b>{formatRub(remaining)}</b></span>
            )}
          </div>
          {/* Progress bar */}
          <div className="h-1.5 rounded-full bg-slate-soft overflow-hidden mt-1">
            <div
              className="h-full bg-emerald transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0 mt-0.5">
          {isClosed ? (
            <span className="inline-flex items-center rounded-full border px-[8px] py-[2px] text-[10.5px] font-semibold bg-emerald-soft text-emerald border-emerald-border"
              style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}>
              оплачено
            </span>
          ) : (
            <button
              onClick={() => setShowPaymentForm((v) => !v)}
              className="text-[11.5px] text-accent-bright hover:text-accent border border-accent-border rounded px-2 py-1 transition-colors"
            >
              + выплата
            </button>
          )}
          <button
            onClick={startEdit}
            className="w-7 h-7 flex items-center justify-center text-ink-3 hover:text-ink rounded text-[14px]"
            aria-label="Редактировать участника"
          >
            ✎
          </button>
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="w-7 h-7 flex items-center justify-center text-ink-3 hover:text-ink rounded text-[16px]"
              aria-label="Действия с участником"
            >
              ⋯
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-8 bg-surface border border-border rounded-lg shadow-sm z-20 w-40 py-1">
                <button
                  onClick={() => { setMenuOpen(false); setShowDeleteModal(true); }}
                  className="w-full text-left px-4 py-2.5 text-[12.5px] text-rose hover:bg-rose-soft transition-colors"
                >
                  Удалить
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {showEditForm && (
        <form onSubmit={handleEditSave} className="bg-[#fafafa] border border-border rounded p-3 mt-2 space-y-2">
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="block text-[11px] text-ink-3 mb-0.5">Роль</label>
              <input
                autoFocus
                type="text"
                value={editRoleLabel}
                onChange={(e) => setEditRoleLabel(e.target.value)}
                placeholder="Оператор, АС…"
                className="w-full px-2 py-1.5 border border-border rounded text-[13px] bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-accent-border"
              />
            </div>
            <div className="flex-1">
              <label className="block text-[11px] text-ink-3 mb-0.5">Сумма ₽</label>
              <input
                type="number"
                min="0"
                step="1"
                value={editPlannedAmount}
                onChange={(e) => setEditPlannedAmount(e.target.value)}
                className="w-full px-2 py-1.5 border border-border rounded text-[13px] bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-accent-border"
              />
            </div>
          </div>
          {editErr && <p className="text-rose text-[11.5px]">{editErr}</p>}
          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              disabled={editSaving}
              className="flex-1 bg-accent-bright hover:bg-accent text-white text-[12.5px] font-medium rounded px-3 py-2 transition-colors disabled:opacity-50"
            >
              {editSaving ? "Сохраняем…" : "Сохранить"}
            </button>
            <button
              type="button"
              onClick={() => setShowEditForm(false)}
              className="flex-1 bg-surface border border-border text-ink text-[12.5px] rounded px-3 py-2 hover:bg-[#fafafa] transition-colors"
            >
              Отмена
            </button>
          </div>
        </form>
      )}

      {showPaymentForm && (
        <PaymentForm
          direction="OUT"
          projectId={projectId}
          memberId={member.contactId}
          methods={methods}
          isArchived={isArchived}
          onDone={() => { setShowPaymentForm(false); onUpdate(); }}
          onCancel={() => setShowPaymentForm(false)}
        />
      )}

      {/* Delete confirm modal */}
      {showDeleteModal && (
        <div
          className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowDeleteModal(false); }}
        >
          <div className="bg-surface rounded-lg shadow-xl p-5 w-full max-w-sm">
            <h3 className="text-[15px] font-semibold text-ink mb-2">Удалить участника?</h3>
            <p className="text-[13px] text-ink-2 mb-5">
              Удалить <span className="font-medium text-ink">{member.contact?.name}</span> из проекта?
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="flex-1 bg-rose hover:bg-rose/90 text-white font-medium rounded px-4 py-2.5 text-[13px] disabled:opacity-50 transition-colors"
              >
                {deleting ? "Удаляем…" : "Удалить"}
              </button>
              <button
                onClick={() => setShowDeleteModal(false)}
                className="flex-1 bg-surface border border-border text-ink rounded px-4 py-2.5 text-[13px] hover:bg-[#fafafa] transition-colors"
              >
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Add member form ────────────────────────────────────────────────────────────

function AddMemberForm({
  projectId,
  methods,
  isArchived,
  contactType,
  onDone,
  onCancel,
}: {
  projectId: string;
  methods: GafferPaymentMethod[];
  isArchived?: boolean;
  contactType: "TEAM_MEMBER" | "VENDOR";
  onDone: () => void;
  onCancel: () => void;
}) {
  const [contacts, setContacts] = useState<GafferContact[] | null>(null);
  const [contactId, setContactId] = useState("");
  const [plannedAmount, setPlannedAmount] = useState("0");
  const [roleLabel, setRoleLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const detailsRef = useRef<HTMLDetailsElement>(null);

  const isVendor = contactType === "VENDOR";

  // Vendor-only: mode toggle between picking existing vs creating a new rental inline.
  // Team members have their own rate-rich creation flow in the wizard, so not duplicated here.
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newTelegram, setNewTelegram] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await listContacts({ type: contactType, isArchived: false });
        if (!cancelled) setContacts(res.items);
      } catch {
        if (!cancelled) setContacts([]);
      }
    })();
    return () => { cancelled = true; };
  }, [contactType]);

  // Suppress unused variable warning — methods prop reserved for future payment integration
  void methods;

  function resetAll() {
    setContactId("");
    setPlannedAmount("0");
    setRoleLabel("");
    setNewName("");
    setNewPhone("");
    setNewTelegram("");
    setMode("existing");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);

    // Mode B — create a new rental first, then add it to the project.
    // Reuse an existing VENDOR if the trimmed name already matches one in the
    // already-loaded list — contactService does not enforce name uniqueness,
    // so without this check we'd create duplicates every time the user retries.
    if (isVendor && mode === "new") {
      const trimmedName = newName.trim();
      if (!trimmedName) {
        setErr("Введите название рентала");
        return;
      }
      setSaving(true);
      const existing = (contacts ?? []).find(
        (c) => c.name.trim().toLowerCase() === trimmedName.toLowerCase(),
      );
      let createdId: string | null = null;
      try {
        let targetContactId: string;
        if (existing) {
          targetContactId = existing.id;
        } else {
          const created = await createContact({
            type: "VENDOR",
            name: trimmedName,
            phone: newPhone.trim() || undefined,
            telegram: newTelegram.trim() || undefined,
          });
          createdId = created.contact.id;
          targetContactId = createdId;
        }
        await addProjectMember(projectId, {
          contactId: targetContactId,
          plannedAmount: plannedAmount || "0",
        });
        resetAll();
        detailsRef.current?.removeAttribute("open");
        onDone();
      } catch (e) {
        // Best-effort cleanup: if addProjectMember failed AFTER we created a
        // fresh VENDOR, roll it back so we don't pollute the contact list.
        // Fire-and-forget — user-facing error takes priority over cleanup result.
        if (createdId) {
          deleteContact(createdId).catch(() => {
            /* ignore — orphan is better than blocking the user on a second error */
          });
        }
        if (e instanceof GafferApiError) {
          if (e.code === "MEMBER_ALREADY_IN_PROJECT") setErr("Рентал уже добавлен в проект");
          else if (e.code === "MEMBER_ARCHIVED") setErr("Этот контакт в архиве");
          else if (e.code === "INVALID_MEMBER_TYPE") setErr("Контакт не является ренталом");
          else if (e.code === "PROJECT_ARCHIVED") setErr("Проект в архиве — изменения недоступны");
          else setErr(e.message);
        } else {
          setErr("Не удалось создать рентал");
        }
      } finally {
        setSaving(false);
      }
      return;
    }

    // Mode A — pick an existing contact.
    if (!contactId) { setErr(isVendor ? "Выберите рентал" : "Выберите участника"); return; }
    setSaving(true);
    try {
      await addProjectMember(projectId, {
        contactId: contactId,
        plannedAmount: plannedAmount || "0",
        roleLabel: roleLabel.trim() || undefined,
      });
      resetAll();
      detailsRef.current?.removeAttribute("open");
      onDone();
    } catch (e) {
      if (e instanceof GafferApiError) {
        if (e.code === "MEMBER_ALREADY_IN_PROJECT") setErr(isVendor ? "Рентал уже добавлен в проект" : "Участник уже в проекте");
        else if (e.code === "MEMBER_ARCHIVED") setErr("Этот контакт в архиве");
        else if (e.code === "INVALID_MEMBER_TYPE") setErr(isVendor ? "Контакт не является ренталом" : "Контакт должен быть типа «Команда»");
        else if (e.code === "PROJECT_ARCHIVED") setErr("Проект в архиве — изменения недоступны");
        else setErr(e.message);
      } else {
        setErr("Не удалось добавить");
      }
    } finally {
      setSaving(false);
    }
  }

  const summaryLabel = isVendor ? "Добавить рентал" : "Добавить участника";
  const selectLabel = isVendor ? "Рентал" : "Участник";

  // Tab button helpers
  function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={
          "flex-1 text-[11.5px] font-semibold rounded px-2 py-1.5 transition-colors " +
          (active
            ? "bg-accent text-white"
            : "bg-transparent text-ink-2 hover:bg-surface")
        }
      >
        {children}
      </button>
    );
  }

  return (
    <details ref={detailsRef} className="group border border-dashed border-border rounded-md bg-accent-soft overflow-hidden mt-2">
      <summary className="cursor-pointer select-none px-3 py-2 text-[12px] font-semibold text-accent flex items-center gap-1 list-none">
        <span className="text-[14px] leading-none group-open:hidden">+</span>
        <span className="text-[14px] leading-none hidden group-open:inline">−</span>
        {summaryLabel}
      </summary>
      <div className="px-3 pb-3 pt-1 border-t border-dashed border-border">
        {isVendor && (
          <div className="flex gap-1 bg-surface border border-border rounded p-0.5 mt-2">
            <TabBtn active={mode === "existing"} onClick={() => { setMode("existing"); setErr(null); }}>
              Из списка
            </TabBtn>
            <TabBtn active={mode === "new"} onClick={() => { setMode("new"); setErr(null); }}>
              + Новый рентал
            </TabBtn>
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-2 mt-2">
          {/* MODE A — existing contact */}
          {(!isVendor || mode === "existing") && (
            <div>
              <label className="block text-[11px] text-ink-3 mb-0.5">{selectLabel}</label>
              {contacts === null ? (
                <div className="h-[34px] bg-border rounded animate-pulse" />
              ) : contacts.length === 0 && isVendor ? (
                <p className="text-[12px] text-ink-2 px-2 py-2 bg-surface border border-border rounded">
                  Ренталов ещё нет. Переключитесь на{" "}
                  <button
                    type="button"
                    onClick={() => setMode("new")}
                    className="text-accent-bright font-semibold underline"
                  >
                    «+ Новый рентал»
                  </button>.
                </p>
              ) : (
                <select
                  value={contactId}
                  onChange={(e) => setContactId(e.target.value)}
                  autoFocus
                  className="w-full px-2 py-1.5 border border-border rounded text-[13px] bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-accent-border"
                >
                  <option value="">— Выберите —</option>
                  {contacts.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              )}
            </div>
          )}

          {/* MODE B — create a new rental inline (VENDOR only) */}
          {isVendor && mode === "new" && (
            <div className="space-y-2">
              <div>
                <label className="block text-[11px] text-ink-3 mb-0.5">Название рентала *</label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  autoFocus
                  placeholder="напр. SvetoBaza"
                  className="w-full px-2 py-1.5 border border-border rounded text-[13px] bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-accent-border"
                />
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="block text-[11px] text-ink-3 mb-0.5">Телефон</label>
                  <input
                    type="tel"
                    value={newPhone}
                    onChange={(e) => setNewPhone(e.target.value)}
                    placeholder="+7 999 ..."
                    className="w-full px-2 py-1.5 border border-border rounded text-[13px] bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-accent-border"
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-[11px] text-ink-3 mb-0.5">Телеграм</label>
                  <input
                    type="text"
                    value={newTelegram}
                    onChange={(e) => setNewTelegram(e.target.value)}
                    placeholder="@handle"
                    className="w-full px-2 py-1.5 border border-border rounded text-[13px] bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-accent-border"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Shared row — role (only for team member) + planned amount */}
          <div className="flex gap-2">
            {!isVendor && (
              <div className="flex-1">
                <label className="block text-[11px] text-ink-3 mb-0.5">Роль</label>
                <input
                  type="text"
                  value={roleLabel}
                  onChange={(e) => setRoleLabel(e.target.value)}
                  placeholder="Оператор, АС…"
                  className="w-full px-2 py-1.5 border border-border rounded text-[13px] bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-accent-border"
                />
              </div>
            )}
            <div className="flex-1">
              <label className="block text-[11px] text-ink-3 mb-0.5">Сумма ₽</label>
              <input
                type="number"
                min="0"
                step="1"
                value={plannedAmount}
                onChange={(e) => setPlannedAmount(e.target.value)}
                className="w-full px-2 py-1.5 border border-border rounded text-[13px] bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-accent-border"
              />
            </div>
          </div>
          {err && <p className="text-rose text-[11.5px]">{err}</p>}
          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              disabled={saving || isArchived}
              className="flex-1 bg-accent-bright hover:bg-accent text-white text-[12.5px] font-medium rounded px-3 py-2 transition-colors disabled:opacity-50"
            >
              {saving
                ? (isVendor && mode === "new" ? "Создаём…" : "Добавляем…")
                : (isVendor && mode === "new" ? "Создать и добавить" : "Добавить")}
            </button>
            <button type="button" onClick={() => { resetAll(); onCancel(); }}
              className="flex-1 bg-surface border border-border text-ink text-[12.5px] rounded px-3 py-2 hover:bg-[#fafafa] transition-colors">
              Отмена
            </button>
          </div>
        </form>
      </div>
    </details>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

function GafferProjectDetailContent() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [project, setProject] = useState<GafferProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [methods, setMethods] = useState<GafferPaymentMethod[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  // Edit mode — full wizard mirror
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editClientId, setEditClientId] = useState("");
  const [editShootDate, setEditShootDate] = useState("");
  const [editClientPlan, setEditClientPlan] = useState("0");
  const [editLightBudget, setEditLightBudget] = useState("0");
  const [editNote, setEditNote] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editErrors, setEditErrors] = useState<Record<string, string>>({});

  // Team picker state
  const [editClients, setEditClients] = useState<GafferContactWithAggregates[] | null>(null);
  const [editTeamContacts, setEditTeamContacts] = useState<GafferContact[] | null>(null);
  const [editSelectedMembers, setEditSelectedMembers] = useState<SelectedMember[]>([]);
  const [editLockedContactIds, setEditLockedContactIds] = useState<Set<string>>(new Set());
  const [editBulkShifts, setEditBulkShifts] = useState<number | null>(1);
  const [editBulkHours, setEditBulkHours] = useState<number | null>(10);
  const [editAddMemberOpen, setEditAddMemberOpen] = useState(false);
  const [editNewMemberName, setEditNewMemberName] = useState("");
  const [editNewMemberRole, setEditNewMemberRole] = useState<string>(ROLE_OPTIONS[0]);
  const [editNewMemberShiftRate, setEditNewMemberShiftRate] = useState("");
  const [editNewMemberContact, setEditNewMemberContact] = useState("");
  const [editSavingMember, setEditSavingMember] = useState(false);

  // Forms — now handled by <details> elements (always-available)

  // Menu
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Modals
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [projRes, methodsRes] = await Promise.all([
          getProject(id),
          listPaymentMethods().catch(() => ({ items: [] })),
        ]);
        if (!cancelled) {
          setProject(projRes.project);
          setMethods(methodsRes.items);
        }
      } catch (e) {
        if (!cancelled) {
          if (e instanceof GafferApiError && e.status === 404) setNotFound(true);
          else setNotFound(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id, refreshKey]);

  // Read crewAmount from URL (returned from crew calculator) — restore draft + prefill editClientPlan
  useEffect(() => {
    const crewAmount = searchParams.get("crewAmount");
    const editMode = searchParams.get("edit");
    if (editMode === "1" && project) {
      const draftKey = `gaffer:projects-edit:${id}:draft`;
      const raw = sessionStorage.getItem(draftKey);
      seedEditFromProject(project);
      if (raw) {
        try {
          const draft = JSON.parse(raw);
          if (draft.editTitle !== undefined) setEditTitle(draft.editTitle);
          if (draft.editClientId !== undefined) setEditClientId(draft.editClientId);
          if (draft.editShootDate !== undefined) setEditShootDate(draft.editShootDate);
          if (draft.editLightBudget !== undefined) setEditLightBudget(draft.editLightBudget);
          if (draft.editNote !== undefined) setEditNote(draft.editNote);
          setEditClientPlan(crewAmount ? crewAmount : (draft.editClientPlan ?? project.clientPlanAmount ?? "0"));
        } catch {
          if (crewAmount) setEditClientPlan(crewAmount);
        }
        sessionStorage.removeItem(draftKey);
      } else if (crewAmount) {
        setEditClientPlan(crewAmount);
      }
      setEditing(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, project]);

  // ── Load clients + team contacts when entering edit mode ──
  useEffect(() => {
    if (!editing) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await listContactsWithAggregates({ type: "CLIENT", isArchived: false });
        if (!cancelled) setEditClients(res.items);
      } catch {
        if (!cancelled) setEditClients([]);
      }
    })();
    (async () => {
      try {
        const res = await listContacts({ type: "TEAM_MEMBER", isArchived: false });
        if (!cancelled) setEditTeamContacts(res.items);
      } catch {
        if (!cancelled) setEditTeamContacts([]);
      }
    })();
    return () => { cancelled = true; };
  }, [editing]);

  function seedEditFromProject(p: GafferProject) {
    setEditTitle(p.title);
    setEditClientId(p.clientId ?? "");
    setEditShootDate(p.shootDate?.slice(0, 10) ?? "");
    setEditClientPlan(p.clientPlanAmount ?? "0");
    setEditLightBudget(p.lightBudgetAmount ?? "0");
    setEditNote(p.note ?? "");

    // Seed selected members from current TEAM_MEMBER rows; default shifts=1, hours=10
    const teamRows = (p.members ?? []).filter((m) => m.contact?.type === "TEAM_MEMBER");
    const seeded: SelectedMember[] = teamRows.map((m) => ({
      memberId: m.id,
      contactId: m.contactId,
      shifts: 1,
      hours: 10,
      plannedAmount: Number(m.plannedAmount ?? 0),
    }));
    setEditSelectedMembers(seeded);

    // Locked = members with any outgoing payments (paidToMe > 0)
    const locked = new Set<string>();
    for (const m of teamRows) {
      if (Number(m.paidToMe ?? 0) > 0) locked.add(m.contactId);
    }
    setEditLockedContactIds(locked);

    setEditBulkShifts(1);
    setEditBulkHours(10);
    setEditErrors({});
  }

  // Start editing
  function startEdit() {
    if (!project) return;
    seedEditFromProject(project);
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setEditAddMemberOpen(false);
    setEditErrors({});
  }

  // ── Team pill toggle ──
  function editToggleMember(contactId: string) {
    if (editLockedContactIds.has(contactId)) {
      const isSelected = editSelectedMembers.some((m) => m.contactId === contactId);
      if (isSelected) {
        toast.error("Нельзя убрать — у участника есть выплаты по проекту");
        return;
      }
    }
    setEditSelectedMembers((prev) => {
      if (prev.some((m) => m.contactId === contactId)) {
        return prev.filter((m) => m.contactId !== contactId);
      }
      const contact = editTeamContacts?.find((c) => c.id === contactId);
      if (!contact) return prev;
      const shifts = editBulkShifts ?? 1;
      const hours = editBulkHours ?? 10;
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

  function editRecomputeMember(m: SelectedMember): SelectedMember {
    const contact = editTeamContacts?.find((c) => c.id === m.contactId);
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

  function editApplyBulkShifts(n: number) {
    setEditBulkShifts(n);
    setEditSelectedMembers((prev) => prev.map((m) => editRecomputeMember({ ...m, shifts: n })));
  }

  function editApplyBulkHours(n: number) {
    setEditBulkHours(n);
    setEditSelectedMembers((prev) => prev.map((m) => editRecomputeMember({ ...m, hours: n })));
  }

  function editUpdateMemberField(
    contactId: string,
    field: "shifts" | "hours",
    value: number,
  ) {
    setEditSelectedMembers((prev) =>
      prev.map((m) => {
        if (m.contactId !== contactId) return m;
        return editRecomputeMember({ ...m, [field]: value });
      }),
    );
    if (field === "shifts") setEditBulkShifts(null);
    if (field === "hours") setEditBulkHours(null);
  }

  async function handleEditCreateMember(e: React.FormEvent) {
    e.preventDefault();
    if (!editNewMemberName.trim() || !editNewMemberShiftRate.trim()) return;
    setEditSavingMember(true);
    try {
      const shiftRate = Number(editNewMemberShiftRate) || 0;
      const otRates = deriveOtRates(shiftRate);
      const contactVal = editNewMemberContact.trim();
      const isTg = contactVal.startsWith("@");
      const res = await createContact({
        type: "TEAM_MEMBER",
        name: editNewMemberName.trim(),
        phone: !isTg && contactVal ? contactVal : undefined,
        telegram: isTg ? contactVal : undefined,
        shiftRate: String(shiftRate),
        overtimeTier1Rate: String(otRates.overtimeTier1Rate),
        overtimeTier2Rate: String(otRates.overtimeTier2Rate),
        overtimeTier3Rate: String(otRates.overtimeTier3Rate),
        roleLabel: editNewMemberRole || null,
      });
      toast.success("Осветитель добавлен");
      setEditTeamContacts((prev) => (prev ? [...prev, res.contact] : [res.contact]));
      const shifts = editBulkShifts ?? 1;
      const hours = editBulkHours ?? 10;
      const { total } = calcMemberCost(
        shiftRate,
        otRates.overtimeTier1Rate,
        otRates.overtimeTier2Rate,
        otRates.overtimeTier3Rate,
        shifts,
        hours,
      );
      setEditSelectedMembers((prev) => [
        ...prev,
        { contactId: res.contact.id, shifts, hours, plannedAmount: total },
      ]);
      setEditNewMemberName("");
      setEditNewMemberRole(ROLE_OPTIONS[0]);
      setEditNewMemberShiftRate("");
      setEditNewMemberContact("");
      setEditAddMemberOpen(false);
    } catch (err) {
      if (err instanceof GafferApiError) toast.error(err.message);
      else toast.error("Не удалось добавить осветителя");
    } finally {
      setEditSavingMember(false);
    }
  }

  async function handleSave() {
    if (!project) return;
    const errs: Record<string, string> = {};
    if (!editTitle.trim()) errs.title = "Укажите название";
    if (!editClientId) errs.clientId = "Выберите заказчика";
    if (!editShootDate) errs.shootDate = "Укажите дату съёмки";
    if (Object.keys(errs).length) {
      setEditErrors(errs);
      return;
    }
    setEditErrors({});
    setEditSaving(true);

    try {
      await updateProject(id, {
        title: editTitle.trim(),
        clientId: editClientId,
        shootDate: editShootDate,
        clientPlanAmount: editClientPlan || "0",
        lightBudgetAmount: editLightBudget || "0",
        note: editNote.trim() || "",
      });

      // ── Team member diff ──
      const existingTeamRows = (project.members ?? []).filter(
        (m) => m.contact?.type === "TEAM_MEMBER",
      );
      const existingByContactId = new Map(existingTeamRows.map((m) => [m.contactId, m]));
      const selectedByContactId = new Map(editSelectedMembers.map((m) => [m.contactId, m]));

      const removalFailures: string[] = [];

      // 1. Remove rows that are no longer selected
      for (const row of existingTeamRows) {
        if (!selectedByContactId.has(row.contactId)) {
          try {
            await removeProjectMember(row.id);
          } catch (e) {
            if (e instanceof GafferApiError && e.code === "MEMBER_HAS_PAYMENTS") {
              removalFailures.push(row.contact?.name ?? "участник");
            } else {
              throw e;
            }
          }
        }
      }

      // 2. Add new selected members
      for (const sel of editSelectedMembers) {
        if (!existingByContactId.has(sel.contactId)) {
          const contact = editTeamContacts?.find((c) => c.id === sel.contactId);
          await addProjectMember(id, {
            contactId: sel.contactId,
            plannedAmount: String(sel.plannedAmount),
            roleLabel: contact?.roleLabel ?? undefined,
          });
        }
      }

      // 3. Update existing rows whose plannedAmount has changed
      for (const sel of editSelectedMembers) {
        const existing = existingByContactId.get(sel.contactId);
        if (!existing) continue;
        const existingAmt = Number(existing.plannedAmount ?? 0);
        if (existingAmt !== sel.plannedAmount) {
          await updateProjectMember(existing.id, {
            plannedAmount: String(sel.plannedAmount),
          });
        }
      }

      setEditing(false);
      setRefreshKey((k) => k + 1);

      if (removalFailures.length > 0) {
        toast.error(
          `Не удалось убрать: ${removalFailures.join(", ")} — есть выплаты по проекту`,
        );
      } else {
        toast.success("Проект обновлён");
      }
    } catch (e) {
      toast.error(e instanceof GafferApiError ? e.message : "Ошибка сохранения");
    } finally {
      setEditSaving(false);
    }
  }

  async function handleArchiveToggle() {
    if (!project) return;
    setMenuOpen(false);
    try {
      const res = project.status === "ARCHIVED"
        ? await unarchiveProject(id)
        : await archiveProject(id);
      setProject(res.project);
      toast.success(res.project.status === "ARCHIVED" ? "Проект в архиве" : "Проект восстановлен");
    } catch (e) {
      toast.error(e instanceof GafferApiError ? e.message : "Ошибка");
    }
  }

  async function handleDelete() {
    setDeleteLoading(true);
    try {
      await deleteProject(id);
      toast.success("Проект удалён");
      router.push("/gaffer/projects");
    } catch (e) {
      toast.error(e instanceof GafferApiError ? e.message : "Ошибка удаления");
    } finally {
      setDeleteLoading(false);
      setShowDeleteModal(false);
    }
  }

  async function handleDeletePayment(paymentId: string) {
    try {
      await deletePayment(paymentId);
      toast.success("Платёж удалён");
      setRefreshKey((k) => k + 1);
    } catch {
      toast.error("Не удалось удалить платёж");
    }
  }

  // Close menu on outside click
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    if (menuOpen) document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [menuOpen]);

  if (loading) {
    return (
      <div className="p-4 space-y-3 animate-pulse">
        <div className="h-5 bg-border rounded w-1/2" />
        <div className="h-4 bg-border rounded w-1/3" />
        <div className="h-4 bg-border rounded w-2/3" />
      </div>
    );
  }

  if (notFound || !project) {
    return (
      <div className="p-6 text-center">
        <p className="text-ink-3 mb-4">Проект не найден</p>
        <Link href="/gaffer/projects" className="text-accent-bright">← Все проекты</Link>
      </div>
    );
  }

  const inPayments = (project.payments ?? []).filter((p) => p.direction === "IN");

  const allMembers = project.members ?? [];
  // Strict type filter — only rows with explicit contact.type to prevent cross-section leakage
  const vendorMembers = allMembers.filter((m) => m.contact?.type === "VENDOR");
  const teamMembersFiltered = allMembers.filter((m) => m.contact?.type === "TEAM_MEMBER");

  // Use server-computed vendor aggregates (avoids double-counting with team totals)
  const vendorPlanTotal = Number(project.vendorPlanTotal ?? 0);
  const vendorPaidTotal = Number(project.vendorPaidTotal ?? 0);
  const vendorRemaining = Number(project.vendorRemaining ?? 0);

  return (
    <div className="min-h-screen bg-surface pb-10">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-border">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            href="/gaffer/projects"
            className="text-accent-bright hover:text-accent transition-colors text-[11px] font-semibold tracking-[1.4px] uppercase shrink-0"
            style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
          >
            ← Проекты
          </Link>
          <StatusPillComp status={project.status} />
        </div>
        <div className="flex items-center gap-2">
          {!editing && (
            <button
              onClick={startEdit}
              className="text-[13px] text-accent-bright hover:text-accent transition-colors font-medium"
            >
              Редактировать
            </button>
          )}
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="w-8 h-8 flex items-center justify-center text-ink-3 hover:text-ink rounded text-[18px]"
              aria-label="Действия с проектом"
            >
              ⋯
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-9 bg-surface border border-border rounded-lg shadow-sm z-20 w-44 py-1">
                <button
                  onClick={handleArchiveToggle}
                  className="w-full text-left px-4 py-2.5 text-[13px] text-ink hover:bg-[#fafafa] transition-colors"
                >
                  {project.status === "ARCHIVED" ? "Из архива" : "В архив"}
                </button>
                <button
                  onClick={() => { setMenuOpen(false); setShowDeleteModal(true); }}
                  className="w-full text-left px-4 py-2.5 text-[13px] text-rose hover:bg-rose-soft transition-colors"
                >
                  Удалить
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Edit form — mirrors the /projects/new wizard */}
      {editing ? (
        (() => {
          const inputClass =
            "w-full px-[11px] py-[9px] border border-border rounded text-[13.5px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright";
          const inputErrorClass =
            "w-full px-[11px] py-[9px] border border-rose-border rounded text-[13.5px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border";
          const sectionClass = "mx-4 mb-4 border border-border rounded bg-surface p-4";

          const teamTotal = editSelectedMembers.reduce((s, m) => s + m.plannedAmount, 0);
          const clientPlan = Number(editClientPlan) || 0;
          const lightBudget = Number(editLightBudget) || 0;
          const margin = clientPlan - lightBudget - teamTotal;
          const totalShifts = editSelectedMembers.reduce((s, m) => s + m.shifts, 0);

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

          return (
            <div className="pb-20">
              {/* ═══════ STEP 1 — Клиент ═══════ */}
              <WizardStep n={1} title="Клиент" subtitle="кто платит за съёмку" />
              <section className={sectionClass}>
                {editClients === null ? (
                  <div className="h-[39px] bg-border rounded animate-pulse" />
                ) : (
                  <select
                    value={editClientId}
                    onChange={(e) => setEditClientId(e.target.value)}
                    className={editErrors.clientId ? inputErrorClass : inputClass}
                  >
                    <option value="">— Выберите заказчика —</option>
                    {editClients.map((c) => (
                      <option key={c.id} value={c.id}>
                        {clientOptionLabel(c)}
                      </option>
                    ))}
                  </select>
                )}
                {editErrors.clientId && (
                  <p className="text-rose text-[11.5px] mt-1">{editErrors.clientId}</p>
                )}
              </section>

              {/* ═══════ STEP 2 — Проект ═══════ */}
              <WizardStep n={2} title="Проект" subtitle="название и дата" />
              <section className={sectionClass}>
                <div className="grid grid-cols-2 gap-2.5">
                  <div>
                    <label className="block text-[11.5px] text-ink-2 mb-0.5">
                      Название <span className="text-rose">*</span>
                    </label>
                    <input
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      maxLength={100}
                      className={editErrors.title ? inputErrorClass : inputClass}
                    />
                    {editErrors.title && (
                      <p className="text-rose text-[11.5px] mt-0.5">{editErrors.title}</p>
                    )}
                  </div>
                  <div>
                    <label className="block text-[11.5px] text-ink-2 mb-0.5">
                      Дата съёмки <span className="text-rose">*</span>
                    </label>
                    <input
                      type="date"
                      value={editShootDate}
                      onChange={(e) => setEditShootDate(e.target.value)}
                      className={editErrors.shootDate ? inputErrorClass : inputClass}
                    />
                    {editErrors.shootDate && (
                      <p className="text-rose text-[11.5px] mt-0.5">{editErrors.shootDate}</p>
                    )}
                  </div>
                </div>
                <div className="mt-2.5">
                  <label className="block text-[11.5px] text-ink-2 mb-0.5">
                    Комментарий (необязательно)
                  </label>
                  <textarea
                    value={editNote}
                    onChange={(e) => setEditNote(e.target.value)}
                    rows={2}
                    className={`${inputClass} resize-none`}
                  />
                </div>
              </section>

              {/* ═══════ STEP 3 — Сумма от клиента ═══════ */}
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
                    value={editClientPlan}
                    onChange={(e) => setEditClientPlan(e.target.value)}
                    className="w-full px-[11px] py-[9px] pr-7 border border-border rounded text-[16px] font-semibold mono-num bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright"
                  />
                  <span className="absolute right-[11px] top-1/2 -translate-y-1/2 text-ink-3 text-[13px]">
                    ₽
                  </span>
                </div>
                <p className="mt-1.5 text-[11.5px] text-ink-3">
                  Это не прибыль — из неё гаффер платит ренталу за свет и команде за смены. Остаток — маржа.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    const draftKey = `gaffer:projects-edit:${id}:draft`;
                    sessionStorage.setItem(
                      draftKey,
                      JSON.stringify({
                        editTitle,
                        editClientId,
                        editShootDate,
                        editClientPlan,
                        editLightBudget,
                        editNote,
                      }),
                    );
                    router.push(
                      `/gaffer/crew-calculator?returnTo=/gaffer/projects/${id}%3Fedit%3D1`,
                    );
                  }}
                  className="mt-2.5 w-full flex items-center justify-center gap-1.5 px-3 py-2 border border-border bg-surface hover:bg-[#fafafa] text-accent-bright text-[12.5px] rounded transition-colors"
                >
                  Калькулятор команды осветителей
                </button>
              </section>

              {/* ═══════ STEP 4 — Аренда света ═══════ */}
              <WizardStep n={4} title="Аренда света" subtitle="сколько посчитали в ренталe" />
              <section className={sectionClass}>
                <label className="block text-[11.5px] text-ink-2 mb-0.5">
                  Сумма от рентала за оборудование
                </label>
                <div className="relative">
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={editLightBudget}
                    onChange={(e) => setEditLightBudget(e.target.value)}
                    placeholder="0"
                    className="w-full px-[11px] py-[9px] pr-7 border border-border rounded text-[16px] font-semibold mono-num bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright"
                  />
                  <span className="absolute right-[11px] top-1/2 -translate-y-1/2 text-ink-3 text-[13px]">
                    ₽
                  </span>
                </div>
                <p className="mt-1.5 text-[11.5px] text-ink-3">
                  Ренталы-участники редактируются ниже, в карточке проекта.
                </p>
              </section>

              {/* ═══════ STEP 5 — Команда ═══════ */}
              <WizardStep n={5} title="Команда" subtitle="кто работает на смене" />
              <section className={sectionClass}>
                {editTeamContacts === null ? (
                  <div className="h-20 bg-border rounded animate-pulse" />
                ) : (
                  <>
                    {/* Team contact grid — clickable pills */}
                    <div className="grid grid-cols-2 gap-2">
                      {editTeamContacts.map((c) => {
                        const isSelected = editSelectedMembers.some((m) => m.contactId === c.id);
                        const isLocked = editLockedContactIds.has(c.id);
                        const cardClass = isSelected
                          ? isLocked
                            ? "border-amber-border bg-amber-soft"
                            : "border-accent-bright bg-accent-soft"
                          : "border-border bg-surface hover:bg-[#fafafa]";
                        return (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => editToggleMember(c.id)}
                            className={`text-left rounded-md p-2.5 border transition-colors ${cardClass}`}
                            title={isLocked ? "У участника есть выплаты — нельзя убрать" : undefined}
                          >
                            <div className="flex items-baseline justify-between gap-2">
                              <div className="text-[13px] font-semibold text-ink">{c.name}</div>
                              {isLocked && (
                                <span className="text-[10.5px] text-amber font-semibold uppercase tracking-wide">
                                  с выплатами
                                </span>
                              )}
                            </div>
                            <div className="text-[11.5px] text-ink-3">{c.roleLabel || "—"}</div>
                            <div className="text-[11.5px] text-ink-2 mono-num">
                              {formatRub(+c.shiftRate)} / смена
                            </div>
                          </button>
                        );
                      })}
                      <button
                        type="button"
                        onClick={() => setEditAddMemberOpen(true)}
                        className="text-[12.5px] text-accent-bright rounded-md border border-dashed border-accent-border bg-surface hover:bg-accent-soft p-2.5 text-left"
                      >
                        + Новый осветитель
                      </button>
                    </div>

                    {/* Inline new member form */}
                    {editAddMemberOpen && (
                      <div className="mt-3 border border-border rounded-md p-3 space-y-2.5 bg-surface">
                        <div className="flex items-center justify-between">
                          <span className="text-[12px] font-semibold text-ink">Новый осветитель</span>
                          <button
                            type="button"
                            onClick={() => setEditAddMemberOpen(false)}
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
                            value={editNewMemberName}
                            onChange={(e) => setEditNewMemberName(e.target.value)}
                            placeholder="Алексей Смирнов"
                            className={inputClass}
                          />
                        </div>
                        <div>
                          <label className="block text-[11.5px] text-ink-2 mb-0.5">Роль</label>
                          <select
                            value={editNewMemberRole}
                            onChange={(e) => setEditNewMemberRole(e.target.value)}
                            className={inputClass}
                          >
                            {ROLE_OPTIONS.map((r) => (
                              <option key={r} value={r}>{r}</option>
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
                              value={editNewMemberShiftRate}
                              onChange={(e) => setEditNewMemberShiftRate(e.target.value)}
                              placeholder="5000"
                              className="w-full px-[11px] py-[9px] pr-7 border border-border rounded text-[13.5px] mono-num bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright"
                            />
                            <span className="absolute right-[11px] top-1/2 -translate-y-1/2 text-ink-3 text-[13px]">
                              ₽
                            </span>
                          </div>
                        </div>
                        <div>
                          <label className="block text-[11.5px] text-ink-2 mb-0.5">
                            Телефон или @telegram
                          </label>
                          <input
                            value={editNewMemberContact}
                            onChange={(e) => setEditNewMemberContact(e.target.value)}
                            placeholder="+7 999 ... или @handle"
                            className={inputClass}
                          />
                        </div>
                        <button
                          type="button"
                          disabled={
                            editSavingMember || !editNewMemberName.trim() || !editNewMemberShiftRate.trim()
                          }
                          onClick={handleEditCreateMember}
                          className="w-full bg-accent-bright hover:bg-accent text-white font-medium rounded px-3 py-2 text-[13px] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          {editSavingMember ? "Сохраняем…" : "Добавить осветителя"}
                        </button>
                      </div>
                    )}

                    {/* Bulk presets strip */}
                    <div className="mt-4 bg-surface-2 border border-border rounded-md p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[11px] text-ink-3 uppercase tracking-wide">Смен</span>
                        {[1, 2, 3].map((n) => (
                          <Pill
                            key={n}
                            active={editBulkShifts === n}
                            onClick={() => editApplyBulkShifts(n)}
                          >
                            {n}
                          </Pill>
                        ))}
                        <Pill active={editBulkShifts === null} onClick={() => setEditBulkShifts(null)}>
                          свой
                        </Pill>
                      </div>
                      <div className="h-px bg-border -mx-3 my-2.5" />
                      <HoursSlider value={editBulkHours} onChange={editApplyBulkHours} />
                    </div>

                    {/* Per-member table */}
                    {editSelectedMembers.length > 0 && (
                      <div className="mt-3 border border-border rounded-md overflow-hidden bg-surface">
                        <div className="flex items-baseline justify-between px-3 py-2 bg-surface-2 border-b border-border">
                          <span className="eyebrow">Смены участников</span>
                          <span className="text-[11px] text-ink-3">
                            часы можно поменять индивидуально
                          </span>
                        </div>
                        {editSelectedMembers.map((m) => {
                          const contact = editTeamContacts.find((c) => c.id === m.contactId);
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
                                <MemberNumberField
                                  label="Смен"
                                  value={m.shifts}
                                  onChange={(n) =>
                                    editUpdateMemberField(
                                      m.contactId,
                                      "shifts",
                                      n,
                                    )
                                  }
                                  ariaLabel={`Смен — ${m.contactId}`}
                                />
                                <MemberNumberField
                                  label="Часов"
                                  value={m.hours}
                                  onChange={(n) =>
                                    editUpdateMemberField(
                                      m.contactId,
                                      "hours",
                                      n,
                                    )
                                  }
                                  ariaLabel={`Часов — ${m.contactId}`}
                                />
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

              {/* ═══════ STEP 6 — Итог ═══════ */}
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
                    sub="аренда света"
                    value={`− ${formatRub(lightBudget)}`}
                    tone="rose"
                  />
                  <SummaryRow
                    label="Должен команде"
                    sub={
                      editSelectedMembers.length > 0
                        ? `${editSelectedMembers.length} чел. · ${totalShifts} ${pluralize(
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
              </section>

              {/* ═══════ Sticky action bar ═══════ */}
              <div className="sticky bottom-0 inset-x-0 px-4 py-3 bg-surface border-t border-border flex items-center gap-2 z-10">
                <button
                  type="button"
                  onClick={cancelEdit}
                  className="flex-1 text-center px-4 py-2.5 border border-border rounded text-[13.5px] text-ink hover:bg-[#fafafa]"
                >
                  Отмена
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={editSaving || !editTitle.trim()}
                  className="flex-1 bg-accent-bright hover:bg-accent text-white font-medium rounded px-4 py-2.5 text-[13.5px] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {editSaving ? "Сохраняем…" : "Сохранить"}
                </button>
              </div>
            </div>
          );
        })()
      ) : (
        <div className="divide-y divide-border">
          {/* Title + meta */}
          <div className="px-4 py-4">
            <h2 className="text-[18px] font-semibold text-ink mb-1">{project.title}</h2>
            <div className="flex items-center gap-2 flex-wrap text-[12px] text-ink-2">
              {project.client && (
                <Link
                  href={`/gaffer/contacts/${project.clientId}`}
                  className="text-accent-bright hover:text-accent transition-colors"
                >
                  {project.client.name}
                </Link>
              )}
              {project.shootDate && (
                <span className="text-ink-3">· {formatShootDate(project.shootDate)}</span>
              )}
            </div>
            {project.note && (
              <p className="mt-2 text-[12.5px] text-ink-2 leading-relaxed whitespace-pre-wrap">
                {project.note}
              </p>
            )}
          </div>

          {/* Project summary money-block (screen 04) */}
          <div className="px-4 py-3">
            <div className={`grid border border-border rounded-md overflow-hidden bg-surface mb-3 ${vendorRemaining > 0 ? "grid-cols-2 md:grid-cols-4" : "grid-cols-3"}`}>
              <div className="p-2.5 border-r border-border text-center">
                <div className="eyebrow">Сумма</div>
                <div className="mono-num text-[15px] font-semibold mt-1">{formatRub(project.clientTotal ?? project.clientPlanAmount)}</div>
              </div>
              <div className="p-2.5 border-r border-border text-center">
                <div className="eyebrow">Должны мне</div>
                <div className="mono-num text-[15px] font-semibold text-rose mt-1">{formatRub(project.clientRemaining)}</div>
              </div>
              <div className={`p-2.5 text-center ${vendorRemaining > 0 ? "border-r border-border" : ""}`}>
                <div className="eyebrow">Должен я</div>
                <div className="mono-num text-[15px] font-semibold text-indigo mt-1">{formatRub(project.teamRemaining)}</div>
              </div>
              {vendorRemaining > 0 && (
                <div className="p-2.5 text-center">
                  <div className="eyebrow">Должен ренталу</div>
                  <div className="mono-num text-[15px] font-semibold text-amber mt-1">{formatRub(String(vendorRemaining))}</div>
                </div>
              )}
            </div>
          </div>

          {/* От заказчика */}
          <div className="px-4 py-4">
            <div className="flex items-baseline justify-between mb-3">
              <p className="eyebrow">От заказчика</p>
              {Number(project.clientRemaining ?? 0) > 0 && (
                <span className="text-[11.5px] text-ink-3 mono-num">
                  остаток <b className="text-rose">{formatRub(project.clientRemaining)}</b>
                </span>
              )}
            </div>
            {/* money-block */}
            <div className="grid grid-cols-3 border border-border rounded-md overflow-hidden bg-surface mb-3">
              <div className="p-2.5 border-r border-border text-center">
                <div className="eyebrow mb-0.5">К получению</div>
                <div className="mono-num text-[15px] font-semibold text-ink">{formatRub(project.clientTotal ?? project.clientPlanAmount)}</div>
              </div>
              <div className="p-2.5 border-r border-border text-center">
                <div className="eyebrow mb-0.5">Получено</div>
                <div className="mono-num text-[15px] font-semibold text-emerald">{formatRub(project.clientReceived)}</div>
              </div>
              <div className="p-2.5 text-center">
                <div className="eyebrow mb-0.5">Остаток</div>
                <div className={`mono-num text-[15px] font-semibold ${Number(project.clientRemaining ?? 0) > 0 ? "text-rose" : "text-ink"}`}>
                  {formatRub(project.clientRemaining)}
                </div>
              </div>
            </div>

            {/* IN payments as feed-row */}
            {inPayments.length > 0 && (
              <div className="mb-3">
                {inPayments.map((p) => (
                  <PaymentRow
                    key={p.id}
                    payment={p}
                    methods={methods}
                    onDelete={handleDeletePayment}
                    onUpdate={() => setRefreshKey((k) => k + 1)}
                  />
                ))}
              </div>
            )}

            <PaymentForm
              direction="IN"
              projectId={id}
              methods={methods}
              isArchived={project.status === "ARCHIVED"}
              onDone={() => { setRefreshKey((k) => k + 1); }}
              onCancel={() => {}}
            />
          </div>

          {/* Команда */}
          <div className="px-4 py-4">
            {/* Section header with subtitle */}
            {(() => {
              const teamPlan = Number(project.teamPlanTotal ?? 0);
              const teamPaid = Number(project.teamPaidTotal ?? 0);
              const teamRem = Number(project.teamRemaining ?? 0);
              const teamPct = teamPlan > 0 ? Math.round(teamPaid / teamPlan * 100) : 0;
              return (
                <div className="flex items-baseline justify-between mb-3">
                  <p className="eyebrow">Команда</p>
                  {teamPlan > 0 && (
                    <span className="eyebrow">закрыто {teamPct}% · ост. {formatRub(teamRem)}</span>
                  )}
                </div>
              );
            })()}

            {/* money-block for team */}
            <div className="grid grid-cols-3 border border-border rounded-md overflow-hidden bg-surface mb-3">
              <div className="p-2.5 border-r border-border text-center">
                <div className="eyebrow mb-0.5">План команде</div>
                <div className="mono-num text-[15px] font-semibold text-ink">{formatRub(project.teamPlanTotal)}</div>
              </div>
              <div className="p-2.5 border-r border-border text-center">
                <div className="eyebrow mb-0.5">Выплачено</div>
                <div className="mono-num text-[15px] font-semibold text-emerald">{formatRub(project.teamPaidTotal)}</div>
              </div>
              <div className="p-2.5 text-center">
                <div className="eyebrow mb-0.5">Остаток</div>
                <div className={`mono-num text-[15px] font-semibold ${Number(project.teamRemaining ?? 0) > 0 ? "text-indigo" : "text-ink"}`}>
                  {formatRub(project.teamRemaining)}
                </div>
              </div>
            </div>

            {/* Team members (TEAM_MEMBER only) */}
            {teamMembersFiltered.length > 0 && (
              <div className="mb-3">
                {teamMembersFiltered.map((m) => (
                  <MemberRow
                    key={m.id}
                    member={m}
                    methods={methods}
                    projectId={id}
                    isArchived={project.status === "ARCHIVED"}
                    onUpdate={() => setRefreshKey((k) => k + 1)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Аренда света */}
          <div className="px-4 py-4">
            <div className="flex items-baseline justify-between mb-3">
              <p className="eyebrow">Аренда света</p>
              {vendorPlanTotal > 0 && (
                <span className="eyebrow">ост. {formatRub(String(vendorRemaining > 0 ? vendorRemaining : 0))}</span>
              )}
            </div>

            {/* money-block for vendors */}
            {vendorPlanTotal > 0 && (
              <div className="grid grid-cols-3 border border-border rounded-md overflow-hidden bg-surface mb-3">
                <div className="p-2.5 border-r border-border text-center">
                  <div className="eyebrow mb-0.5">Бюджет</div>
                  <div className="mono-num text-[15px] font-semibold text-ink">{formatRub(String(vendorPlanTotal))}</div>
                </div>
                <div className="p-2.5 border-r border-border text-center">
                  <div className="eyebrow mb-0.5">Выплачено</div>
                  <div className="mono-num text-[15px] font-semibold text-emerald">{formatRub(String(vendorPaidTotal))}</div>
                </div>
                <div className="p-2.5 text-center">
                  <div className="eyebrow mb-0.5">Остаток</div>
                  <div className={`mono-num text-[15px] font-semibold ${vendorRemaining > 0 ? "text-amber" : "text-ink"}`}>
                    {formatRub(String(vendorRemaining > 0 ? vendorRemaining : 0))}
                  </div>
                </div>
              </div>
            )}

            {/* Vendor members */}
            {vendorMembers.length > 0 && (
              <div className="mb-3">
                {vendorMembers.map((m) => (
                  <MemberRow
                    key={m.id}
                    member={m}
                    methods={methods}
                    projectId={id}
                    isArchived={project.status === "ARCHIVED"}
                    onUpdate={() => setRefreshKey((k) => k + 1)}
                  />
                ))}
              </div>
            )}

            <AddMemberForm
              projectId={id}
              methods={methods}
              isArchived={project.status === "ARCHIVED"}
              contactType="VENDOR"
              onDone={() => { setRefreshKey((k) => k + 1); }}
              onCancel={() => {}}
            />
          </div>
        </div>
      )}

      {/* Delete project modal */}
      {showDeleteModal && (
        <div
          className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowDeleteModal(false); }}
        >
          <div className="bg-surface rounded-lg shadow-xl p-5 w-full max-w-sm">
            <h3 className="text-[15px] font-semibold text-ink mb-2">Удалить проект?</h3>
            <p className="text-[13px] text-ink-2 mb-5">
              Вы собираетесь удалить <span className="font-medium text-ink">{project.title}</span>. Это действие нельзя отменить.
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleDelete}
                disabled={deleteLoading}
                className="flex-1 bg-rose hover:bg-rose/90 text-white font-medium rounded px-4 py-2.5 text-[13px] disabled:opacity-50 transition-colors"
              >
                {deleteLoading ? "Удаляем…" : "Удалить"}
              </button>
              <button
                onClick={() => setShowDeleteModal(false)}
                className="flex-1 bg-surface border border-border text-ink rounded px-4 py-2.5 text-[13px] hover:bg-[#fafafa] transition-colors"
              >
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function GafferProjectDetailPage() {
  return (
    <Suspense fallback={
      <div className="p-4 space-y-3 animate-pulse">
        <div className="h-5 bg-border rounded w-1/2" />
        <div className="h-4 bg-border rounded w-1/3" />
        <div className="h-4 bg-border rounded w-2/3" />
      </div>
    }>
      <GafferProjectDetailContent />
    </Suspense>
  );
}
