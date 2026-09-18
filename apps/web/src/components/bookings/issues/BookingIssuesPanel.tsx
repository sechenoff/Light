"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { BookingIssue, BookingIssuesResponse } from "@light-rental/shared";
import { apiFetch } from "../../../lib/api";
import { AddRepairModal } from "../../repair/AddRepairModal";
import { button } from "../register/RegisterFilters";
import { registerDate } from "../register/model";

function IssueCard({ item }: { item: BookingIssue }) {
  return (
    <article className="min-w-0 rounded-lg border border-border bg-surface p-4" data-booking-issue={item.id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-ink-3">{item.kind === "missing" ? "Недостача" : "Повреждение"}</span>
        <span className={`rounded px-2 py-1 text-xs font-medium ${item.open ? "bg-amber-soft text-amber" : "bg-surface-subtle text-ink-2"}`}>{item.statusLabel}</span>
      </div>
      <h3 className="mt-2 break-words text-base font-semibold text-ink">{item.equipmentName} <span className="whitespace-nowrap text-ink-2">· {item.quantity} шт.</span></h3>
      {item.kind === "missing" && <p className="mt-1 text-sm text-ink-2">{item.title}</p>}
      <p className="mt-2 whitespace-pre-wrap break-words text-sm text-ink-2">{item.description || "Описание не добавлено"}</p>
      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-ink-3">Зафиксировано</dt><dd className="break-words text-ink-2">{registerDate(item.createdAt, true)}{item.createdBy ? ` · ${item.createdBy}` : ""}</dd>
        {item.open && <><dt className="text-ink-3">{item.kind === "missing" ? "Досдача" : "Готовность"}</dt><dd className={item.overdue ? "font-medium text-rose" : "text-ink-2"}>{item.expectedAt ? registerDate(item.expectedAt) : "Срок не назначен"}{item.overdue ? " · просрочено" : ""}</dd></>}
        {item.kind === "damage" && <><dt className="text-ink-3">Техник</dt><dd className="break-words text-ink-2">{item.assignedTo ?? "Не назначен"}</dd></>}
        {item.closedAt && <><dt className="text-ink-3">Закрыто</dt><dd className="break-words text-ink-2">{registerDate(item.closedAt, true)}{item.closedBy ? ` · ${item.closedBy}` : ""}</dd></>}
      </dl>
      {item.resolution && <p className="mt-3 whitespace-pre-wrap break-words rounded bg-surface-subtle p-3 text-xs text-ink-2"><span className="font-medium">{item.open ? "Последняя запись: " : "Результат: "}</span>{item.resolution}</p>}
      {item.photos.length > 0 && <div className="mt-3 grid grid-cols-3 gap-2" aria-label="Фотографии повреждения">
        {item.photos.slice(0, 3).map((p, n) => <Link key={p.id} href={item.href} className="overflow-hidden rounded border border-border" aria-label={`Открыть ремонт и фото ${n + 1}`}>
          {/* eslint-disable-next-line @next/next/no-img-element -- authenticated same-origin photo stream */}
          <img src={p.url} alt={`Повреждение: ${item.equipmentName}`} className="aspect-[4/3] w-full object-cover" loading="lazy" />
        </Link>)}
      </div>}
      <p className="mt-3 break-words text-xs leading-5 text-ink-2">{item.nextStep}</p>
      <Link href={item.href} className={`${button} mt-3 inline-flex`}>
        {item.kind === "damage" ? "Открыть ремонт →" : item.open ? "Разобрать недостачу →" : "Открыть запись в потеряшках →"}
      </Link>
    </article>
  );
}

export function BookingIssuesPanel({ bookingId, close, onChanged }: {
  bookingId: string; close: () => void; onChanged?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<BookingIssuesResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [tab, setTab] = useState<"open" | "history">("open");
  const [adding, setAdding] = useState(false);
  const [repairOpen, setRepairOpen] = useState(false);
  useEffect(() => {
    const el = dialog.current;
    if (!repairOpen) el?.showModal();
    return () => el?.close();
  }, [repairOpen]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    apiFetch<BookingIssuesResponse>(`/api/bookings/${encodeURIComponent(bookingId)}/issues`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message || "Не удалось загрузить проблемы"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [bookingId, revision]);
  const created = useCallback(() => { setRevision(n => n + 1); onChanged?.(); }, [onChanged]);
  const visible = data?.items.filter(i => tab === "open" ? i.open : !i.open) ?? [];
  return <>
    <dialog ref={dialog} aria-labelledby="booking-issues-title" onCancel={e => { e.preventDefault(); close(); }}
      className="fixed inset-y-0 left-auto right-0 m-0 h-dvh max-h-none w-full max-w-xl overflow-y-auto border-l border-border bg-surface-subtle p-0 text-ink shadow-xl backdrop:bg-scrim/40">
      <header className="sticky top-0 z-10 border-b border-border bg-surface p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0"><p className="eyebrow text-ink-3">По проекту</p><h2 id="booking-issues-title" className="mt-1 text-xl font-semibold">Проблемы и ремонты</h2>
            {data && <p className="mt-2 break-words text-sm text-ink-2">{data.booking.projectName} · {data.booking.clientName}</p>}
          </div>
          <button onClick={close} className={button} aria-label="Закрыть проблемы проекта">×</button>
        </div>
        <p className="mt-3 text-xs leading-5 text-ink-3">Недостачи со склада и повреждения из мастерской. Количество вещей показано отдельно от количества случаев.</p>
      </header>
      <div className="space-y-4 p-4 pb-8 sm:p-5">
        {loading && <p role="status" className="py-6 text-center text-sm text-ink-3">Загружаем проблемы проекта…</p>}
        {error && <div role="alert" className="rounded border border-rose-border bg-rose-soft p-3 text-sm text-rose">{error}<button className={`${button} mt-3 block`} onClick={() => setRevision(n => n + 1)}>Повторить загрузку</button></div>}
        {data && <>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-border bg-surface p-3"><p className="text-xs text-ink-3">Недостача</p><p className="mt-1 text-xl font-semibold">{data.summary.missingQuantity} шт.</p></div>
            <div className="rounded-lg border border-border bg-surface p-3"><p className="text-xs text-ink-3">Повреждения</p><p className="mt-1 text-xl font-semibold">{data.summary.damageQuantity} шт.</p></div>
          </div>
          <div className="flex flex-wrap gap-2" aria-label="Состояние проблем">
            <button className={`${button} ${tab === "open" ? "!border-accent !bg-accent-soft !text-accent" : ""}`} aria-pressed={tab === "open"} onClick={() => setTab("open")}>Открытые · {data.summary.openCases}</button>
            <button className={`${button} ${tab === "history" ? "!border-accent !bg-accent-soft !text-accent" : ""}`} aria-pressed={tab === "history"} onClick={() => setTab("history")}>История · {data.summary.closedCases}</button>
          </div>
          {!data.booking.archived && <button className={`${button} w-full`} onClick={() => setAdding(v => !v)} aria-expanded={adding}>+ Зафиксировать проблему</button>}
          {adding && !data.booking.archived && <div className="space-y-3 rounded-lg border border-accent-border bg-surface p-4">
            <p className="text-sm text-ink-2">Недостачу отмечайте при приёмке конкретных позиций. Повреждение можно зафиксировать отдельно, в том числе после возврата.</p>
            <div className="flex flex-wrap gap-2"><Link className={button} href={`/warehouse/scan?booking=${encodeURIComponent(bookingId)}`}>Недостача при возврате</Link>
              <button className={button} onClick={() => setRepairOpen(true)}>Зафиксировать повреждение</button></div>
          </div>}
          {visible.length ? visible.map(item => <IssueCard key={`${item.kind}:${item.id}`} item={item} />) : <div className="rounded-lg border border-dashed border-border p-6 text-center"><p className="text-sm text-ink-2">{tab === "open" ? "Открытых проблем нет" : "Закрытых случаев пока нет"}</p>{tab === "open" && data.summary.closedCases > 0 && <button className="mt-3 text-sm text-accent underline" onClick={() => setTab("history")}>Посмотреть историю проекта</button>}</div>}
          <p className="rounded-lg border border-border bg-surface p-3 text-xs leading-5 text-ink-3">Возврат вещи, завершение ремонта и расчёты с клиентом учитываются отдельно. Закрытие проблемы не подтверждает оплату компенсации.</p>
        </>}
      </div>
    </dialog>
    {repairOpen && data && <AddRepairModal open onClose={() => setRepairOpen(false)} onCreated={created} sourceBooking={{ id: bookingId, name: data.booking.projectName }} />}
  </>;
}

export function BookingIssuesButton({ bookingId }: { bookingId: string }) {
  const [open, setOpen] = useState(false);
  return <div className="print:hidden"><button className={button} onClick={() => setOpen(true)}>Проблемы и ремонты →</button>
    {open && <BookingIssuesPanel bookingId={bookingId} close={() => setOpen(false)} />}</div>;
}
