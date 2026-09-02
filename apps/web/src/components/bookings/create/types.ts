/** Candidate match from AI parse response */
export type GafferCandidate = {
  equipmentId: string;
  catalogName: string;
  category: string;
  availableQuantity: number;
  rentalRatePerShift: string;
  confidence: number;
};

/** 3-tier match discriminated union */
export type GafferOrderedMatch =
  | {
      kind: "resolved";
      equipmentId: string;
      catalogName: string;
      category: string;
      availableQuantity: number;
      rentalRatePerShift: string;
      confidence: number;
    }
  | { kind: "needsReview"; candidates: GafferCandidate[] }
  | { kind: "unmatched" };

/** Single item from POST /api/bookings/parse-gaffer-review */
export type GafferReviewApiItem = {
  id: string;
  gafferPhrase: string;
  interpretedName: string;
  quantity: number;
  match: GafferOrderedMatch;
};

/** Response from POST /api/bookings/parse-gaffer-review */
export type GafferReviewApiResponse = {
  items: GafferReviewApiItem[];
  message?: string;
};

/** Vehicle row from GET /api/vehicles */
export type VehicleRow = {
  id: string;
  slug: string;
  name: string;
  shiftPriceRub: string;
  hasGeneratorOption: boolean;
  generatorPriceRub: string | null;
  shiftHours: number;
  overtimePercent: string;
  displayOrder: number;
};

/** Transport breakdown from quote response */
export type TransportBreakdown = {
  vehicleId: string;
  vehicleName: string;
  shiftRate: string;
  overtime: string;
  overtimeHours: number;
  km: string;
  ttk: string;
  /** Итог по машине: договорной, если задан, иначе расчётный. */
  total: string;
  /** Сумма по прайсу и параметрам — до договорной замены. */
  listTotal?: string;
  isNegotiated?: boolean;
};

/** Per-vehicle config on the booking form (multi-vehicle) */
export type SelectedVehicle = {
  vehicleId: string;
  withGenerator: boolean;
  shiftHours: number;
  skipOvertime: boolean;
  kmOutsideMkad: number;
  ttkEntry: boolean;
  /** Договорная сумма за машину; null — считаем по прайсу. */
  negotiatedTotalRub?: number | null;
};

/** Response from POST /api/bookings/quote */
export type QuoteResponse = {
  shifts: number;
  totalHours?: number;
  durationLabel?: string;
  // Equipment fields
  equipmentSubtotal?: string;
  equipmentDiscount?: string;
  equipmentTotal?: string;
  // Legacy aliases (backward compat)
  subtotal: string;
  discountPercent: string;
  discountAmount: string;
  totalAfterDiscount: string;
  /** Сумма прайсовых строк — база, на которую начисляется процент. */
  listedSubtotal?: string;
  /** Сумма договорных строк — процент к ним не применяется. */
  negotiatedSubtotal?: string;
  // Transport — array of per-vehicle breakdowns (empty when none) + summed subtotal
  transport?: TransportBreakdown[] | null;
  transportSubtotal?: string;
  grandTotal?: string;
  lines: Array<{
    equipmentId: string;
    categorySnapshot: string;
    nameSnapshot: string;
    brandSnapshot: string | null;
    modelSnapshot: string | null;
    quantity: number;
    pricingMode: string;
    unitPrice: string;
    lineSum: string;
  }>;
};

/** Availability row from GET /api/availability */
export type AvailabilityRow = {
  equipmentId: string;
  category: string;
  name: string;
  brand: string | null;
  model: string | null;
  stockTrackingMode: "COUNT" | "UNIT";
  totalQuantity: number;
  rentalRatePerShift: string;
  occupiedQuantity: number;
  availableQuantity: number;
  availability: "UNAVAILABLE" | "PARTIAL" | "AVAILABLE";
  comment: string | null;
};

/** Validation check item shown in SummaryPanel.
 *  "todo" — обязательное требование ещё не выполнено (нейтральная подсказка);
 *  "error" — то же требование после попытки сохранить (rose, шаг подсвечен). */
export type ValidationCheck = {
  type: "ok" | "warn" | "tip" | "todo" | "error";
  label: string;
  detail: string;
  actionLabel?: string;
  actionHref?: string;
};

/** Catalog-first selection state (in catalog) */
export type CatalogSelectedItem = {
  equipmentId: string;
  name: string;
  category: string;
  quantity: number;
  dailyPrice: string;       // Decimal string from API
  availableQuantity: number; // latest availability from catalog fetch
  /**
   * Договорная ставка за смену: цена, о которой сговорились с заказчиком.
   * null — считаем по прайсу (`dailyPrice`). Процентная скидка брони к ней
   * не применяется — она уже финальная.
   */
  negotiatedRatePerShift?: number | null;
};

/** Off-catalog item (AI-unmatched that user kept, or free-text add) */
export type OffCatalogItem = {
  tempId: string;  // client-generated uuid
  name: string;
  quantity: number;
};

/** Custom (non-catalog) line item added manually by the user */
export type CustomItem = {
  tempId: string;       // client-generated, e.g. `custom-${Date.now()}-${Math.random()}`
  name: string;
  unitPrice: number;    // ₽ за всю бронь (не за смену)
  quantity: number;
};

/** Ephemeral flags for catalog rows after date change */
export type CatalogRowAdjustment =
  | { kind: "ok" }
  | { kind: "clampedDown"; previousQty: number; newQty: number }
  | { kind: "unavailable" };

/** Single item in the AI review panel — one per line parsed from gaffer text. */
export type PendingReviewItem = {
  reviewId: string;           // Unique (= gaffer response.items[i].id)
  gafferPhrase: string;
  interpretedName: string;
  quantity: number;
  /** Discriminated union mirroring GafferOrderedMatch. */
  match: GafferOrderedMatch;
};

/** Шапка заявки-документа, прочитанная AI (POST /api/bookings/parse-gaffer-document) */
export type GafferDocumentMeta = {
  projectName: string | null;
  gafferName: string | null;
  phone: string | null;
  email: string | null;
  telegram: string | null;
  /** YYYY-MM-DD */
  startDate: string | null;
  endDate: string | null;
  fileName: string;
};

/** Клиент из базы, подобранный по контактам из заявки */
export type GafferDocumentClientMatch = {
  id: string;
  name: string;
  phone: string | null;
  matchedBy: "phone" | "email" | "name";
};

/** Response from POST /api/bookings/parse-gaffer-document */
export type GafferDocumentApiResponse = {
  items: GafferReviewApiItem[];
  document: GafferDocumentMeta;
  client: GafferDocumentClientMatch | null;
  message?: string;
};
