import { Router } from "express";
import authRouter from "./auth";
import meRouter from "./me";
import bookingsRouter from "./bookings";
import estimatesRouter from "./estimates";
import debtRouter from "./debt";

const router = Router();
router.use("/auth", authRouter);
router.use("/bookings", bookingsRouter);
router.use("/estimates", estimatesRouter);
router.use("/debt", debtRouter);
router.use("/", meRouter);

export default router;
