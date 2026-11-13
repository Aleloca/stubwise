import { meetingSummarySchema, meetingTasksSchema } from "@stubwise/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { apiError } from "../errors.js";
import { meetingSummaryFor, meetingTasksByNote } from "../services/meetings.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * LE RIUNIONI REGISTRATE (area 6, F5a), sotto `/api/me/meetings`: il
 * riassunto per chi è invitato ma NON ha l'evento nel suo calendario (ci
 * arriva dal messaggio di Gemini o dalla proposta). 404 a chi non è nel
 * calcolo di `canSeeMeeting` — anche a un admin non invitato —, come a una
 * riunione che non esiste. Le regole in `services/meetings.ts`.
 */
export async function meMeetingsRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  app.get(
    "/:noteId",
    { config: { access: { kind: "user" } }, schema: { params: z.object({ noteId: z.uuid() }), response: { 200: meetingSummarySchema, 404: errorSchema, ...authErrorResponses } } },
    async (request, reply) => (await meetingSummaryFor(app.db, request.user!.id, request.params.noteId)) ?? apiError(reply, 404, "not_found", "Meeting not found"),
  );

  /** «Task da questa riunione» per id: 404 a chi non è fra gli invitati, `null` a chi non è membro del progetto (R-I21). */
  app.get(
    "/:noteId/tasks",
    { config: { access: { kind: "user" } }, schema: { params: z.object({ noteId: z.uuid() }), response: { 200: meetingTasksSchema, 404: errorSchema, ...authErrorResponses } } },
    async (request, reply) => {
      const out = await meetingTasksByNote(app.db, request.user!.id, request.params.noteId, new Date().toISOString().slice(0, 10));
      return out === undefined ? apiError(reply, 404, "not_found", "Meeting not found") : out;
    },
  );
}
