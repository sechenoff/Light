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
  if (typeof auth !== "string" || !auth.startsWith("Bearer ")) {
    res.status(401).json({ message: "Требуется авторизация склада" });
    return;
  }

  const token = auth.slice("Bearer ".length);
  const payload = verifyToken(token);

  if (!payload) {
    res.status(401).json({ message: "Требуется авторизация склада" });
    return;
  }

  req.warehouseWorker = { name: payload.name };
  next();
}
