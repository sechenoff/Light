import { Router } from "express";
import authRouter from "./auth";
import meRouter from "./me";
import bookingsRouter from "./bookings";

const router = Router();
router.use("/auth", authRouter);
router.use("/bookings", bookingsRouter);
router.use("/", meRouter);

export default router;
