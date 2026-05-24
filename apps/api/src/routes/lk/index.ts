import { Router } from "express";
import authRouter from "./auth";
import meRouter from "./me";
import bookingsRouter from "./bookings";
import estimatesRouter from "./estimates";
import debtRouter from "./debt";
import statsRouter from "./stats";

const router = Router();
router.use("/auth", authRouter);
router.use("/bookings", bookingsRouter);
router.use("/estimates", estimatesRouter);
router.use("/debt", debtRouter);
router.use("/stats", statsRouter);
router.use("/", meRouter);

export default router;
