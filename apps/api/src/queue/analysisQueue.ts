import { Queue } from "bullmq";

export const ANALYSIS_QUEUE_NAME = "analysis";

/** Данные, передаваемые в job при постановке в очередь */
export type AnalysisJobData = {
  analysisId: string;
  storagePath: string;
  mimeType: string;
};

/** Результат успешно выполненного job */
export type AnalysisJobResult = {
  analysisId: string;
  description: string;
};

// Lazy singleton — Queue создаётся только при первом вызове enqueueAnalysis,
// чтобы не инициализировать Redis-соединение при старте если Redis недоступен.
let _queue: Queue<AnalysisJobData, AnalysisJobResult> | null = null;

function getQueue(): Queue<AnalysisJobData, AnalysisJobResult> {
  if (!_queue) {
    // Динамически подтягиваем connection только при реальном использовании
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { redisConnection } = require("./connection") as { redisConnection: InstanceType<typeof import("ioredis").default> };
    _queue = new Queue<AnalysisJobData, AnalysisJobResult>(ANALYSIS_QUEUE_NAME, {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2_000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
      },
    });
  }
  return _queue;
}

/**
 * Ставит задачу анализа в очередь.
 * Вызывается сразу после успешного сохранения файла через storage service.
 */
export async function enqueueAnalysis(data: AnalysisJobData): Promise<string> {
  const job = await getQueue().add("analyze", data, {
    jobId: `analysis_${data.analysisId}`,
  });
  return job.id ?? data.analysisId;
}
