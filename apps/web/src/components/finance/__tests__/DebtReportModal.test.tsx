/**
 * Панель «Сформировать отчёт»: состав отчёта, снятие строк и клиентов,
 * настройки документа и то, что уходит на сервер.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

import { DebtReportModal, type DebtReportSelection } from "../DebtReportModal";

const printMock = vi.fn(async (..._args: unknown[]) => undefined);
const downloadMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("../../../lib/estimateExport", () => ({
  printEstimate: (...args: unknown[]) => printMock(...args),
  downloadEstimate: (...args: unknown[]) => downloadMock(...args),
}));

const ROWS: DebtReportSelection[] = [
  { bookingId: "b1", clientId: "c1", clientName: "Альфа", projectName: "Реклама", amountOutstanding: "200000", daysOverdue: 90 },
  { bookingId: "b2", clientId: "c1", clientName: "Альфа", projectName: "Клип", amountOutstanding: "50000", daysOverdue: 10 },
  { bookingId: "b3", clientId: "c2", clientName: "Бета", projectName: "Сериал", amountOutstanding: "80000", daysOverdue: null },
];

function renderModal(over: Partial<React.ComponentProps<typeof DebtReportModal>> = {}) {
  const onRemove = vi.fn();
  const onRemoveClient = vi.fn();
  const onClose = vi.fn();
  render(
    <DebtReportModal
      open
      rows={ROWS}
      onClose={onClose}
      onRemove={onRemove}
      onRemoveClient={onRemoveClient}
      {...over}
    />,
  );
  return { onRemove, onRemoveClient, onClose };
}

const digits = (s: string) => s.replace(/\D/g, "");

beforeEach(() => {
  printMock.mockClear();
  downloadMock.mockClear();
});

describe("DebtReportModal", () => {
  it("показывает состав отчёта: клиенты, проекты и итоги", () => {
    renderModal();
    const header = screen.getByRole("dialog");
    // 2 клиента · 3 долга · 330 000, из них просрочено 250 000
    expect(within(header).getByText(/2 клиента/)).toBeInTheDocument();
    expect(within(header).getByText(/3 долга/)).toBeInTheDocument();
    expect(screen.getByText("Реклама")).toBeInTheDocument();
    expect(screen.getByText("Сериал")).toBeInTheDocument();
    expect(screen.getAllByText("Альфа")).toHaveLength(1);
  });

  it("клиент с просрочкой стоит выше — обзвон начинается сверху", () => {
    renderModal();
    const names = screen.getAllByText(/^(Альфа|Бета)$/).map((el) => el.textContent);
    expect(names).toEqual(["Альфа", "Бета"]);
  });

  it("строку и клиента можно снять прямо из панели", () => {
    const { onRemove, onRemoveClient } = renderModal();
    fireEvent.click(screen.getByLabelText("Убрать «Клип» из отчёта"));
    expect(onRemove).toHaveBeenCalledWith("b2");
    fireEvent.click(screen.getByLabelText("Убрать клиента Бета из отчёта"));
    expect(onRemoveClient).toHaveBeenCalledWith("c2");
  });

  it("печать шлёт POST с выбранными бронями и настройками документа", async () => {
    renderModal();
    fireEvent.change(screen.getByLabelText("Заголовок документа"), { target: { value: "Долги на планёрку" } });
    fireEvent.change(screen.getByLabelText("Примечание для сотрудника"), { target: { value: "до пятницы" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Печать/ }));

    await waitFor(() => expect(printMock).toHaveBeenCalled());
    const [path, , init] = printMock.mock.calls[0] as [string, string, RequestInit];
    expect(path).toBe("/api/finance/debts/report.pdf");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      bookingIds: ["b1", "b2", "b3"],
      title: "Долги на планёрку",
      note: "до пятницы",
      includeContacts: true,
    });
  });

  it("пустой заголовок и примечание не уходят на сервер — там свой дефолт", async () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: /Скачать PDF/ }));
    await waitFor(() => expect(downloadMock).toHaveBeenCalled());
    const body = JSON.parse(String((downloadMock.mock.calls[0][3] as RequestInit).body));
    expect(body.title).toBeUndefined();
    expect(body.note).toBeUndefined();
    expect(body.includeContacts).toBe(false);
  });

  it("XLSX идёт на свой маршрут", async () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: /Скачать XLSX/ }));
    await waitFor(() => expect(downloadMock).toHaveBeenCalled());
    expect(downloadMock.mock.calls[0][0]).toBe("/api/finance/debts/report.xlsx");
  });

  it("контакты по умолчанию выключены", () => {
    renderModal();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("без выбранных строк кнопки выгрузки заблокированы", () => {
    renderModal({ rows: [] });
    expect(screen.getByText(/Ничего не выбрано/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Печать/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Скачать PDF/ })).toBeDisabled();
  });

  it("закрыта — ничего не рендерит", () => {
    const { container } = render(
      <DebtReportModal open={false} rows={ROWS} onClose={vi.fn()} onRemove={vi.fn()} onRemoveClient={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("сумма по клиенту складывается из его строк", () => {
    renderModal();
    // Альфа: 200 000 + 50 000
    const alphaBlock = screen.getByText("Альфа").closest("div")?.parentElement?.parentElement;
    expect(alphaBlock).toBeTruthy();
    expect(digits(alphaBlock!.textContent ?? "")).toContain("250000");
  });
});
