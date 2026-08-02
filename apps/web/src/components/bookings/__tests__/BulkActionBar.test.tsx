import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { BulkActionBar } from "../BulkActionBar";
import type { BulkAction, BulkActionContext } from "../bulkActions";

const SA: BulkActionContext = { isSuperAdmin: true, approvalMode: "manual" };
const WH: BulkActionContext = { isSuperAdmin: false, approvalMode: "manual" };

const NONE: Record<BulkAction, number> = { approve: 0, submit: 0, cancel: 0, archive: 0 };

function setup(props: Partial<React.ComponentProps<typeof BulkActionBar>> = {}) {
  const onRun = vi.fn();
  const onClear = vi.fn();
  render(
    <BulkActionBar
      selectedCount={3}
      eligibleCounts={{ ...NONE, approve: 3, archive: 3 }}
      ctx={SA}
      busyAction={null}
      maxBatch={100}
      onRun={onRun}
      onClear={onClear}
      {...props}
    />,
  );
  return { onRun, onClear };
}

describe("BulkActionBar", () => {
  it("не рендерится, пока ничего не выбрано", () => {
    const { container } = render(
      <BulkActionBar
        selectedCount={0}
        eligibleCounts={NONE}
        ctx={SA}
        busyAction={null}
        maxBatch={100}
        onRun={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("показывает количество выбранного с правильным склонением", () => {
    setup({ selectedCount: 3 });
    expect(screen.getByText("брони")).toBeInTheDocument();
  });

  it("кладовщику не показывает согласование и архив", () => {
    setup({ ctx: WH, eligibleCounts: { ...NONE, submit: 2, cancel: 2 } });
    expect(screen.queryByRole("button", { name: /Согласовать/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /В архив/ })).toBeNull();
    expect(screen.getByRole("button", { name: /На согласование/ })).toBeInTheDocument();
  });

  it("кнопка без подходящих броней остаётся кликабельной — причину сообщает клик, а не молчание", () => {
    // title на disabled-элементе браузеры не показывают, а на тач-устройствах
    // его нет вовсе, поэтому кнопка активна и отвечает тостом.
    const { onRun } = setup({ eligibleCounts: { ...NONE, approve: 0, archive: 3 } });
    const approve = screen.getByRole("button", { name: /Согласовать/ });
    expect(approve).toBeEnabled();
    fireEvent.click(approve);
    expect(onRun).toHaveBeenCalledWith("approve");
    expect(screen.getByRole("button", { name: /В архив/ })).toBeEnabled();
  });

  it("при частичной применимости показывает «N из M»", () => {
    setup({ selectedCount: 7, eligibleCounts: { ...NONE, approve: 3 } });
    expect(screen.getByRole("button", { name: /Согласовать/ })).toHaveTextContent("3 из 7");
  });

  it("клик по действию сообщает какое именно", () => {
    const { onRun } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Согласовать/ }));
    expect(onRun).toHaveBeenCalledWith("approve");
  });

  it("«Снять выделение» вызывает очистку", () => {
    const { onClear } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Снять выделение" }));
    expect(onClear).toHaveBeenCalled();
  });

  it("предупреждает, когда выбрано больше лимита пачки", () => {
    setup({ selectedCount: 120, eligibleCounts: { ...NONE, archive: 120 } });
    expect(screen.getByText(/не больше 100/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /В архив/ })).toBeDisabled();
  });

  it("во время выполнения все кнопки заблокированы, активная показывает прогресс", () => {
    setup({ busyAction: "approve" });
    expect(screen.getByRole("button", { name: /Выполняю/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /В архив/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Снять выделение" })).toBeDisabled();
  });
});
