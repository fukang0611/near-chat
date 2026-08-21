import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../auth.js";
import { currentUser } from "../http.js";
import {
  createPersonalRecord,
  createPersonalReminder,
  createPersonalTask,
  deletePersonalRecord,
  deletePersonalReminder,
  deletePersonalTask,
  listPersonalRecords,
  listPersonalReminders,
  listPersonalTasks,
  updatePersonalRecord,
  updatePersonalReminder,
  updatePersonalTask,
} from "../personal-service.js";

const timestamp = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));
const id = z.string().uuid();
export function createPersonalRouter() {
  const router = Router();
  router.get("/personal/tasks", authenticate, async (request, response) =>
    response.json({ tasks: await listPersonalTasks(currentUser(request).id) }),
  );
  router.post("/personal/tasks", authenticate, async (request, response) => {
    const input = z
      .object({
        title: z.string().trim().min(1).max(160),
        note: z.string().trim().max(4000).default(""),
        dueAt: timestamp.nullable().default(null),
      })
      .parse(request.body);
    response.status(201).json({ task: await createPersonalTask(currentUser(request).id, input) });
  });
  router.patch("/personal/tasks/:taskId", authenticate, async (request, response) => {
    const input = z
      .object({
        title: z.string().trim().min(1).max(160).optional(),
        note: z.string().trim().max(4000).optional(),
        dueAt: timestamp.nullable().optional(),
        completed: z.boolean().optional(),
        baseRevision: z.number().int().positive(),
      })
      .parse(request.body);
    response.json({
      task: await updatePersonalTask(
        currentUser(request).id,
        id.parse(request.params.taskId),
        input,
      ),
    });
  });
  router.delete("/personal/tasks/:taskId", authenticate, async (request, response) => {
    const input = z
      .object({ baseRevision: z.coerce.number().int().positive() })
      .parse(request.query);
    await deletePersonalTask(
      currentUser(request).id,
      id.parse(request.params.taskId),
      input.baseRevision,
    );
    response.status(204).end();
  });
  router.get("/personal/reminders", authenticate, async (request, response) =>
    response.json({ reminders: await listPersonalReminders(currentUser(request).id) }),
  );
  router.post("/personal/reminders", authenticate, async (request, response) => {
    const input = z
      .object({
        title: z.string().trim().min(1).max(160),
        note: z.string().trim().max(4000).default(""),
        scheduledAt: timestamp,
      })
      .parse(request.body);
    response
      .status(201)
      .json({ reminder: await createPersonalReminder(currentUser(request).id, input) });
  });
  router.patch("/personal/reminders/:reminderId", authenticate, async (request, response) => {
    const input = z
      .object({
        title: z.string().trim().min(1).max(160).optional(),
        note: z.string().trim().max(4000).optional(),
        scheduledAt: timestamp.optional(),
        completed: z.boolean().optional(),
        baseRevision: z.number().int().positive(),
      })
      .parse(request.body);
    response.json({
      reminder: await updatePersonalReminder(
        currentUser(request).id,
        id.parse(request.params.reminderId),
        input,
      ),
    });
  });
  router.delete("/personal/reminders/:reminderId", authenticate, async (request, response) => {
    const input = z
      .object({ baseRevision: z.coerce.number().int().positive() })
      .parse(request.query);
    await deletePersonalReminder(
      currentUser(request).id,
      id.parse(request.params.reminderId),
      input.baseRevision,
    );
    response.status(204).end();
  });
  router.get("/personal/records", authenticate, async (request, response) =>
    response.json({ records: await listPersonalRecords(currentUser(request).id) }),
  );
  router.post("/personal/records", authenticate, async (request, response) => {
    const input = z
      .object({
        title: z.string().trim().min(1).max(160),
        content: z.string().trim().min(1).max(20000),
      })
      .parse(request.body);
    response
      .status(201)
      .json({ record: await createPersonalRecord(currentUser(request).id, input) });
  });
  router.patch("/personal/records/:recordId", authenticate, async (request, response) => {
    const input = z
      .object({
        title: z.string().trim().min(1).max(160).optional(),
        content: z.string().trim().min(1).max(20000).optional(),
        baseRevision: z.number().int().positive(),
      })
      .parse(request.body);
    response.json({
      record: await updatePersonalRecord(
        currentUser(request).id,
        id.parse(request.params.recordId),
        input,
      ),
    });
  });
  router.delete("/personal/records/:recordId", authenticate, async (request, response) => {
    const input = z
      .object({ baseRevision: z.coerce.number().int().positive() })
      .parse(request.query);
    await deletePersonalRecord(
      currentUser(request).id,
      id.parse(request.params.recordId),
      input.baseRevision,
    );
    response.status(204).end();
  });
  return router;
}
