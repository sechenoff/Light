/**
 * Блоки карточки ремонта: лента фото, «раньше чинили», журнал работ.
 *
 * Проверяется не вёрстка, а три правила, из-за которых блоки и появились:
 * снимки с приёмки должны открываться, суммы не должны попадать к технику,
 * а форма записи обязана отдавать ровно то число часов, которое человек выбрал.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { RepairPhotoStrip } from "../RepairPhotoStrip";
import { RepairHistoryBlock, type RepairHistory } from "../RepairHistoryBlock";
import { RepairCloseModal } from "../RepairCloseModal";
import { RepairEtaCard } from "../RepairEtaCard";
import { WorkLogComposer, WorkLogList, type RepairWorkLogEntry } from "../WorkLogComposer";
import type { RepairListItem } from "../types";

/** Минимальный ремонт: заполнено только то, что читают проверяемые блоки. */
function makeRepair(patch: Partial<RepairListItem> = {}): RepairListItem {
  return {
    id: "r1",
    unitId: "u1",
    bookingItemId: null,
    equipmentId: "e1",
    quantity: 1,
    status: "IN_REPAIR",
    urgency: "NORMAL",
    reason: "Не включается",
    sourceBookingId: null,
    createdBy: "w1",
    assignedTo: "t1",
    partsCost: "2400",
    totalTimeHours: "4.5",
    createdAt: "2026-08-05T09:00:00.000Z",
    updatedAt: "2026-08-09T09:00:00.000Z",
    closedAt: null,
    expectedReadyAt: null,
    partsNote: null,
    unit: null,
    bookingItem: null,
    equipment: null,
    sourceBooking: null,
    title: "Aputure 600d Pro",
    titleSource: "unit",
    assignedToName: "Пётр Кузнецов",
    createdByName: "Сергей Лапин",
    photoCount: 0,
    workLogCount: 1,
    lastWorkLogAt: null,
    risk: {
      level: "NONE",
      booking: null,
      shortfall: 0,
      inPark: 7,
      inRepair: 1,
      booked: 0,
      sparesLeft: 6,
      slackDays: null,
    },
    ...patch,
  };
}

const photos = [
  { id: "p1", url: "/api/repairs/r1/photos/p1" },
  { id: "p2", url: "/api/repairs/r1/photos/p2" },
];

const history: RepairHistory = {
  count: 3,
  totalCost: "63400",
  shiftsEquivalent: "5.3",
  repeated: true,
  items: [
    { id: "h1", closedAt: "2026-03-12T09:00:00.000Z", reason: "Замена балласта", outcome: "CLOSED", cost: "18900" },
    { id: "h2", closedAt: "2026-05-28T09:00:00.000Z", reason: "Сушка после дождя", outcome: "CLOSED", cost: "4200" },
    { id: "h3", closedAt: "2026-07-02T09:00:00.000Z", reason: "Замена разъёма", outcome: "CLOSED", cost: "40300" },
  ],
};

const workLog: RepairWorkLogEntry[] = [
  {
    id: "w1",
    repairId: "r1",
    description: "Разобрал, продул, просушил",
    timeSpentHours: "2",
    partCost: "2400",
    loggedBy: "u1",
    loggedAt: "2026-08-07T10:00:00.000Z",
    loggedByName: "Пётр Кузнецов",
  },
];

describe("RepairPhotoStrip", () => {
  it("открывает снимок с приёмки на весь экран", () => {
    render(<RepairPhotoStrip photos={photos} />);
    expect(screen.getAllByRole("button")).toHaveLength(2);

    fireEvent.click(screen.getByLabelText("Открыть снимок 1 из 2"));
    expect(screen.getByRole("dialog", { name: "Снимок поломки" })).toBeInTheDocument();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
  });

  it("без снимков объясняет, у кого их спрашивать, а не показывает пустоту", () => {
    render(<RepairPhotoStrip photos={[]} />);
    expect(screen.getByText(/Снимков с приёмки нет/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("RepairHistoryBlock", () => {
  it("технику показывает поводы для ремонтов, но ни одной суммы", () => {
    render(
      <RepairHistoryBlock
        history={history}
        currentReason="Не включается"
        currentCost="2400"
        showMoney={false}
      />,
    );
    expect(screen.getByText("Замена балласта")).toBeInTheDocument();
    expect(screen.queryByText(/63\s?400/)).toBeNull();
    expect(screen.queryByText(/18\s?900/)).toBeNull();
  });

  it("руководителю выводит итог в сменах аренды", () => {
    render(
      <RepairHistoryBlock
        history={history}
        currentReason="Не включается"
        currentCost="2400"
        showMoney
      />,
    );
    expect(screen.getByText(/5,3/)).toBeInTheDocument();
    expect(screen.getByText(/пора решать: чинить дальше или списывать/)).toBeInTheDocument();
  });

  it("без ставки аренды не выдумывает коэффициент", () => {
    render(
      <RepairHistoryBlock
        history={{ ...history, shiftsEquivalent: null }}
        currentReason="Не включается"
        currentCost="2400"
        showMoney
      />,
    );
    expect(screen.queryByText(/смен аренды/)).toBeNull();
    expect(screen.getByText(/в сменах не пересчитываем/)).toBeInTheDocument();
  });
});

describe("RepairCloseModal", () => {
  it("снятая галочка «Оценка работы» убирает её и из показанной суммы, и из расхода", () => {
    const onConfirm = vi.fn();
    render(
      <RepairCloseModal
        repair={makeRepair()}
        onConfirm={onConfirm}
        onSkip={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // 4,5 ч × 2000 ₽/ч = 9 000 ₽ оценки поверх 2 400 ₽ запчастей.
    expect(screen.getAllByText(/11\s?400/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("checkbox"));

    expect(screen.queryByText(/11\s?400/)).toBeNull();
    expect(screen.getAllByText(/2\s?400/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText("Создать расход и закрыть"));
    // Ключевая регрессия: наружу уходит 0, а не 9 000, которые человек снял.
    expect(onConfirm).toHaveBeenCalledWith(0);
  });
});

describe("RepairEtaCard", () => {
  it("«не знаю» снимает срок одним тапом, а не заставляет чистить поле", async () => {
    const onPatch = vi.fn().mockResolvedValue(undefined);
    render(
      <RepairEtaCard
        repair={makeRepair({ expectedReadyAt: "2026-08-18T00:00:00.000Z" })}
        editable
        onPatch={onPatch}
      />,
    );

    expect(screen.getByText("до 18 авг")).toBeInTheDocument();
    fireEvent.click(screen.getByText("не знаю"));
    await vi.waitFor(() => expect(onPatch).toHaveBeenCalledWith({ expectedReadyAt: null }));
  });

  it("без срока пишет честный пробел, а не выдуманную дату", () => {
    render(<RepairEtaCard repair={makeRepair()} editable={false} onPatch={vi.fn()} />);
    expect(screen.getByText("срок не назначен")).toBeInTheDocument();
    // Кладовщику срок не редактировать: полей ввода на карточке нет.
    expect(screen.queryByLabelText("Срок возврата")).toBeNull();
  });
});

describe("WorkLogList", () => {
  it("подписывает запись именем автора, а не его кодом", () => {
    render(<WorkLogList entries={workLog} showMoney={false} />);
    expect(screen.getByText(/Пётр Кузнецов/)).toBeInTheDocument();
    expect(screen.queryByText(/u1/)).toBeNull();
    expect(screen.queryByText(/2\s?400/)).toBeNull();
  });
});

describe("WorkLogComposer", () => {
  it("чип-заготовка заполняет описание, пресет задаёт часы", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<WorkLogComposer onSubmit={onSubmit} showMoney={false} autoStarts={false} />);

    fireEvent.click(screen.getByText("Заменил разъём"));
    expect(screen.getByLabelText("Что сделал")).toHaveValue("Заменил разъём");

    fireEvent.click(screen.getByText("0,5"));
    fireEvent.click(screen.getByText("Записать"));

    await vi.waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        description: "Заменил разъём",
        timeSpentHours: 0.5,
        partCost: 0,
      }),
    );
  });

  it("пустое описание не отправляется — такая запись ничего не сообщает", () => {
    const onSubmit = vi.fn();
    render(<WorkLogComposer onSubmit={onSubmit} showMoney={false} autoStarts={false} />);

    fireEvent.click(screen.getByText("Записать"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/Напишите, что сделали/)).toBeInTheDocument();
  });

  it("на невзятой карточке кнопка честно предупреждает о смене статуса", () => {
    render(<WorkLogComposer onSubmit={vi.fn()} showMoney={false} autoStarts />);
    expect(screen.getByText("Записать и взять в работу")).toBeInTheDocument();
  });

  it("поле стоимости запчасти есть только там, где видны суммы", () => {
    const { rerender } = render(
      <WorkLogComposer onSubmit={vi.fn()} showMoney={false} autoStarts={false} />,
    );
    expect(screen.queryByText("Запчасть, ₽:")).toBeNull();

    rerender(<WorkLogComposer onSubmit={vi.fn()} showMoney autoStarts={false} />);
    expect(screen.getByText("Запчасть, ₽:")).toBeInTheDocument();
  });
});
