import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ReviewItemCard } from "../ReviewItemCard";
import type { PendingReviewItem } from "../types";

const baseProps = {
  pickupISO: "2026-05-01T10:00:00.000Z",
  returnISO: "2026-05-03T10:00:00.000Z",
  onConfirm: vi.fn(),
  onOffCatalog: vi.fn(),
  onSkip: vi.fn(),
};

const resolvedItem: PendingReviewItem = {
  reviewId: "rev-1",
  gafferPhrase: "скайпанель 60",
  interpretedName: "SkyPanel S60",
  quantity: 2,
  match: {
    kind: "resolved",
    equipmentId: "eq-1",
    catalogName: "ARRI SkyPanel S60-C",
    category: "Свет",
    availableQuantity: 5,
    rentalRatePerShift: "4000",
    confidence: 0.95,
  },
};

const needsReviewItem: PendingReviewItem = {
  reviewId: "rev-2",
  gafferPhrase: "генератор",
  interpretedName: "Генератор",
  quantity: 1,
  match: {
    kind: "needsReview",
    candidates: [
      {
        equipmentId: "eq-2",
        catalogName: "Honda EU22i",
        category: "Генераторы",
        availableQuantity: 2,
        rentalRatePerShift: "2000",
        confidence: 0.8,
      },
      {
        equipmentId: "eq-3",
        catalogName: "Hyundai HHY7010FE",
        category: "Генераторы",
        availableQuantity: 1,
        rentalRatePerShift: "1800",
        confidence: 0.65,
      },
    ],
  },
};

const unmatchedItem: PendingReviewItem = {
  reviewId: "rev-3",
  gafferPhrase: "неизвестная штука",
  interpretedName: "Неизвестная штука",
  quantity: 1,
  match: { kind: "unmatched" },
};

describe("ReviewItemCard", () => {
  it("renders resolved variant with catalog name and Подтвердить button; clicking calls onConfirm", () => {
    const onConfirm = vi.fn();
    render(<ReviewItemCard item={resolvedItem} {...baseProps} onConfirm={onConfirm} />);

    // Shows gaffer phrase
    expect(screen.getByText(/скайпанель 60/i)).toBeInTheDocument();
    // Shows catalog name match
    expect(screen.getByText(/ARRI SkyPanel S60-C/)).toBeInTheDocument();
    // Shows Подтвердить button
    const confirmBtn = screen.getByRole("button", { name: /подтвердить/i });
    expect(confirmBtn).toBeInTheDocument();

    fireEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledWith(
      "rev-1",
      {
        equipmentId: "eq-1",
        name: "ARRI SkyPanel S60-C",
        category: "Свет",
        rentalRatePerShift: "4000",
        availableQuantity: 5,
      },
      2,
    );
  });

  it("renders needsReview variant with candidate rows; clicking Выбрать on first candidate calls onConfirm", () => {
    const onConfirm = vi.fn();
    render(<ReviewItemCard item={needsReviewItem} {...baseProps} onConfirm={onConfirm} />);

    // Shows gaffer phrase
    expect(screen.getByText(/генератор/i)).toBeInTheDocument();
    // Shows both candidates
    expect(screen.getByText(/Honda EU22i/)).toBeInTheDocument();
    expect(screen.getByText(/Hyundai HHY7010FE/)).toBeInTheDocument();

    // Click Выбрать on first candidate
    const selectBtns = screen.getAllByRole("button", { name: /выбрать/i });
    expect(selectBtns.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(selectBtns[0]);

    expect(onConfirm).toHaveBeenCalledWith(
      "rev-2",
      {
        equipmentId: "eq-2",
        name: "Honda EU22i",
        category: "Генераторы",
        rentalRatePerShift: "2000",
        availableQuantity: 2,
      },
      1,
    );
  });

  it("renders unmatched variant; clicking Добавить вне каталога calls onOffCatalog; clicking Пропустить calls onSkip", () => {
    const onOffCatalog = vi.fn();
    const onSkip = vi.fn();
    render(<ReviewItemCard item={unmatchedItem} {...baseProps} onOffCatalog={onOffCatalog} onSkip={onSkip} />);

    // Shows gaffer phrase
    expect(screen.getByText(/неизвестная штука/i)).toBeInTheDocument();
    // Shows not found message
    expect(screen.getByText(/не найдено в каталоге/i)).toBeInTheDocument();

    // Добавить вне каталога
    const offCatalogBtn = screen.getByRole("button", { name: /добавить вне каталога/i });
    fireEvent.click(offCatalogBtn);
    expect(onOffCatalog).toHaveBeenCalledWith("rev-3");

    // Пропустить
    const skipBtn = screen.getByRole("button", { name: /пропустить/i });
    fireEvent.click(skipBtn);
    expect(onSkip).toHaveBeenCalledWith("rev-3");
  });
});
