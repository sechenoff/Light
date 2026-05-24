import { Router } from "express";
import { prisma } from "../../prisma";
import { lkAuth } from "../../middleware/lkAuth";
import { HttpError } from "../../utils/errors";

const router = Router();

router.get("/me", lkAuth, async (req, res, next) => {
  try {
    const account = await prisma.clientPortalAccount.findUnique({
      where: { id: req.clientPortal!.accountId },
      include: { client: { select: { id: true, name: true, phone: true, email: true } } },
    });
    if (!account) throw new HttpError(401, "Не авторизован", "UNAUTHENTICATED");
    res.json({
      account: { email: account.email, lastLoginAt: account.lastLoginAt },
      client: account.client,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
