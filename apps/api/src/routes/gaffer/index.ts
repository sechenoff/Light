import express from "express";
import { gafferAuthRouter } from "./auth";
import { contactsRouter } from "./contacts";
import { paymentMethodsRouter } from "./paymentMethods";
import { gafferAuth } from "../../middleware/gafferAuth";

const router = express.Router();

// auth-маршруты публичные (login без gafferAuth)
router.use("/auth", gafferAuthRouter);

// остальные маршруты требуют gafferAuth
router.use("/contacts", gafferAuth, contactsRouter);
router.use("/payment-methods", gafferAuth, paymentMethodsRouter);

export { router as gafferRouter };
