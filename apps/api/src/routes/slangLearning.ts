import express from "express";
import { z } from "zod";
import { prisma } from "../prisma";
import { norm } from "../services/equipmentMatcher";

const router = express.Router();

// ── POST /api/admin/slang-learning/propose ─────────────────────────────────────
// Called by the frontend when a user confirms an ambiguous match (needsReview)
// or manually maps an unrecognized phrase to a catalog item.
// Немедленно сохраняет SlangAlias (AUTO_LEARNED) и создаёт APPROVED кандидата для аудита.
//
// source values (inside contextJson):
//   "booking_review"             — manager picked from AI-suggested candidates
//   "manual_unmatched_learning"  — manager manually mapped an unrecognized phrase

const ProposeBody = z.object({
  rawPhrase: z.string().min(1).max(500),
  proposedEquipmentId: z.string().optional(),
  proposedEquipmentName: z.string().optional(),
  confidence: z.number().min(0).max(1).default(0.5),
  contextJson: z.string().optional(),
});

router.post("/propose", async (req, res, next) => {
  try {
    const body = ProposeBody.parse(req.body);
    const normalizedPhrase = norm(body.rawPhrase);

    // Если equipmentId передан — сразу upsert SlangAlias (авто-обучение)
    let alias = null;
    if (body.proposedEquipmentId) {
      // Проверяем конфликт: есть ли уже псевдоним для той же фразы с другим оборудованием
      const existingAliases = await prisma.slangAlias.findMany({
        where: { phraseNormalized: normalizedPhrase },
        select: { equipmentId: true },
      });

      const conflictExists = existingAliases.some(
        (a: { equipmentId: string }) => a.equipmentId !== body.proposedEquipmentId,
      );
      if (conflictExists) {
        console.warn(
          `[slangLearning] Конфликт псевдонима: фраза "${normalizedPhrase}" уже привязана к другому оборудованию. Добавляем как ещё один кандидат.`,
        );
      }

      alias = await prisma.slangAlias.upsert({
        where: {
          phraseNormalized_equipmentId: {
            phraseNormalized: normalizedPhrase,
            equipmentId: body.proposedEquipmentId,
          },
        },
        create: {
          phraseNormalized: normalizedPhrase,
          phraseOriginal: body.rawPhrase,
          equipmentId: body.proposedEquipmentId,
          confidence: body.confidence,
          source: "AUTO_LEARNED",
          usageCount: 1,
          lastUsedAt: new Date(),
        },
        update: {
          usageCount: { increment: 1 },
          lastUsedAt: new Date(),
        },
      });
    }

    // Создаём запись в очереди кандидатов со статусом APPROVED (аудит)
    const candidate = await prisma.slangLearningCandidate.create({
      data: {
        rawPhrase: body.rawPhrase,
        normalizedPhrase,
        proposedEquipmentId: body.proposedEquipmentId,
        proposedEquipmentName: body.proposedEquipmentName,
        confidence: body.confidence,
        contextJson: body.contextJson,
        status: "APPROVED",
        reviewedAt: new Date(),
        reviewedBy: "auto",
      },
    });

    return res.status(201).json({ alias, candidate, autoApproved: true });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/slang-learning/stats ──────────────────────────────────────
// Returns computed KPIs for the slang dictionary page.

router.get("/stats", async (req, res, next) => {
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const [totalAliases, autoLearnedThisWeek, pendingCount, manualCount] = await Promise.all([
      prisma.slangAlias.count(),
      prisma.slangAlias.count({
        where: {
          source: "AUTO_LEARNED",
          createdAt: { gte: sevenDaysAgo },
        },
      }),
      prisma.slangLearningCandidate.count({
        where: { status: "PENDING" },
      }),
      prisma.slangAlias.count({
        where: { source: "MANUAL_ADMIN" },
      }),
    ]);

    const accuracyPercent = totalAliases > 0
      ? Math.round(((totalAliases - manualCount) / totalAliases) * 100)
      : 0;

    return res.json({
      totalAliases,
      autoLearnedThisWeek,
      pendingCount,
      accuracyPercent,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/slang-learning ──────────────────────────────────────────────
// Returns learning candidates filtered by status (default: PENDING).

router.get("/", async (req, res, next) => {
  try {
    const statusParam = z.enum(["PENDING", "APPROVED", "REJECTED"]).default("PENDING").parse(req.query.status || undefined);
    const candidates = await prisma.slangLearningCandidate.findMany({
      where: { status: statusParam },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return res.json(candidates);
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/slang-learning/dictionary/export ───────────────────────────
// Плоский JSON-массив всех псевдонимов для импорта в бот.
// ВАЖНО: должен быть определён ДО /dictionary, иначе Express перехватит как /:id

router.get("/dictionary/export", async (req, res, next) => {
  try {
    const aliases = await prisma.slangAlias.findMany({
      include: { equipment: { select: { name: true, category: true } } },
      orderBy: { phraseNormalized: "asc" },
    });

    const result = (aliases as Array<{
      phraseNormalized: string;
      phraseOriginal: string;
      equipmentId: string;
      equipment: { name: string; category: string };
      source: string;
      confidence: number;
    }>).map((a) => ({
      phraseNormalized: a.phraseNormalized,
      phraseOriginal: a.phraseOriginal,
      equipmentId: a.equipmentId,
      equipmentName: a.equipment.name,
      source: a.source,
      confidence: a.confidence,
    }));

    return res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/slang-learning/dictionary ──────────────────────────────────
// Все псевдонимы, сгруппированные по оборудованию.
// ВАЖНО: должен быть определён ДО /:id/approve, но ПОСЛЕ /dictionary/export

router.get("/dictionary", async (req, res, next) => {
  try {
    const aliases = await prisma.slangAlias.findMany({
      include: { equipment: { select: { name: true, category: true } } },
      orderBy: { createdAt: "desc" },
    });

    // Группируем по equipmentId
    const grouped = new Map<
      string,
      { equipment: { id: string; name: string; category: string }; aliases: typeof aliases }
    >();

    for (const alias of aliases) {
      const existing = grouped.get(alias.equipmentId);
      if (existing) {
        existing.aliases.push(alias);
      } else {
        grouped.set(alias.equipmentId, {
          equipment: {
            id: alias.equipmentId,
            name: alias.equipment.name,
            category: alias.equipment.category,
          },
          aliases: [alias],
        });
      }
    }

    // Сортируем по количеству псевдонимов (по убыванию)
    const result = Array.from(grouped.values())
      .map((g) => ({ ...g, aliasCount: g.aliases.length }))
      .sort((a, b) => b.aliasCount - a.aliasCount);

    return res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/admin/slang-learning/:id/approve ────────────────────────────────
// Approves a candidate: creates/updates SlangAlias and marks it APPROVED.

const ApproveBody = z.object({
  reviewedBy: z.string().optional(),
  equipmentId: z.string().optional(), // admin may override the equipment
});

router.post("/:id/approve", async (req, res, next) => {
  try {
    const { id } = req.params;
    const body = ApproveBody.parse(req.body);

    const candidate = await prisma.slangLearningCandidate.findUniqueOrThrow({ where: { id } });

    const equipmentId = body.equipmentId ?? candidate.proposedEquipmentId;
    if (!equipmentId) {
      return res.status(400).json({ error: "equipmentId is required for approval" });
    }

    // Upsert SlangAlias
    await prisma.slangAlias.upsert({
      where: {
        phraseNormalized_equipmentId: {
          phraseNormalized: candidate.normalizedPhrase,
          equipmentId,
        },
      },
      create: {
        phraseNormalized: candidate.normalizedPhrase,
        phraseOriginal: candidate.rawPhrase,
        equipmentId,
        confidence: candidate.confidence,
        source: "MANUAL_ADMIN",
      },
      update: {
        confidence: candidate.confidence,
        updatedAt: new Date(),
      },
    });

    const updated = await prisma.slangLearningCandidate.update({
      where: { id },
      data: {
        status: "APPROVED",
        reviewedAt: new Date(),
        reviewedBy: body.reviewedBy ?? "admin",
        proposedEquipmentId: equipmentId,
      },
    });

    return res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/admin/slang-learning/:id/reject ─────────────────────────────────
// Rejects a candidate.

router.post("/:id/reject", async (req, res, next) => {
  try {
    const { id } = req.params;
    const reviewedBy = (req.body as any)?.reviewedBy ?? "admin";

    const updated = await prisma.slangLearningCandidate.update({
      where: { id },
      data: {
        status: "REJECTED",
        reviewedAt: new Date(),
        reviewedBy,
      },
    });

    return res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/slang-aliases ──────────────────────────────────────────────
// Returns the approved alias dictionary with equipment info.

router.get("/aliases", async (req, res, next) => {
  try {
    const aliases = await prisma.slangAlias.findMany({
      include: { equipment: { select: { name: true, category: true } } },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    return res.json(aliases);
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/admin/slang-aliases/:id ───────────────────────────────────────
// Removes an alias from the dictionary.

router.delete("/aliases/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    await prisma.slangAlias.delete({ where: { id } });
    return res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export { router as slangLearningRouter };
