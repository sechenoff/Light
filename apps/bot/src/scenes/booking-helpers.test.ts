import { describe, it, expect } from 'vitest';
import {
  DISCOUNT,
  today,
  fmtItem,
  fmtList,
  totalCost,
  fmtPrice,
  buildItems,
  mergeItems,
} from './booking-helpers';
import type { MatchedItem } from '../types';

// ── Вспомогательные данные ──────────────────────────────────────────────────

function makeItem(overrides: Partial<MatchedItem> = {}): MatchedItem {
  return {
    equipmentId: 'eq-1',
    name: 'Aputure 600D',
    category: 'Источники света',
    quantity: 1,
    rentalRatePerShift: '5000',
    availableQuantity: 3,
    ...overrides,
  };
}

// ── DISCOUNT ────────────────────────────────────────────────────────────────

describe('DISCOUNT', () => {
  it('равен 0.5', () => {
    expect(DISCOUNT).toBe(0.5);
  });
});

// ── today ────────────────────────────────────────────────────────────────────

describe('today', () => {
  it('возвращает строку формата YYYY-MM-DD', () => {
    const result = today();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ── fmtItem ──────────────────────────────────────────────────────────────────

describe('fmtItem', () => {
  it('форматирует позицию с маркером "•" если индекс не указан', () => {
    const item = makeItem({ name: 'Nanlite Forza 500', quantity: 2, rentalRatePerShift: '3000' });
    expect(fmtItem(item)).toBe('• Nanlite Forza 500 × 2 шт — 3\u00a0000 ₽/смена');
  });

  it('форматирует позицию с порядковым номером если указан индекс 0', () => {
    const item = makeItem({ name: 'Aputure 600D', quantity: 1, rentalRatePerShift: '5000' });
    expect(fmtItem(item, 0)).toBe('1. Aputure 600D × 1 шт — 5\u00a0000 ₽/смена');
  });

  it('форматирует позицию с порядковым номером 3 при индексе 2', () => {
    const item = makeItem({ name: 'DJI RS3', quantity: 1, rentalRatePerShift: '2000' });
    expect(fmtItem(item, 2)).toBe('3. DJI RS3 × 1 шт — 2\u00a0000 ₽/смена');
  });
});

// ── fmtList ──────────────────────────────────────────────────────────────────

describe('fmtList', () => {
  it('возвращает пустую строку для пустого списка', () => {
    expect(fmtList([])).toBe('');
  });

  it('форматирует несколько позиций с маркерами "•" по умолчанию', () => {
    const items = [
      makeItem({ name: 'Aputure 600D', quantity: 1, rentalRatePerShift: '5000' }),
      makeItem({ equipmentId: 'eq-2', name: 'Godox SL200', quantity: 2, rentalRatePerShift: '2500' }),
    ];
    const result = fmtList(items);
    expect(result).toContain('• Aputure 600D');
    expect(result).toContain('• Godox SL200');
  });

  it('форматирует с номерами при numbered=true', () => {
    const items = [
      makeItem({ name: 'Aputure 600D', quantity: 1, rentalRatePerShift: '5000' }),
      makeItem({ equipmentId: 'eq-2', name: 'Godox SL200', quantity: 2, rentalRatePerShift: '2500' }),
    ];
    const result = fmtList(items, true);
    expect(result).toContain('1. Aputure 600D');
    expect(result).toContain('2. Godox SL200');
    expect(result).not.toContain('•');
  });
});

// ── totalCost ────────────────────────────────────────────────────────────────

describe('totalCost', () => {
  it('считает стоимость за 1 день при разнице 1 сутки', () => {
    const item = makeItem({ quantity: 1, rentalRatePerShift: '5000' });
    const cost = totalCost([item], '2024-04-10', '2024-04-11');
    expect(cost).toBe(5000);
  });

  it('считает стоимость за несколько дней', () => {
    const item = makeItem({ quantity: 2, rentalRatePerShift: '3000' });
    // 3 дня
    const cost = totalCost([item], '2024-04-10', '2024-04-13');
    expect(cost).toBe(2 * 3000 * 3);
  });

  it('возвращает 0 для пустого списка', () => {
    const cost = totalCost([], '2024-04-10', '2024-04-11');
    expect(cost).toBe(0);
  });

  it('минимум 1 день когда start === end', () => {
    const item = makeItem({ quantity: 1, rentalRatePerShift: '4000' });
    const cost = totalCost([item], '2024-04-10', '2024-04-10');
    expect(cost).toBe(4000);
  });

  it('суммирует стоимость нескольких позиций', () => {
    const items = [
      makeItem({ quantity: 1, rentalRatePerShift: '5000' }),
      makeItem({ equipmentId: 'eq-2', quantity: 2, rentalRatePerShift: '2000' }),
    ];
    // 1 день
    const cost = totalCost(items, '2024-04-10', '2024-04-11');
    expect(cost).toBe(5000 + 2 * 2000);
  });
});

// ── fmtPrice ─────────────────────────────────────────────────────────────────

describe('fmtPrice', () => {
  it('форматирует целое значение правильно', () => {
    const result = fmtPrice(10000);
    expect(result).toContain('10\u00a0000');
    expect(result).toContain('5\u00a0000'); // 50% скидка
  });

  it('округляет скидочную цену', () => {
    // 10001 * 0.5 = 5000.5, округляется до 5001
    const result = fmtPrice(10001);
    expect(result).toContain('5\u00a0001');
  });

  it('содержит оба ценовых блока', () => {
    const result = fmtPrice(8000);
    expect(result).toContain('Полная стоимость');
    expect(result).toContain('Со скидкой 50%');
  });
});

// ── buildItems ────────────────────────────────────────────────────────────────

describe('buildItems', () => {
  const resolved = [
    {
      equipmentId: 'eq-1',
      quantity: 2,
      catalogName: 'Aputure 600D',
      category: 'Источники света',
      availableQuantity: 3,
      rentalRatePerShift: '5000',
    },
  ];

  it('строит MatchedItem[] из resolved данных', () => {
    const result = buildItems(resolved);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      equipmentId: 'eq-1',
      name: 'Aputure 600D',
      quantity: 2,
    });
  });

  it('фильтрует позиции с quantity=0', () => {
    const result = buildItems([{ ...resolved[0]!, quantity: 0 }]);
    expect(result).toHaveLength(0);
  });

  it('ограничивает quantity по availableQuantity', () => {
    const result = buildItems([{
      equipmentId: 'eq-2', quantity: 10, catalogName: 'Godox SL200',
      category: 'Источники света', availableQuantity: 2, rentalRatePerShift: '2500',
    }]);
    expect(result[0]!.quantity).toBe(2);
  });

  it('возвращает пустой массив для пустого входа', () => {
    const result = buildItems([]);
    expect(result).toHaveLength(0);
  });
});

// ── mergeItems ────────────────────────────────────────────────────────────────

describe('mergeItems', () => {
  it('объединяет совпадающие позиции суммируя количество', () => {
    const existing = [makeItem({ equipmentId: 'eq-1', quantity: 1, availableQuantity: 5 })];
    const incoming = [makeItem({ equipmentId: 'eq-1', quantity: 2, availableQuantity: 5 })];
    const result = mergeItems(existing, incoming);
    expect(result).toHaveLength(1);
    expect(result[0]!.quantity).toBe(3);
  });

  it('ограничивает итоговое количество по availableQuantity', () => {
    const existing = [makeItem({ equipmentId: 'eq-1', quantity: 2, availableQuantity: 3 })];
    const incoming = [makeItem({ equipmentId: 'eq-1', quantity: 3, availableQuantity: 3 })];
    const result = mergeItems(existing, incoming);
    expect(result[0]!.quantity).toBe(3); // cap at availableQuantity
  });

  it('добавляет новые позиции из incoming', () => {
    const existing = [makeItem({ equipmentId: 'eq-1', quantity: 1, availableQuantity: 5 })];
    const incoming = [makeItem({ equipmentId: 'eq-2', name: 'Godox SL200', quantity: 1, availableQuantity: 2 })];
    const result = mergeItems(existing, incoming);
    expect(result).toHaveLength(2);
  });

  it('возвращает копию existing если incoming пуст', () => {
    const existing = [makeItem({ quantity: 2 })];
    const result = mergeItems(existing, []);
    expect(result).toHaveLength(1);
    expect(result[0]!.quantity).toBe(2);
  });

  it('возвращает копию incoming если existing пуст', () => {
    const incoming = [makeItem({ quantity: 1 })];
    const result = mergeItems([], incoming);
    expect(result).toHaveLength(1);
  });

  it('не мутирует исходные массивы', () => {
    const existing = [makeItem({ equipmentId: 'eq-1', quantity: 1, availableQuantity: 5 })];
    const incoming = [makeItem({ equipmentId: 'eq-1', quantity: 2, availableQuantity: 5 })];
    mergeItems(existing, incoming);
    expect(existing[0]!.quantity).toBe(1); // не изменился
  });
});
