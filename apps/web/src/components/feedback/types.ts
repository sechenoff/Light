// Серверные enum-значения дублируются на клиенте, чтобы не тянуть @prisma/client в web.
// Источник истины — apps/api/prisma/schema.prisma.

export type FeedbackCategory = "BUG" | "IDEA" | "COMMENT";
export type FeedbackStatus = "NEW" | "IN_PROGRESS" | "DONE" | "REJECTED";

export interface FeedbackUserRef {
  id: string;
  username: string;
}

export interface FeedbackListItem {
  id: string;
  category: FeedbackCategory;
  status: FeedbackStatus;
  title: string;
  description: string;
  pageUrl: string | null;
  createdBy: string;
  createdByUser: FeedbackUserRef | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  commentCount: number;
  photoCount: number;
}

export interface FeedbackComment {
  id: string;
  body: string;
  authorId: string;
  authorUser: FeedbackUserRef | null;
  createdAt: string;
}

export interface FeedbackPhoto {
  id: string;
  url: string;
  createdAt: string;
  createdBy: string;
}

export interface FeedbackDetail extends FeedbackListItem {
  viewport: string | null;
  userAgent: string | null;
  resolvedBy: string | null;
  resolvedByUser: FeedbackUserRef | null;
  comments: FeedbackComment[];
  photos: FeedbackPhoto[];
}

export interface FeedbackStats {
  newCount: number;
  inProgressCount: number;
  openCount: number;
  total: number;
}

export const CATEGORY_META: Record<
  FeedbackCategory,
  { label: string; emoji: string; description: string }
> = {
  BUG: { label: "Поломка", emoji: "🐛", description: "Что-то сломано или работает не так" },
  IDEA: { label: "Идея", emoji: "💡", description: "Предложение по улучшению" },
  COMMENT: { label: "Комментарий", emoji: "💬", description: "Вопрос или общая мысль" },
};

export const STATUS_META: Record<
  FeedbackStatus,
  { label: string; variant: "ok" | "info" | "warn" | "none" | "alert" }
> = {
  NEW: { label: "Новое", variant: "info" },
  IN_PROGRESS: { label: "В работе", variant: "warn" },
  DONE: { label: "Сделано", variant: "ok" },
  REJECTED: { label: "Отклонено", variant: "none" },
};
