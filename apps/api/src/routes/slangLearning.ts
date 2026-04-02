import express from "express";
import { z } from "zod";
import { prisma } from "../prisma";
import { norm } from "../services/equipmentMatcher";

const router = express.Router();

// ── POST /api/admin/slang-learning/propose ─────────────────────────────────────
// Called by the frontend when a user confirms an ambiguous match (needsReview)
// or manually maps an unrecognized phrase to a catalog item.
// Creates a PENDING candidate in the learning queue.
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

    // For manual mappings (confidence === 1.0) reject if an APPROVED alias
    // already exists for the exact same phrase+equipment pair to avoid noise.
    if (body.proposedEquipmentId && body.confidence >= 1.0) {
      const approvedAlias = await prisma.slangAlias.findFirst({
        where: { phraseNormalized: normalizedPhrase, equipmentId: body.proposedEquipmentId },
      });
      if (approvedAlias) {
        return res.json({ id: approvedAlias.id, alreadyApproved: true });
      }
    }

    // Avoid duplicate PENDING candidates for the same phrase+equipment
    const existing = await prisma.slangLearningCandidate.findFirst({
      where: {
        normalizedPhrase,
        proposedEquipmentId: body.proposedEquipmentId ?? null,
        status: "PENDING",
      },
    });

    if (existing) {
      // If the incoming request is more confident (manual > AI), update confidence
      if (body.confidence > existing.confidence) {
        const updated = await prisma.slangLearningCandidate.update({
          where: { id: existing.id },
          data: { confidence: body.confidence, contextJson: body.contextJson ?? existing.contextJson },
        });
        return res.json({ ...updated, duplicate: true });
      }
      return res.json({ id: existing.id, duplicate: true });
    }

    const candidate = await prisma.slangLearningCandidate.create({
      data: {
        rawPhrase: body.rawPhrase,
        normalizedPhrase,
        proposedEquipmentId: body.proposedEquipmentId,
        proposedEquipmentName: body.proposedEquipmentName,
        confidence: body.confidence,
        contextJson: body.contextJson,
      },
    });

    return res.status(201).json(candidate);
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/slang-learning ──────────────────────────────────────────────
// Returns learning candidates filtered by status (default: PENDING).

router.get("/", async (req, res, next) => {
  try {
    const status = (req.query.status as string) || "PENDING";
    const candidates = await prisma.slangLearningCandidate.findMany({
      where: { status: status as any },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return res.json(candidates);
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
