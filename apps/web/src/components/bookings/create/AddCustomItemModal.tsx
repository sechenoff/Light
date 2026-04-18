"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (payload: { name: string; unitPrice: number; quantity: number }) => void;
};

export function AddCustomItemModal({ isOpen, onClose, onAdd }: Props) {
  const [name, setName] = useState("");
  const [unitPriceStr, setUnitPriceStr] = useState("");
  const [quantityStr, setQuantityStr] = useState("1");
  const [error, setError] = useState<string | null>(null);

  const nameRef = useRef<HTMLInputElement>(null);

  // Reset fields on open; focus name
  useEffect(() => {
    if (isOpen) {
      setName("");
      setUnitPriceStr("");
      setQuantityStr("1");
      setError(null);
      setTimeout(() => nameRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Esc-close
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const trimmedName = name.trim();
  const unitPrice = parseFloat(unitPriceStr);
  const quantity = parseInt(quantityStr, 10);

  const isValid =
    trimmedName.length > 0 &&
    trimmedName.length <= 200 &&
    Number.isFinite(unitPrice) &&
    unitPrice > 0 &&
    Number.isInteger(quantity) &&
    quantity >= 1;

  function handleSubmit() {
    if (!isValid) {
      if (!trimmedName) {
        setError("Введите название позиции");
      } else if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
        setError("Укажите цену больше нуля");
      } else if (!Number.isInteger(quantity) || quantity < 1) {
        setError("Количество должно быть ≥ 1");
      }
      return;
    }
    setError(null);
    onAdd({ name: trimmedName, unitPrice, quantity });
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && isValid) {
      handleSubmit();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 px-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-custom-item-title"
    >
      <div
        className="w-full max-w-md rounded-lg bg-surface p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="eyebrow mb-2">Произвольная позиция</div>
        <h2 id="add-custom-item-title" className="mb-1 text-lg font-semibold text-ink">
          Добавить произвольную позицию
        </h2>

        <div className="mb-4 flex flex-col gap-3">
          {/* Name */}
          <div>
            <label htmlFor="custom-name" className="mb-1 block text-sm text-ink-2">
              Название <span className="text-rose">*</span>
            </label>
            <input
              id="custom-name"
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleKeyDown}
              maxLength={200}
              placeholder="Тележка долли"
              className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
            />
          </div>

          {/* Unit price */}
          <div>
            <label htmlFor="custom-unit-price" className="mb-1 block text-sm text-ink-2">
              Цена за всю бронь, ₽ <span className="text-rose">*</span>
            </label>
            <input
              id="custom-unit-price"
              type="number"
              value={unitPriceStr}
              onChange={(e) => setUnitPriceStr(e.target.value)}
              onKeyDown={handleKeyDown}
              min={1}
              step="any"
              placeholder="70 000"
              className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
            />
          </div>

          {/* Quantity */}
          <div>
            <label htmlFor="custom-quantity" className="mb-1 block text-sm text-ink-2">
              Количество <span className="text-rose">*</span>
            </label>
            <input
              id="custom-quantity"
              type="number"
              value={quantityStr}
              onChange={(e) => setQuantityStr(e.target.value)}
              onKeyDown={handleKeyDown}
              min={1}
              step={1}
              placeholder="1"
              className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
            />
          </div>
        </div>

        <p className="mb-4 text-xs text-ink-3">
          Для позиций, которых нет в каталоге — услуги, расходники, субаренда. Цена указывается сразу за всю бронь.
        </p>

        {error && (
          <p className="mb-3 text-sm text-rose">{error}</p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-border px-4 py-2 text-sm text-ink-2 hover:bg-surface-muted"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!isValid}
            className="rounded bg-accent-bright px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Добавить в смету
          </button>
        </div>
      </div>
    </div>
  );
}
