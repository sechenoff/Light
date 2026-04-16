export type SlangAlias = {
  id: string;
  phraseNormalized: string;
  phraseOriginal: string;
  equipmentId: string;
  confidence: number;
  source: "AUTO_LEARNED" | "MANUAL_ADMIN" | "SEED";
  createdAt: string;
  usageCount: number;
  lastUsedAt: string;
  equipment: { name: string; category: string };
};

export type DictionaryGroup = {
  equipment: { id: string; name: string; category: string };
  aliases: SlangAlias[];
  aliasCount: number;
};

export type SlangCandidate = {
  id: string;
  rawPhrase: string;
  normalizedPhrase: string;
  proposedEquipmentId: string | null;
  proposedEquipmentName: string | null;
  confidence: number;
  contextJson: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED";
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
};

export type SlangStats = {
  totalAliases: number;
  autoLearnedThisWeek: number;
  pendingCount: number;
  accuracyPercent: number;
};

export type SourceFilterKey = "all" | "auto" | "manual" | "seed";

export type EquipmentSearchResult = {
  id: string;
  name: string;
  category: string;
};
