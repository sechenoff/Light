/**
 * Роутер /api/gaffer/projects — CRUD проектов Gaffer CRM.
 *
 * GET    /                       — список с агрегатами
 * GET    /:id                    — один проект с участниками, платежами, агрегатами
 * POST   /                       — создать
 * PATCH  /:id                    — обновить
 * POST   /:id/archive            — архивировать
 * POST   /:id/unarchive          — разархивировать
 * DELETE /:id                    — удалить
 * POST   /:id/members            — добавить участника
 * PATCH  /members/:memberId      — обновить участника
 * DELETE /members/:memberId      — удалить участника
 */

import express from "express";
import { z } from "zod";
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  archiveProject,
  unarchiveProject,
  deleteProject,
} from "../../services/gaffer/projectService";
import {
  addMember,
  updateMember,
  removeMember,
} from "../../services/gaffer/projectMemberService";

const router = express.Router();

// ─── Zod-схемы ───────────────────────────────────────────────────────────────

const projectStatusSchema = z.enum(["OPEN", "ARCHIVED"]);

const listQuerySchema = z.object({
  status: projectStatusSchema.optional(),
  search: z.string().optional(),
  clientId: z.string().optional(),
  memberContactId: z.string().optional(),
});

const createProjectSchema = z.object({
  title: z.string().trim().min(1, "Название обязательно").max(200),
  clientId: z.string().min(1, "Клиент обязателен"),
  shootDate: z.string().min(1, "Дата съёмки обязательна").transform((v) => new Date(v)),
  clientPlanAmount: z.union([z.string(), z.number()]).optional(),
  lightBudgetAmount: z.union([z.string(), z.number()]).optional(),
  note: z.string().trim().max(1000).optional(),
});

const updateProjectSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  clientId: z.string().min(1).optional(),
  shootDate: z.string().transform((v) => new Date(v)).optional(),
  clientPlanAmount: z.union([z.string(), z.number()]).optional(),
  lightBudgetAmount: z.union([z.string(), z.number()]).optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});

const addMemberSchema = z.object({
  contactId: z.string().min(1, "Контакт обязателен"),
  plannedAmount: z.union([z.string(), z.number()]).optional(),
  roleLabel: z.string().trim().max(200).optional(),
});

const updateMemberSchema = z.object({
  plannedAmount: z.union([z.string(), z.number()]).optional(),
  roleLabel: z.string().trim().max(200).nullable().optional(),
});

// ─── Члены команды (до /:id чтобы /members/:memberId не конфликтовал) ────────

/**
 * PATCH /api/gaffer/projects/members/:memberId
 */
router.patch("/members/:memberId", async (req, res, next) => {
  try {
    const body = updateMemberSchema.parse(req.body);
    const member = await updateMember(req, req.params.memberId, body);
    res.json({ member });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/gaffer/projects/members/:memberId
 */
router.delete("/members/:memberId", async (req, res, next) => {
  try {
    await removeMember(req, req.params.memberId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ─── Проекты ──────────────────────────────────────────────────────────────────

/**
 * GET /api/gaffer/projects
 */
router.get("/", async (req, res, next) => {
  try {
    const query = listQuerySchema.parse(req.query);
    const items = await listProjects(req, query);
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/gaffer/projects
 */
router.post("/", async (req, res, next) => {
  try {
    const body = createProjectSchema.parse(req.body);
    const project = await createProject(req, body);
    res.json({ project });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/gaffer/projects/:id
 */
router.get("/:id", async (req, res, next) => {
  try {
    const project = await getProject(req, req.params.id);
    res.json({ project });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/gaffer/projects/:id
 */
router.patch("/:id", async (req, res, next) => {
  try {
    const body = updateProjectSchema.parse(req.body);
    const project = await updateProject(req, req.params.id, body);
    res.json({ project });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/gaffer/projects/:id/archive
 */
router.post("/:id/archive", async (req, res, next) => {
  try {
    const project = await archiveProject(req, req.params.id);
    res.json({ project });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/gaffer/projects/:id/unarchive
 */
router.post("/:id/unarchive", async (req, res, next) => {
  try {
    const project = await unarchiveProject(req, req.params.id);
    res.json({ project });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/gaffer/projects/:id
 */
router.delete("/:id", async (req, res, next) => {
  try {
    await deleteProject(req, req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/gaffer/projects/:id/members
 */
router.post("/:id/members", async (req, res, next) => {
  try {
    const body = addMemberSchema.parse(req.body);
    const member = await addMember(req, req.params.id, body);
    res.json({ member });
  } catch (err) {
    next(err);
  }
});

export { router as projectsRouter };
