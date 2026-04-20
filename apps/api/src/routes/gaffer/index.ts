import express from "express";
import { gafferAuthRouter } from "./auth";
import { contactsRouter } from "./contacts";
import { paymentMethodsRouter } from "./paymentMethods";
import { projectsRouter } from "./projects";
import { paymentsRouter } from "./payments";
import { dashboardRouter } from "./dashboard";
import { obligationsRouter } from "./obligations";
import { gafferAuth } from "../../middleware/gafferAuth";

const router = express.Router();

// auth-маршруты публичные (login без gafferAuth)
router.use("/auth", gafferAuthRouter);

// остальные маршруты требуют gafferAuth
router.use("/dashboard", gafferAuth, dashboardRouter);
router.use("/obligations", gafferAuth, obligationsRouter);
router.use("/contacts", gafferAuth, contactsRouter);
router.use("/payment-methods", gafferAuth, paymentMethodsRouter);
router.use("/projects", gafferAuth, projectsRouter);
router.use("/payments", gafferAuth, paymentsRouter);

export { router as gafferRouter };
