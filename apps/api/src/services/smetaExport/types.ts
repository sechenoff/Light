/** Унифицированная модель коммерческой сметы для PDF / XLSX. */
export type SmetaExportLine = {
  index: number;
  name: string;
  category: string;
  quantity: number;
  /** Цена за одну смену (24 ч) за единицу */
  pricePerShift: string;
  lineSum: string;
  /**
   * Прайсовая цена за смену — заполнена только там, где о цене договорились
   * отдельно. Печатается под названием как «персональная скидка · цена до
   * скидки N ₽»: уступка остаётся видимой, как и общая процентная скидка.
   */
  listPricePerShift?: string | null;
};

/**
 * Реквизиты организации в шапке документа. Все поля опциональны:
 * незаполненное в настройках не печатаем (не выдумываем плейсхолдеры
 * на клиентском документе).
 */
export type SmetaOrgInfo = {
  name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  inn: string | null;
  kpp: string | null;
  /** Реквизиты для оплаты. Смета — платёжный документ: сумма к оплате без
   *  указания счёта заставляла заказчика идти за ними отдельным письмом. */
  bankName: string | null;
  bankBik: string | null;
  rschet: string | null;
  kschet: string | null;
};

export type SmetaExportDocument = {
  documentTitleRu: string;
  documentTitleEn: string;
  /** Номер документа «СМ-2026-0001». null — бронь до введения нумерации. */
  docNumber: string | null;
  /** Дата составления документа. Не «сегодня»: иначе один и тот же документ,
   *  скачанный дважды, выглядит по-разному и теряет силу как платёжный. */
  issuedAtLabel: string;
  /** «до 15 августа 2026» — срок оплаты. null — не задан. */
  paymentDueLabel: string | null;
  issueDateLabel: string;
  returnDateLabel: string;
  loadOutTimeLabel: string;
  returnLoadTimeLabel: string;
  hourCalculationText: string;
  clientName: string;
  projectName: string;
  comment: string | null;
  optionalNote: string | null;
  includeOptionalInExport: boolean;
  /** Смен в периоде — для строки «Смены» в реквизитах документа. */
  shiftsCount: number;
  org: SmetaOrgInfo | null;
  lines: SmetaExportLine[];
  subtotal: string;
  /**
   * Сумма прайсовых строк — база, от которой считается процентная скидка.
   * Заполняется только когда в смете есть договорные позиции: иначе база
   * совпадает с subtotal и лишняя строка в документе не нужна.
   */
  listedSubtotal?: string | null;
  /** Сумма договорных строк — процент к ним не применяется. */
  negotiatedSubtotal?: string | null;
  discountPercent: string;
  discountAmount: string;
  totalAfterDiscount: string;
  currency: string;
};

/** Строка транспортного блока полной сметы (одна машина брони). */
export type SmetaTransportLine = {
  name: string;
  /** Краткие параметры: «+ генератор · смена 12 ч · за МКАД 40 км». */
  details: string | null;
  sum: string;
};

export type SmetaTransportSection = {
  lines: SmetaTransportLine[];
  subtotal: string;
};

/** Полная смета: основная + (опционально) доб-смета + (опционально) транспорт. */
export type SmetaFullExportDocument = {
  main: SmetaExportDocument;
  addon: SmetaExportDocument | null;
  transport: SmetaTransportSection | null;
  /** Финальная сумма к оплате = main + addon + transport (для итоговой строки). */
  grandTotal: string;
  /**
   * Согласованная вручную сумма брони. Когда задана — платить по ней, а не по
   * расчёту: о ней договорились. Расчётная сумма при этом остаётся на листе
   * отдельной строкой, чтобы разница была видна, а не спрятана в цифре.
   */
  agreedTotal?: string | null;
};
