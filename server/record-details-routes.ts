// ─── /api/details/* — user-defined characteristics on any record ────────────
//
//   GET    /api/details/definitions                    catalog (+ usage counts)
//   POST   /api/details/definitions                    create (or reuse by name)
//   PATCH  /api/details/definitions/:id                edit (renameOptions rewrites values)
//   DELETE /api/details/definitions/:id                delete it and its values
//   GET    /api/details/report?definition=&op=&value=  records by characteristic
//   GET    /api/details/flags                          every rule flag right now
//   GET    /api/details/:entityType/:entityId          one record's details
//   POST   /api/details/:entityType/:entityId          define-on-the-spot + set
//   PUT    /api/details/:entityType/:entityId/:defId   set a value
//   DELETE /api/details/:entityType/:entityId/:defId   clear a value
//
// All logic lives in server/record-details.ts; this file is HTTP only.

import type { Express, Request, Response } from "express";
import { getUserToday, DEFAULT_TIMEZONE } from "@shared/timezone";
import {
  DetailError, allDetailFlags, clearRecordDetail, defineAndSetRecordDetail, definitionUsage, deleteDefinition,
  detailReport, getRecordDetailsPayload, listDefinitions, setRecordDetail, updateDefinition, upsertDefinition,
} from "./record-details";
import { logger } from "./logger";

type Handler = (req: Request, res: Response) => Promise<unknown>;

function wrap(fn: Handler) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err: any) {
      if (err instanceof DetailError) {
        if (!res.headersSent) res.status(err.status).json({ error: err.message });
        return;
      }
      logger.error("details", `${req.method} ${req.path}: ${err?.message || String(err)}`);
      if (!res.headersSent) res.status(500).json({ error: "Couldn't save that detail — please try again" });
    }
  };
}

function todayFor(req: Request): string {
  const tz = req.headers["x-timezone"];
  return getUserToday(typeof tz === "string" && tz ? tz : DEFAULT_TIMEZONE);
}

const DEFINITION_FIELDS = ["label", "kind", "options", "unit", "min", "max", "scaleMax", "required", "appliesTo", "rules", "description"] as const;

function definitionInput(body: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!body || typeof body !== "object") return out;
  for (const k of DEFINITION_FIELDS) if (k in body) out[k] = body[k];
  return out;
}

export function registerRecordDetailRoutes(app: Express): void {
  app.get("/api/details/definitions", wrap(async (_req, res) => {
    const [definitions, usage] = await Promise.all([listDefinitions(), definitionUsage()]);
    res.json({ definitions, usage });
  }));

  app.post("/api/details/definitions", wrap(async (req, res) => {
    const { definition, created } = await upsertDefinition(definitionInput(req.body));
    res.status(created ? 201 : 200).json({ definition, created });
  }));

  app.patch("/api/details/definitions/:id", wrap(async (req, res) => {
    const definition = await updateDefinition(String(req.params.id), {
      ...definitionInput(req.body),
      renameOptions: req.body?.renameOptions,
    });
    res.json({ definition });
  }));

  app.delete("/api/details/definitions/:id", wrap(async (req, res) => {
    const result = await deleteDefinition(String(req.params.id));
    res.json({ success: true, ...result });
  }));

  app.get("/api/details/report", wrap(async (req, res) => {
    const report = await detailReport({
      definition: req.query.definition,
      op: req.query.op,
      value: req.query.value,
      todayISO: todayFor(req),
    });
    res.json(report);
  }));

  app.get("/api/details/flags", wrap(async (req, res) => {
    res.json({ flags: await allDetailFlags(todayFor(req)) });
  }));

  app.get("/api/details/:entityType/:entityId", wrap(async (req, res) => {
    res.json(await getRecordDetailsPayload(req.params.entityType, req.params.entityId, todayFor(req)));
  }));

  app.post("/api/details/:entityType/:entityId", wrap(async (req, res) => {
    const body = req.body || {};
    const def = body.definition && typeof body.definition === "object" ? body.definition : body;
    const result = await defineAndSetRecordDetail({
      entityType: req.params.entityType,
      entityId: req.params.entityId,
      definition: definitionInput(def),
      value: body.value,
      todayISO: todayFor(req),
    });
    res.status(result.createdDefinition ? 201 : 200).json({
      ...result.payload,
      definition: result.definition,
      createdDefinition: result.createdDefinition,
    });
  }));

  app.put("/api/details/:entityType/:entityId/:definitionId", wrap(async (req, res) => {
    if (!req.body || !("value" in req.body)) return res.status(400).json({ error: "value is required" });
    const result = await setRecordDetail({
      entityType: req.params.entityType,
      entityId: req.params.entityId,
      definition: req.params.definitionId,
      value: req.body.value,
      todayISO: todayFor(req),
    });
    res.json(result.payload);
  }));

  // Idempotent: clearing a value that is already clear answers 200 with the
  // record's details; an unknown record or characteristic is a 404.
  app.delete("/api/details/:entityType/:entityId/:definitionId", wrap(async (req, res) => {
    const result = await clearRecordDetail({
      entityType: req.params.entityType,
      entityId: req.params.entityId,
      definition: req.params.definitionId,
      todayISO: todayFor(req),
    });
    res.json(result.payload);
  }));
}
