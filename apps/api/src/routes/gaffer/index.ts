import express from "express";
import { gafferAuthRouter } from "./auth";

const router = express.Router();

router.use("/auth", gafferAuthRouter);

export { router as gafferRouter };
