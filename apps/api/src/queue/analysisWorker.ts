import fs from "fs/promises";
import path from "path";
import { Worker, type Job } from "bullmq";
import { redisConnection } from "./connection";
import { ANALYSIS_QUEUE_NAME, type AnalysisJobData, type AnalysisJobResult } from "./analysisQueue";
import { setProcessing, completeAnalysis, failAnalysis } from "../services/analyses";
import { storageService, LocalStorageService } from "../services/storage";
import { visionProvider } from "../services/vision";
import { matchEquipmentToInventory } from "../services/equipmentMatcher";
import { buildEstimate } from "../services/estimateCalculator";

/**
 * Обрабатывает один job анализа освещения.
 *
 * Шаги:
 *  1. Пометить Analysis как PROCESSING
 *  2. Прочитать файл из storage
 *  3. Вызвать vision-провайдер (сейчас — mock или Gemini через VISION_PROVIDER)
 *  4. Сопоставить с каталогом и посчитать смету
 *  5. Сохранить результат → DONE
 *
 * При броске ошибки BullMQ автоматически повторяет job согласно backoff-стратегии.
 */
async function processAnalysisJob(
  job: Job<AnalysisJobData, AnalysisJobResult>,
): Promise<AnalysisJobResult> {
  const { analysisId, storagePath, mimeType } = job.data;

  // ── Шаг 1: PROCESSING ────────────────────────────────────────────────────────
  await setProcessing(analysisId);
  await job.updateProgress(10);

  // ── Шаг 2: Загрузить файл из storage ─────────────────────────────────────────
  let imageBuffer: Buffer;
  try {
    imageBuffer = await storageService.read(storagePath);
  } catch (err) {
    // Файл не найден — повтор не поможет, сразу FAILED
    const reason = `Файл не найден в storage: ${storagePath}`;
    await failAnalysis(analysisId, reason);
    throw new Error(reason);
  }
  await job.updateProgress(25);

  // ── Шаг 3: Vision-провайдер ───────────────────────────────────────────────────
  const lightingAnalysis = await visionProvider.analyzePhoto({ imageBuffer, mimeType });
  await job.updateProgress(60);

  // ── Шаг 4: Сопоставить с каталогом и рассчитать смету ───────────────────────
  const matchResult = await matchEquipmentToInventory(lightingAnalysis.equipment);
  const estimate = buildEstimate(matchResult.matched);
  await job.updateProgress(80);

  // ── Шаг 5: DONE ───────────────────────────────────────────────────────────────
  await completeAnalysis(analysisId, {
    description: lightingAnalysis.description,
    equipmentJson: JSON.stringify({ matched: matchResult.matched, estimate }),
    estimatePerShift: Number(estimate.grandTotal),
  });
  await job.updateProgress(100);

  // ── Шаг 6: Удалить файл с диска после успешной обработки ─────────────────────
  if (storageService instanceof LocalStorageService) {
    const fullPath = storageService.fullPath(storagePath);
    await fs.unlink(fullPath).catch(() => {/* файл уже удалён — не критично */});
  }

  return { analysisId, description: lightingAnalysis.description };
}

// ── Worker ────────────────────────────────────────────────────────────────────

export function createAnalysisWorker(): Worker<AnalysisJobData, AnalysisJobResult> {
  const worker = new Worker<AnalysisJobData, AnalysisJobResult>(
    ANALYSIS_QUEUE_NAME,
    processAnalysisJob,
    {
      connection: redisConnection,
      concurrency: 2, // максимум 2 параллельных анализа
    },
  );

  worker.on("active", (job) => {
    // eslint-disable-next-line no-console
    console.log(`[worker] started  job=${job.id} analysisId=${job.data.analysisId}`);
  });

  worker.on("completed", (job) => {
    // eslint-disable-next-line no-console
    console.log(`[worker] done     job=${job.id} analysisId=${job.data.analysisId}`);
  });

  worker.on("failed", async (job, err) => {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    const allRetriesExhausted = job.attemptsMade >= maxAttempts;

    // eslint-disable-next-line no-console
    console.error(
      `[worker] failed   job=${job.id} attempt=${job.attemptsMade}/${maxAttempts} err=${err.message}`,
    );

    if (allRetriesExhausted) {
      // Все ретраи исчерпаны — помечаем запись как FAILED в БД
      await failAnalysis(job.data.analysisId, err.message).catch(() => {});
    }
  });

  worker.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("[worker] error:", err.message);
  });

  return worker;
}
