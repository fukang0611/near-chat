import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../auth.js";
import { currentUser } from "../http.js";
import {
  bootstrapSync,
  pullSyncChanges,
  pushSyncOperations,
  registerSyncDevice,
  resolveMemorySyncConflict,
} from "../sync-service.js";

const uuid = z.string().uuid();
const operationSchema = z.object({
  operationId: uuid,
  entityType: z.enum([
    "MEMORY",
    "PERSONAL_TASK",
    "PERSONAL_REMINDER",
    "PERSONAL_RECORD",
    "ASSISTANT",
    "ASSISTANT_THREAD",
    "ASSISTANT_MESSAGE",
  ]),
  entityId: uuid,
  operation: z.enum(["UPSERT", "DELETE"]),
  baseRevision: z.number().int().positive().nullable(),
  payload: z.record(z.string(), z.unknown()).default({}),
  deviceCreatedAt: z.string().datetime({ offset: true }),
});

export function createSyncRouter() {
  const router = Router();
  router.post("/sync/devices/register", authenticate, async (request, response) => {
    const input = z
      .object({
        installationId: uuid,
        name: z.string().trim().min(1).max(120),
        platform: z.string().trim().min(1).max(32),
        appVersion: z.string().trim().min(1).max(40),
      })
      .parse(request.body);
    response.status(201).json({ device: await registerSyncDevice(currentUser(request).id, input) });
  });
  router.post("/sync/bootstrap", authenticate, async (request, response) => {
    const { deviceId, pageToken } = z
      .object({
        deviceId: uuid,
        pageToken: z.string().min(1).max(2048).optional(),
      })
      .parse(request.body);
    response.json(await bootstrapSync(currentUser(request).id, deviceId, pageToken));
  });
  router.post("/sync/push", authenticate, async (request, response) => {
    const input = z
      .object({ deviceId: uuid, operations: z.array(operationSchema).min(1).max(100) })
      .parse(request.body);
    response.json(
      await pushSyncOperations(currentUser(request).id, input.deviceId, input.operations),
    );
  });
  router.get("/sync/pull", authenticate, async (request, response) => {
    const input = z
      .object({
        deviceId: uuid,
        cursor: z.coerce.bigint().nonnegative().default(0n),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(request.query);
    response.json(
      await pullSyncChanges(currentUser(request).id, input.deviceId, input.cursor, input.limit),
    );
  });
  router.post(
    "/sync/memory-conflicts/:operationId/resolve",
    authenticate,
    async (request, response) => {
      const { operationId } = z.object({ operationId: uuid }).parse(request.params);
      const { status } = z
        .object({ status: z.enum(["RESOLVED", "DISMISSED"]) })
        .parse(request.body);
      response.json({
        conflict: await resolveMemorySyncConflict(currentUser(request).id, operationId, status),
      });
    },
  );
  return router;
}
