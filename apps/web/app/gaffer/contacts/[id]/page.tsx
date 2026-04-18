"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  getContact,
  updateContact,
  archiveContact,
  unarchiveContact,
  deleteContact,
  GafferApiError,
  type GafferContact,
} from "../../../../src/lib/gafferApi";
import { toast } from "../../../../src/components/ToastProvider";

function TypePill({ type }: { type: GafferContact["type"] }) {
  if (type === "CLIENT") {
    return (
      <span
        className="inline-flex items-center rounded-full border px-[9px] py-[3px] text-[11px] font-semibold bg-indigo-soft text-indigo border-indigo-border"
        style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
      >
        Заказчик
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center rounded-full border px-[9px] py-[3px] text-[11px] font-semibold bg-teal-soft text-teal border-teal-border"
      style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
    >
      Команда
    </span>
  );
}

export default function GafferContactDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [contact, setContact] = useState<GafferContact | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // Edit mode
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editTelegram, setEditTelegram] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editLoading, setEditLoading] = useState(false);
  const [editErrors, setEditErrors] = useState<Record<string, string>>({});

  // Menu
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Delete confirm modal
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Alert banner (inline)
  const [alertMsg, setAlertMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    let cancelled = false;
    setLoading(true);
    try {
      const res = await getContact(id);
      if (!cancelled) {
        setContact(res.contact);
        setEditName(res.contact.name);
        setEditPhone(res.contact.phone ?? "");
        setEditTelegram(res.contact.telegram ?? "");
        setEditNote(res.contact.note ?? "");
      }
    } catch (e) {
      if (!cancelled) {
        if (e instanceof GafferApiError && e.status === 404) setNotFound(true);
        else setNotFound(true);
      }
    } finally {
      if (!cancelled) setLoading(false);
    }
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Close menu on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [menuOpen]);

  async function handleSave() {
    if (!contact) return;
    setEditErrors({});
    setEditLoading(true);
    try {
      const res = await updateContact(id, {
        name: editName.trim(),
        phone: editPhone.trim() || undefined,
        telegram: editTelegram.trim() || undefined,
        note: editNote.trim() || undefined,
      });
      setContact(res.contact);
      setEditing(false);
      toast.success("Контакт обновлён");
    } catch (err) {
      if (err instanceof GafferApiError) {
        if (err.code === "INVALID_TELEGRAM") {
          setEditErrors({ telegram: "Некорректный Telegram" });
        } else {
          toast.error(err.message);
        }
      }
    } finally {
      setEditLoading(false);
    }
  }

  async function handleArchiveToggle() {
    if (!contact) return;
    setMenuOpen(false);
    try {
      const res = contact.isArchived
        ? await unarchiveContact(id)
        : await archiveContact(id);
      setContact(res.contact);
      toast.success(res.contact.isArchived ? "Контакт в архиве" : "Контакт восстановлен");
    } catch (err) {
      toast.error(err instanceof GafferApiError ? err.message : "Ошибка");
    }
  }

  async function handleDelete() {
    setDeleteLoading(true);
    try {
      await deleteContact(id);
      toast.success("Контакт удалён");
      router.push("/gaffer/contacts");
    } catch (err) {
      if (err instanceof GafferApiError && err.code === "CONTACT_HAS_RELATIONS") {
        setShowDeleteModal(false);
        setAlertMsg("Контакт используется в проектах — сначала отвяжите его.");
      } else {
        toast.error(err instanceof GafferApiError ? err.message : "Ошибка удаления");
      }
    } finally {
      setDeleteLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="p-4 space-y-3 animate-pulse">
        <div className="h-5 bg-border rounded w-1/2" />
        <div className="h-4 bg-border rounded w-1/3" />
        <div className="h-4 bg-border rounded w-2/3" />
      </div>
    );
  }

  if (notFound || !contact) {
    return (
      <div className="p-6 text-center">
        <p className="text-ink-3 mb-4">Контакт не найден</p>
        <Link href="/gaffer/contacts" className="text-accent-bright">← Все контакты</Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-border">
        <div className="flex items-center gap-3">
          <Link href="/gaffer/contacts" className="text-accent-bright hover:text-accent transition-colors text-[13px]">
            ← Назад
          </Link>
          <TypePill type={contact.type} />
          {contact.isArchived && (
            <span
              className="inline-flex items-center rounded-full border px-[9px] py-[3px] text-[11px] font-semibold bg-slate-soft text-slate border-slate-border"
              style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
            >
              В архиве
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!editing && (
            <button
              onClick={() => setEditing(true)}
              className="text-[13px] text-accent-bright hover:text-accent transition-colors font-medium"
            >
              Редактировать
            </button>
          )}
          {/* Menu */}
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="w-8 h-8 flex items-center justify-center text-ink-3 hover:text-ink transition-colors text-[18px] rounded"
              aria-label="Действия"
            >
              ⋯
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-9 bg-surface border border-border rounded-lg shadow-sm z-20 w-44 py-1">
                <button
                  onClick={handleArchiveToggle}
                  className="w-full text-left px-4 py-2.5 text-[13px] text-ink hover:bg-[#fafafa] transition-colors"
                >
                  {contact.isArchived ? "Из архива" : "В архив"}
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

      {/* Alert banner */}
      {alertMsg && (
        <div
          role="alert"
          className="mx-4 mt-3 flex items-start gap-2 bg-rose-soft border border-rose-border text-rose text-[12.5px] rounded px-3 py-2.5"
        >
          <span className="shrink-0">⚠️</span>
          <span className="flex-1">{alertMsg}</span>
          <button onClick={() => setAlertMsg(null)} className="shrink-0 text-rose/60 hover:text-rose text-xs">✕</button>
        </div>
      )}

      {/* Edit form */}
      {editing ? (
        <div className="px-4 py-5 space-y-4">
          <div>
            <label className="block text-[12px] text-ink-2 mb-1">Имя *</label>
            <input
              autoFocus
              required
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className="w-full px-[11px] py-[9px] border border-border rounded text-[13.5px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright"
            />
          </div>
          <div>
            <label className="block text-[12px] text-ink-2 mb-1">Тип</label>
            <p className="text-[13px] text-ink-2">
              {contact.type === "CLIENT" ? "Заказчик" : "Команда"} <span className="text-ink-3">(не изменяется)</span>
            </p>
          </div>
          <div>
            <label className="block text-[12px] text-ink-2 mb-1">Телефон</label>
            <input
              type="tel"
              value={editPhone}
              onChange={(e) => setEditPhone(e.target.value)}
              className="w-full px-[11px] py-[9px] border border-border rounded text-[13.5px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright"
            />
          </div>
          <div>
            <label className="block text-[12px] text-ink-2 mb-1">Telegram</label>
            <input
              value={editTelegram}
              onChange={(e) => setEditTelegram(e.target.value)}
              placeholder="@username или t.me/…"
              className={`w-full px-[11px] py-[9px] border rounded text-[13.5px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright ${editErrors.telegram ? "border-rose-border" : "border-border"}`}
            />
            {editErrors.telegram && <p className="text-rose text-[11.5px] mt-1">{editErrors.telegram}</p>}
          </div>
          <div>
            <label className="block text-[12px] text-ink-2 mb-1">Заметка</label>
            <textarea
              value={editNote}
              onChange={(e) => setEditNote(e.target.value)}
              rows={3}
              className="w-full px-[11px] py-[9px] border border-border rounded text-[13.5px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright resize-none"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={editLoading || !editName.trim()}
              className="flex-1 bg-accent-bright hover:bg-accent text-white font-medium rounded px-4 py-2.5 text-[13px] transition-colors disabled:opacity-50"
            >
              {editLoading ? "Сохраняем…" : "Сохранить"}
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setEditErrors({});
                setEditName(contact.name);
                setEditPhone(contact.phone ?? "");
                setEditTelegram(contact.telegram ?? "");
                setEditNote(contact.note ?? "");
              }}
              className="flex-1 bg-surface border border-border text-ink rounded px-4 py-2.5 text-[13px] hover:bg-[#fafafa] transition-colors"
            >
              Отменить
            </button>
          </div>
        </div>
      ) : (
        /* View mode */
        <div className="divide-y divide-border">
          {/* Name & contacts */}
          <div className="px-4 py-4">
            <h2 className="text-[18px] font-semibold text-ink mb-3">{contact.name}</h2>
            {(contact.phone || contact.telegram) && (
              <div className="space-y-2">
                {contact.phone && (
                  <a
                    href={`tel:${contact.phone}`}
                    className="flex items-center gap-2 text-[13px] text-ink hover:text-accent-bright transition-colors"
                  >
                    <span className="text-ink-3">📞</span> {contact.phone}
                  </a>
                )}
                {contact.telegram && (
                  <a
                    href={
                      contact.telegram.startsWith("@")
                        ? `https://t.me/${contact.telegram.slice(1)}`
                        : contact.telegram
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-[13px] text-accent-bright hover:text-accent transition-colors"
                  >
                    <span className="text-ink-3">✈️</span> {contact.telegram}
                  </a>
                )}
              </div>
            )}
          </div>

          {/* Note */}
          {contact.note && (
            <div className="px-4 py-4">
              <p className="text-[11px] text-ink-3 font-semibold tracking-wider uppercase mb-1.5" style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}>
                Заметка
              </p>
              <p className="text-[13px] text-ink leading-relaxed whitespace-pre-wrap">{contact.note}</p>
            </div>
          )}

          {/* Projects stub */}
          <div className="px-4 py-4">
            <p className="text-[11px] text-ink-3 font-semibold tracking-wider uppercase mb-1.5" style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}>
              Проекты
            </p>
            <p className="text-[12.5px] text-ink-3 italic">Проекты появятся после Sprint 3</p>
          </div>
        </div>
      )}

      {/* Delete confirmation modal */}
      {showDeleteModal && (
        <div
          className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowDeleteModal(false); }}
        >
          <div className="bg-surface rounded-lg shadow-xl p-5 w-full max-w-sm">
            <h3 className="text-[15px] font-semibold text-ink mb-2">
              Удалить контакт?
            </h3>
            <p className="text-[13px] text-ink-2 mb-5">
              Вы собираетесь удалить <span className="font-medium text-ink">{contact.name}</span>. Это действие нельзя отменить.
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleDelete}
                disabled={deleteLoading}
                className="flex-1 bg-rose hover:bg-rose/90 text-white font-medium rounded px-4 py-2.5 text-[13px] transition-colors disabled:opacity-50"
              >
                {deleteLoading ? "Удаляем…" : "Удалить"}
              </button>
              <button
                onClick={() => setShowDeleteModal(false)}
                className="flex-1 bg-surface border border-border text-ink rounded px-4 py-2.5 text-[13px] hover:bg-[#fafafa] transition-colors"
              >
                Отменить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
