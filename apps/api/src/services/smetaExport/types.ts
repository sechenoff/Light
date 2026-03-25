/** Унифицированная модель коммерческой сметы для PDF / XLSX. */
export type SmetaExportLine = {
  index: number;
  name: string;
  category: string;
  quantity: number;
  /** Цена за одну смену (24 ч) за единицу */
  pricePerShift: string;
  lineSum: string;
};

export type SmetaExportDocument = {
  documentTitleRu: string;
  documentTitleEn: string;
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
  lines: SmetaExportLine[];
  subtotal: string;
  discountPercent: string;
  discountAmount: string;
  totalAfterDiscount: string;
  currency: string;
};
