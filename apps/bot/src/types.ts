import type { Scenes } from "telegraf";

export type EquipmentItem = {
  equipmentId: string;
  category: string;
  name: string;
  brand: string | null;
  model: string | null;
  stockTrackingMode: "COUNT" | "UNIT";
  totalQuantity: number;
  availableQuantity: number;
  rentalRatePerShift: string;
};

export type MatchedItem = {
  equipmentId: string;
  name: string;
  category: string;
  quantity: number;
  rentalRatePerShift: string;
  availableQuantity: number;
};

/** Промежуточное состояние сессии при создании брони */
export type BookingDraft = {
  step:
    | "client"
    | "project"
    | "dates"
    | "equipment_mode" // выбор способа ввода оборудования
    | "equipment"      // свободный ввод
    | "clarify"        // уточнение позиций, не найденных в каталоге
    | "catalog"        // пошаговый выбор по категориям
    | "edit_list"      // редактирование итогового списка
    | "edit_add"       // добавление позиции в режиме редактора
    | "confirm";
  clientName?: string;
  projectName?: string;
  /** Строка, введённая пользователем (для уточнений) */
  rawDates?: string;
  startDate?: string; // ISO
  endDate?: string;   // ISO
  /** Исходный текст запроса оборудования */
  rawEquipment?: string;
  items?: MatchedItem[];
  /** Позиции, которые не удалось найти в каталоге — ожидают уточнения */
  unmatchedText?: string;
  /** Сколько раз подряд не удавалось уточнить ненайденные позиции */
  clarifyAttempts?: number;
  comment?: string;
  /** Каталог, загруженный для пошагового режима */
  catalogItems?: EquipmentItem[];
  /** Список всех категорий (для пошагового режима) */
  catalogCategories?: string[];
  /** Текущая открытая категория (null = показываем список категорий) */
  catalogCategory?: string | null;
};

/** Строка сметы (зеркало EstimateLine из API) */
export type EstimateLine = {
  equipmentId: string;
  name: string;
  category: string;
  quantity: number;
  ratePerShift: string;
  lineTotal: string;
  isAnalog: boolean;
};

/** Смета (зеркало EstimateResult из API) */
export type EstimateResult = {
  lines: EstimateLine[];
  grandTotal: string;
  currency: "RUB";
  disclaimer: string;
};

/** Результат анализа фото, возвращаемый API */
export type PhotoAnalysisResult = {
  description: string;
  matchedEquipment: MatchedItem[];
  unmatchedNames: string[];
  /** Детализированная смета с разбивкой по строкам */
  estimate: EstimateResult;
  /** PNG диаграммы в base64; null если генерация недоступна */
  diagramBase64: string | null;
};

/** Промежуточное состояние сессии при анализе фото */
export type PhotoAnalysisDraft = {
  /** ID записи Analysis (PENDING) в БД */
  analysisId?: string;
  /** ID пользователя в БД */
  userId?: string;
  /** Путь к сохранённому файлу на storage */
  storagePath?: string;
  items?: MatchedItem[];
  /** Смета последнего анализа (для кнопок «Рассчитать», «Дешевле», «Премиум») */
  estimate?: EstimateResult;
};

export type BotContext = Scenes.SceneContext;

export type OpsExtractedTask = {
  title: string;
  description?: string;
  assigneeTelegramUserId?: string;
  coAssigneeTelegramUserIds?: string[];
  dueAt?: string;
  projectName?: string;
  priority?: number;
  confidence: number;
  needsConfirmation: boolean;
};

export type OpsRoleCandidate = {
  roleName: string;
  telegramUserId: string;
  confidence: number;
};

export type OpsMessageExtraction = {
  messageType:
    | "TASK"
    | "DECISION"
    | "QUESTION"
    | "RISK"
    | "DEADLINE"
    | "BLOCKER"
    | "REQUEST"
    | "CONFIRMATION"
    | "RESCHEDULE"
    | "EXECUTED"
    | "NOT_EXECUTED"
    | "OTHER";
  messageTypeConfidence: number;
  entities: {
    projects: string[];
    people: string[];
    departments: string[];
    deadlines: string[];
    dependencies: string[];
    priorities: string[];
  };
  task?: OpsExtractedTask;
  roleCandidates: OpsRoleCandidate[];
  isUnresolvedDiscussion?: boolean;
  discussionTopic?: string;
};
