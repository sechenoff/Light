import { Router } from "express";
import authRouter from "./auth";
import meRouter from "./me";

const router = Router();
router.use("/auth", authRouter);
router.use("/", meRouter);

export default router;
