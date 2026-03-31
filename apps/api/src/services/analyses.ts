import Decimal from "decimal.js";
import { prisma } from "../prisma";
import type { Analysis } from "@prisma/client";

export type CreatePendingAnalysisInput = {
  userId: string;
  telegramFileId: string;
  telegramMimeType: string;
};

/**
 * Создаёт запись Analysis со статусом PENDING.
 * AI-поля (description, equipmentJson, estimatePerShift) заполняются позже.
 */
export async function createPendingAnalysis(
  input: CreatePendingAnalysisInput,
): Promise<Analysis> {
  return prisma.analysis.create({
    data: {
      userId: input.userId,
      telegramFileId: input.telegramFileId,
      telegramMimeType: input.telegramMimeType,
      status: "PENDING",
    },
  });
}

/**
 * Сохраняет storagePath после успешной загрузки файла.
 */
export async function setStoragePath(id: string, storagePath: string): Promise<void> {
  await prisma.analysis.update({
    where: { id },
    data: { storagePath },
  });
}

/**
 * Помечает Analysis как PROCESSING — воркер взял job в работу.
 */
export async function setProcessing(id: string): Promise<void> {
  await prisma.analysis.update({
    where: { id },
    data: { status: "PROCESSING" },
  });
}

export type CompleteAnalysisInput = {
  /** Текст вероятной реконструкции от провайдера */
  description: string;
  /** Сериализованный массив SuggestedEquipmentItem[] */
  equipmentJson: string;
  /** Ориентировочная стоимость за 1 смену (считается в роуте после матчинга с каталогом) */
  estimatePerShift: number;
};

/**
 * Обновляет Analysis результатами AI-анализа и устанавливает статус DONE.
 */
export async function completeAnalysis(
  id: string,
  data: CompleteAnalysisInput,
): Promise<void> {
  await prisma.analysis.update({
    where: { id },
    data: {
      status: "DONE",
      description: data.description,
      equipmentJson: data.equipmentJson,
      estimatePerShift: new Decimal(data.estimatePerShift),
    },
  });
}

/**
 * Помечает Analysis как FAILED с опциональным сообщением об ошибке.
 */
export async function failAnalysis(id: string, reason?: string): Promise<void> {
  await prisma.analysis.update({
    where: { id },
    data: {
      status: "FAILED",
      description: reason ?? null,
    },
  });
}
