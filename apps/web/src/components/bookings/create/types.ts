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

/** Response from POST /api/bookings/quote */
export type QuoteResponse = {
  shifts: number;
  totalHours?: number;
  durationLabel?: string;
  subtotal: string;
  discountPercent: string;
  discountAmount: string;
  totalAfterDiscount: string;
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

/** Validation check item shown in SummaryPanel */
export type ValidationCheck = {
  type: "ok" | "warn" | "tip";
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
};

/** Off-catalog item (AI-unmatched that user kept, or free-text add) */
export type OffCatalogItem = {
  tempId: string;  // client-generated uuid
  name: string;
  quantity: number;
};

/** Ephemeral flags for catalog rows after date change */
export type CatalogRowAdjustment =
  | { kind: "ok" }
  | { kind: "clampedDown"; previousQty: number; newQty: number }
  | { kind: "unavailable" };
