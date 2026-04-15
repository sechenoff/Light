import { Router, RequestHandler } from "express";
import { z } from "zod";
import { prisma } from "../prisma";
import { rolesGuard } from "../middleware/rolesGuard";

const router = Router();

const querySchema = z.object({
  entityType: z.string().optional(),
  userId: z.string().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to:   z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

const listAudit: RequestHandler = async (req, res, next) => {
  try {
    const q = querySchema.parse(req.query);
    const where: Record<string, unknown> = {};
    if (q.entityType) where.entityType = q.entityType;
    if (q.userId)     where.userId     = q.userId;
    if (q.from || q.to) {
      const createdAt: Record<string, Date> = {};
      if (q.from) createdAt.gte = new Date(q.from);
      if (q.to)   createdAt.lte = new Date(q.to);
      where.createdAt = createdAt;
    }
    const rows = await prisma.auditEntry.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { user: { select: { id: true, username: true, role: true } } },
    });
    let nextCursor: string | null = null;
    if (rows.length > q.limit) {
      rows.pop(); // убираем probe-элемент
      nextCursor = rows[rows.length - 1].id; // курсор = последний возвращённый элемент
    }
    res.json({ items: rows, nextCursor });
  } catch (err) { next(err); }
};

router.get("/", rolesGuard(["SUPER_ADMIN"]), listAudit);
export default router;
