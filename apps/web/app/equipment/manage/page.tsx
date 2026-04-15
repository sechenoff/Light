"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../../src/lib/api";
import { useCurrentUser } from "../../../src/hooks/useCurrentUser";

type EquipmentRow = {
  id: string;
  sortOrder: number;
  category: string;
  name: string;
  brand: string | null;
  model: string | null;
  totalQuantity: number;
  stockTrackingMode: "COUNT" | "UNIT";
  rentalRatePerShift: string;
  rentalRateTwoShifts: string | null;
  rentalRatePerProject: string | null;
  comment: string | null;
};

type FormState = {
  category: string;
  name: string;
  brand: string;
  model: string;
  totalQuantity: string;
  stockTrackingMode: "COUNT" | "UNIT";
  rentalRatePerShift: string;
  rentalRateTwoShifts: string;
  rentalRatePerProject: string;
  comment: string;
};

const EMPTY_FORM: FormState = {
  category: "",
  name: "",
  brand: "",
  model: "",
  totalQuantity: "1",
  stockTrackingMode: "COUNT",
  rentalRatePerShift: "0",
  rentalRateTwoShifts: "",
  rentalRatePerProject: "",
  comment: "",
};

function uniqueCategoriesFromEquipments(equipments: EquipmentRow[]): string[] {
  const seen = new Map<string, string>();
  for (const e of equipments) {
    const c = e.category?.trim();
    if (!c) continue;
    const k = c.toLowerCase();
    if (!seen.has(k)) seen.set(k, c);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, "ru"));
}

export default function EquipmentManagePage() {
  const { user } = useCurrentUser();
  const isSuperAdmin = user?.role === "SUPER_ADMIN";
  const [rows, setRows] = useState<EquipmentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingOrder, setSavingOrder] = useState(false);
  const [search, setSearch] = useState("");
  const [inlineEditId, setInlineEditId] = useState<string | null>(null);
  const [inlineForm, setInlineForm] = useState<FormState>(EMPTY_FORM);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  // Модал добавления позиции
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addForm, setAddForm] = useState<FormState>(EMPTY_FORM);
  const [addSaving, setAddSaving] = useState(false);
  const [addCategoryNew, setAddCategoryNew] = useState(false);
  const canAdd = addForm.category.trim() !== "" && addForm.name.trim() !== "";

  // Модал порядка категорий
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [categoryOrderDraft, setCategoryOrderDraft] = useState<string[]>([]);
  const [loadingCategoryOrder, setLoadingCategoryOrder] = useState(false);
  const [savingCategoryOrder, setSavingCategoryOrder] = useState(false);
  const [catDragged, setCatDragged] = useState<string | null>(null);
  const [catDragOver, setCatDragOver] = useState<string | null>(null);

  const rowsRef = useRef<EquipmentRow[]>([]);
  rowsRef.current = rows;

  async function load() {
    setLoading(true);
    try {
      const q = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : "";
      const data = await apiFetch<{ equipments: EquipmentRow[] }>(`/api/equipment${q}`);
      setRows(data.equipments);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load().catch(() => {});
  }, [search]);

  useEffect(() => {
    if (!categoryModalOpen) return;
    let cancelled = false;
    setLoadingCategoryOrder(true);

    async function loadCategoryDraft() {
      const pick = (r: unknown): string[] => {
        if (typeof r !== "object" || r === null) return [];
        const c = (r as { categories?: unknown }).categories;
        return Array.isArray(c) ? c.filter((x): x is string => typeof x === "string") : [];
      };

      let list: string[] = [];
      try {
        const r = await apiFetch<unknown>("/api/equipment/categories");
        list = pick(r);
      } catch {
        list = [];
      }
      if (!cancelled && list.length === 0) {
        try {
          const r = await apiFetch<{ equipments: EquipmentRow[] }>("/api/equipment");
          list = uniqueCategoriesFromEquipments(r.equipments ?? []);
        } catch {
          list = uniqueCategoriesFromEquipments(rowsRef.current);
        }
      }
      if (!cancelled) setCategoryOrderDraft(list);
      if (!cancelled) setLoadingCategoryOrder(false);
    }

    loadCategoryDraft();
    return () => {
      cancelled = true;
    };
  }, [categoryModalOpen]);

  function openAddModal() {
    const existingCategories = uniqueCategoriesFromEquipments(rowsRef.current);
    const firstCategory = existingCategories[0] ?? "";
    setAddForm({ ...EMPTY_FORM, category: firstCategory });
    setAddCategoryNew(existingCategories.length === 0);
    setAddModalOpen(true);
  }

  async function submitAdd() {
    if (!canAdd) return;
    setAddSaving(true);
    try {
      const payload = {
        category: addForm.category.trim(),
        name: addForm.name.trim(),
        brand: addForm.brand.trim() || null,
        model: addForm.model.trim() || null,
        totalQuantity: Math.max(0, Number(addForm.totalQuantity) || 0),
        stockTrackingMode: addForm.stockTrackingMode,
        rentalRatePerShift: Math.max(0, Number(addForm.rentalRatePerShift) || 0),
        rentalRateTwoShifts: addForm.rentalRateTwoShifts.trim() ? Math.max(0, Number(addForm.rentalRateTwoShifts) || 0) : null,
        rentalRatePerProject: addForm.rentalRatePerProject.trim() ? Math.max(0, Number(addForm.rentalRatePerProject) || 0) : null,
        comment: addForm.comment.trim() || null,
      };
      await apiFetch("/api/equipment", { method: "POST", body: JSON.stringify(payload) });
      setAddModalOpen(false);
      await load();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Не удалось добавить позицию";
      alert(msg);
    } finally {
      setAddSaving(false);
    }
  }

  function beginInlineEdit(r: EquipmentRow) {
    setInlineEditId(r.id);
    setInlineForm({
      category: r.category,
      name: r.name,
      brand: r.brand ?? "",
      model: r.model ?? "",
      totalQuantity: String(r.totalQuantity),
      stockTrackingMode: r.stockTrackingMode,
      rentalRatePerShift: r.rentalRatePerShift,
      rentalRateTwoShifts: r.rentalRateTwoShifts ?? "",
      rentalRatePerProject: r.rentalRatePerProject ?? "",
      comment: r.comment ?? "",
    });
  }

  async function saveInlineEdit() {
    if (!inlineEditId) return;
    const payload = {
      category: inlineForm.category.trim(),
      name: inlineForm.name.trim(),
      brand: inlineForm.brand.trim() || null,
      model: inlineForm.model.trim() || null,
      totalQuantity: Math.max(0, Number(inlineForm.totalQuantity) || 0),
      stockTrackingMode: inlineForm.stockTrackingMode,
      rentalRatePerShift: Math.max(0, Number(inlineForm.rentalRatePerShift) || 0),
      rentalRateTwoShifts: inlineForm.rentalRateTwoShifts.trim() ? Math.max(0, Number(inlineForm.rentalRateTwoShifts) || 0) : null,
      rentalRatePerProject: inlineForm.rentalRatePerProject.trim() ? Math.max(0, Number(inlineForm.rentalRatePerProject) || 0) : null,
      comment: inlineForm.comment.trim() || null,
    };
    await apiFetch(`/api/equipment/${inlineEditId}`, { method: "PATCH", body: JSON.stringify(payload) });
    setInlineEditId(null);
    await load();
  }

  async function removeRow(id: string) {
    if (!confirm("Удалить позицию оборудования?")) return;
    try {
      await apiFetch(`/api/equipment/${id}`, { method: "DELETE" });
      await load();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Не удалось удалить позицию";
      alert(msg);
    }
  }

  async function saveOrder(next: EquipmentRow[]) {
    setSavingOrder(true);
    await apiFetch("/api/equipment/reorder", {
      method: "POST",
      body: JSON.stringify({ ids: next.map((r) => r.id) }),
    });
    setSavingOrder(false);
  }

  async function moveByDrag(sourceId: string, targetId: string) {
    if (!sourceId || !targetId || sourceId === targetId) return;
    const from = rows.findIndex((r) => r.id === sourceId);
    const to = rows.findIndex((r) => r.id === targetId);
    if (from < 0 || to < 0) return;
    const next = [...rows];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setRows(next);
    await saveOrder(next);
  }

  function moveCategoryRow(source: string, target: string) {
    if (!source || !target || source === target) return;
    setCategoryOrderDraft((prev) => {
      const from = prev.indexOf(source);
      const to = prev.indexOf(target);
      if (from < 0 || to < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }

  async function saveCategoryOrderModal() {
    setSavingCategoryOrder(true);
    try {
      await apiFetch<{ categories: string[] }>("/api/equipment/reorder/categories", {
        method: "POST",
        body: JSON.stringify({ categories: categoryOrderDraft }),
      });
      setCategoryModalOpen(false);
      await load();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Не удалось сохранить порядок категорий";
      alert(msg);
    } finally {
      setSavingCategoryOrder(false);
    }
  }

  return (
    <div className="p-4 space-y-4">
      {/* Шапка */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Оборудование: редактор</h1>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
            onClick={() => setCategoryModalOpen(true)}
          >
            Порядок категорий
          </button>
        </div>
      </div>

      {/* Таблица */}
      <div className="rounded border border-slate-200 bg-white overflow-hidden">
        <div className="p-3 border-b border-slate-200 flex items-center justify-between gap-3">
          <input
            className="rounded border border-slate-300 px-2 py-1 text-sm w-full max-w-sm"
            placeholder="Поиск..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-500 whitespace-nowrap">
              {loading ? "Загрузка..." : savingOrder ? "Сохраняю порядок..." : `Позиций: ${rows.length}`}
            </span>
            <button
              type="button"
              className="rounded bg-slate-900 text-white px-3 py-1.5 text-sm hover:bg-slate-700 whitespace-nowrap"
              onClick={openAddModal}
            >
              + Добавить позицию
            </button>
          </div>
        </div>
        <div className="overflow-auto">
          <table className="min-w-[1100px] w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2 text-left w-[90px]">Порядок</th>
                <th className="px-3 py-2 text-left">Категория</th>
                <th className="px-3 py-2 text-left">Наименование</th>
                <th className="px-3 py-2 text-right">Кол-во</th>
                <th className="px-3 py-2 text-right">Смена</th>
                <th className="px-3 py-2 text-center w-[190px]">Действия</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className={`border-t border-slate-100 ${dragOverId === r.id ? "bg-sky-50" : ""}`}
                  draggable
                  onDragStart={() => {
                    setDraggedId(r.id);
                    setDragOverId(null);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (draggedId && draggedId !== r.id) setDragOverId(r.id);
                  }}
                  onDrop={async (e) => {
                    e.preventDefault();
                    if (!draggedId) return;
                    await moveByDrag(draggedId, r.id);
                    setDraggedId(null);
                    setDragOverId(null);
                  }}
                  onDragEnd={() => {
                    setDraggedId(null);
                    setDragOverId(null);
                  }}
                >
                  <td className="px-3 py-2">
                    <span className="text-slate-400 cursor-grab select-none" title="Перетяните строку мышкой">
                      ⋮⋮
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {inlineEditId === r.id ? (
                      <input
                        className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                        value={inlineForm.category}
                        onChange={(e) => setInlineForm((p) => ({ ...p, category: e.target.value }))}
                      />
                    ) : isSuperAdmin ? (
                      <button className="text-left hover:underline" onClick={() => beginInlineEdit(r)}>{r.category}</button>
                    ) : (
                      <span>{r.category}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {inlineEditId === r.id ? (
                      <input
                        className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                        value={inlineForm.name}
                        onChange={(e) => setInlineForm((p) => ({ ...p, name: e.target.value }))}
                      />
                    ) : isSuperAdmin ? (
                      <button className="text-left hover:underline" onClick={() => beginInlineEdit(r)}>{r.name}</button>
                    ) : (
                      <span>{r.name}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {inlineEditId === r.id ? (
                      <input
                        className="w-20 rounded border border-slate-300 px-2 py-1 text-sm text-right"
                        type="number"
                        min={0}
                        value={inlineForm.totalQuantity}
                        onChange={(e) => setInlineForm((p) => ({ ...p, totalQuantity: e.target.value }))}
                      />
                    ) : isSuperAdmin ? (
                      <button className="hover:underline" onClick={() => beginInlineEdit(r)}>{r.totalQuantity}</button>
                    ) : (
                      <span>{r.totalQuantity}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {inlineEditId === r.id ? (
                      <input
                        className="w-24 rounded border border-slate-300 px-2 py-1 text-sm text-right"
                        type="number"
                        min={0}
                        step="0.01"
                        value={inlineForm.rentalRatePerShift}
                        onChange={(e) => setInlineForm((p) => ({ ...p, rentalRatePerShift: e.target.value }))}
                      />
                    ) : isSuperAdmin ? (
                      <button className="hover:underline" onClick={() => beginInlineEdit(r)}>{r.rentalRatePerShift}</button>
                    ) : (
                      <span>{r.rentalRatePerShift}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-2">
                      {inlineEditId === r.id ? (
                        <>
                          <button
                            className="rounded border border-emerald-300 text-emerald-700 px-2 py-1 text-xs hover:bg-emerald-50"
                            onClick={saveInlineEdit}
                          >
                            Сохранить
                          </button>
                          <button
                            className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50"
                            onClick={() => setInlineEditId(null)}
                          >
                            Отмена
                          </button>
                        </>
                      ) : null}
                      {isSuperAdmin && (
                        <button
                          className="rounded border border-rose-300 text-rose-700 px-2 py-1 text-xs hover:bg-rose-50"
                          onClick={() => removeRow(r.id)}
                        >
                          Удалить
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td className="px-3 py-6 text-center text-slate-500" colSpan={6}>
                    Нет позиций
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {/* Модал: добавление позиции */}
      {addModalOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          role="presentation"
          onClick={() => setAddModalOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-equipment-title"
            className="w-full max-w-lg rounded-lg border border-slate-200 bg-white shadow-xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h2 id="add-equipment-title" className="text-base font-semibold text-slate-900">
                Добавить позицию
              </h2>
              <button
                type="button"
                className="text-sm text-slate-500 hover:text-slate-900"
                onClick={() => setAddModalOpen(false)}
              >
                Закрыть
              </button>
            </div>

            <div className="px-4 py-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-slate-500">Категория *</label>
                  {addCategoryNew ? (
                    <div className="flex gap-1">
                      <input
                        className="flex-1 rounded border border-slate-300 px-2 py-1.5 text-sm"
                        placeholder="Название новой категории"
                        autoFocus
                        value={addForm.category}
                        onChange={(e) => setAddForm((p) => ({ ...p, category: e.target.value }))}
                      />
                      {uniqueCategoriesFromEquipments(rows).length > 0 && (
                        <button
                          type="button"
                          className="rounded border border-slate-300 px-2 py-1.5 text-xs text-slate-500 hover:bg-slate-50 whitespace-nowrap"
                          onClick={() => {
                            const cats = uniqueCategoriesFromEquipments(rows);
                            setAddForm((p) => ({ ...p, category: cats[0] ?? "" }));
                            setAddCategoryNew(false);
                          }}
                        >
                          ← Из списка
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="flex gap-1">
                      <select
                        className="flex-1 rounded border border-slate-300 px-2 py-1.5 text-sm"
                        value={addForm.category}
                        onChange={(e) => setAddForm((p) => ({ ...p, category: e.target.value }))}
                      >
                        {uniqueCategoriesFromEquipments(rows).map((cat) => (
                          <option key={cat} value={cat}>{cat}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="rounded border border-slate-300 px-2 py-1.5 text-xs text-slate-500 hover:bg-slate-50 whitespace-nowrap"
                        onClick={() => {
                          setAddForm((p) => ({ ...p, category: "" }));
                          setAddCategoryNew(true);
                        }}
                      >
                        + Новая
                      </button>
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-slate-500">Наименование *</label>
                  <input
                    className="rounded border border-slate-300 px-2 py-1.5 text-sm"
                    placeholder="Название позиции"
                    value={addForm.name}
                    onChange={(e) => setAddForm((p) => ({ ...p, name: e.target.value }))}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-slate-500">Кол-во</label>
                  <input
                    className="rounded border border-slate-300 px-2 py-1.5 text-sm"
                    type="number"
                    min={0}
                    value={addForm.totalQuantity}
                    onChange={(e) => setAddForm((p) => ({ ...p, totalQuantity: e.target.value }))}
                  />
                </div>
                <div className="flex flex-col gap-1 col-span-2">
                  <label className="text-xs text-slate-500">Ставка за смену</label>
                  <input
                    className="rounded border border-slate-300 px-2 py-1.5 text-sm"
                    type="number"
                    min={0}
                    step="0.01"
                    value={addForm.rentalRatePerShift}
                    onChange={(e) => setAddForm((p) => ({ ...p, rentalRatePerShift: e.target.value }))}
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3 bg-slate-50">
              <button
                type="button"
                className="rounded border border-slate-300 bg-white px-4 py-2 text-sm hover:bg-slate-100"
                onClick={() => setAddModalOpen(false)}
              >
                Отмена
              </button>
              <button
                type="button"
                className="rounded bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800 disabled:opacity-50"
                disabled={!canAdd || addSaving}
                onClick={() => void submitAdd()}
              >
                {addSaving ? "Сохранение…" : "Добавить"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Модал: порядок категорий */}
      {categoryModalOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          role="presentation"
          onClick={() => setCategoryModalOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="category-order-title"
            className="w-full max-w-lg rounded-lg border border-slate-200 bg-white shadow-xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h2 id="category-order-title" className="text-base font-semibold text-slate-900">
                Порядок категорий
              </h2>
              <button type="button" className="text-sm text-slate-500 hover:text-slate-900" onClick={() => setCategoryModalOpen(false)}>
                Закрыть
              </button>
            </div>
            <p className="px-4 pt-3 text-xs text-slate-600">
              Порядок применяется к спискам оборудования в остатках и при создании брони. Перетащите строки. Категория «Транспорт» по умолчанию в конце списка.
            </p>
            <div className="max-h-[min(60vh,420px)] overflow-auto px-4 py-3">
              {loadingCategoryOrder ? (
                <div className="py-8 text-center text-sm text-slate-500">Загрузка…</div>
              ) : categoryOrderDraft.length === 0 ? (
                <div className="py-8 text-center text-sm text-slate-500">Нет категорий — сначала добавьте позиции оборудования с категорией.</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-slate-600 bg-slate-50">
                    <tr>
                      <th className="w-12 px-2 py-2 text-left" />
                      <th className="px-2 py-2 text-left">Категория</th>
                    </tr>
                  </thead>
                  <tbody>
                    {categoryOrderDraft.map((cat) => (
                      <tr
                        key={cat}
                        className={`border-t border-slate-100 ${catDragOver === cat ? "bg-sky-50" : ""}`}
                        draggable
                        onDragStart={() => {
                          setCatDragged(cat);
                          setCatDragOver(null);
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                          if (catDragged && catDragged !== cat) setCatDragOver(cat);
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (!catDragged) return;
                          moveCategoryRow(catDragged, cat);
                          setCatDragged(null);
                          setCatDragOver(null);
                        }}
                        onDragEnd={() => {
                          setCatDragged(null);
                          setCatDragOver(null);
                        }}
                      >
                        <td className="px-2 py-2 text-slate-400 cursor-grab select-none" title="Перетащите">
                          ⋮⋮
                        </td>
                        <td className="px-2 py-2 font-medium text-slate-900">{cat}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3 bg-slate-50">
              <button
                type="button"
                className="rounded border border-slate-300 bg-white px-4 py-2 text-sm hover:bg-slate-100"
                onClick={() => setCategoryModalOpen(false)}
              >
                Отмена
              </button>
              <button
                type="button"
                className="rounded bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800 disabled:opacity-50"
                disabled={loadingCategoryOrder || savingCategoryOrder}
                onClick={() => void saveCategoryOrderModal()}
              >
                {savingCategoryOrder ? "Сохранение…" : "Сохранить"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
