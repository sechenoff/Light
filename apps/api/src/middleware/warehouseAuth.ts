import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "../services/warehouseAuth";

declare global {
  namespace Express {
    interface Request {
      warehouseWorker?: { name: string };
    }
  }
}

export function warehouseAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers["authorization"];

  // Path 1: PIN-based warehouse token (legacy, для внешних сотрудников склада)
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length);
    const payload = verifyToken(token);
    if (payload) {
      req.warehouseWorker = { name: payload.name };
      return next();
    }
    // Bearer-заголовок есть, но токен не валиден как warehouse token →
    // пробуем main session fallback ниже (JWT-токен adminUser тоже Bearer)
  }

  // Path 2: Main session fallback — SUPER_ADMIN или WAREHOUSE уже залогинены
  // через основной login (/api/auth/login). req.adminUser заполняется sessionParser,
  // который монтируется перед warehouseScanRouter в app.ts.
  if (
    req.adminUser &&
    (req.adminUser.role === "SUPER_ADMIN" || req.adminUser.role === "WAREHOUSE")
  ) {
    req.warehouseWorker = { name: req.adminUser.username };
    return next();
  }

  res.status(401).json({ message: "Требуется авторизация склада" });
}
