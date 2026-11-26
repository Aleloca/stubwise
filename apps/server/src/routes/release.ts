import { registerPersonMask } from "../services/people-known.js";
import { releaseQueueSchema, releaseResultSchema } from "@stubwise/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { legacyScope, projectIdsWithPermission } from "../auth/access.js";
import { fromTicket, ticketVisible } from "../auth/project-resolvers.js";
import { apiError } from "../errors.js";
import { listReleaseQueue, releasePullRequest } from "../services/release.js";
import { fixRelease, getRelease, listProjectReleases, ReleaseError, searchReleases } from "../services/releases.js";
import { listOpenPulls, setPrAnalysisOnly } from "../services/pulls.js";
import { getPrReleaseNotes, putPrReleaseNotes } from "../services/pr-release-notes.js";
import { authErrorResponses, errorSchema } from "./shared.js";

const releaseParamsSchema = z.object({ id: z.uuid(), repositoryId: z.uuid() });

/**
 * Coda di rilascio (fase 8, Task 9-10): "una pagina sola, per il maintainer"
 * (design §4) — sia la LISTA sia l'AZIONE seguono `release.merge`, a
 * differenza degli ambienti (dove solo le scritture lo richiedono): la lista
 * mostra solo le PR dei progetti in cui chi guarda può rilasciare (vuota per
 * chi non può farlo da nessuna parte), l'azione lo pretende nel progetto del
 * ticket.
 */
export async function releaseRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  // Registro, A11 r.1414: chi guarda non riceve l'id di chi non conosce.
  registerPersonMask(app, new Set(["mergedById", "byId", "updatedById"]));

  // Area 8, F1 (S5): i rilasci. Leggere: chi vede il progetto (404 altrimenti,
  // nel servizio). «Fai sistemare a Claude»: `tickets.create`, nel servizio.
  const handle = async <T>(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ReleaseError) return reply.code(error.status).send({ code: error.code, message: error.message });
      throw error;
    }
  };
  app.get("/projects/:projectId/releases", { config: { access: { kind: "user" }, mcp: { action: "releases.list", summary: "I rilasci di un progetto, con stato e PR comprese.", effect: "read" } }, schema: { params: z.object({ projectId: z.uuid() }) } }, async (request, reply) =>
    handle(reply, async () => ({ items: await listProjectReleases(app.db, request.user!, request.params.projectId) })),
  );
  // S5b: le PR aperte del progetto, a chi lo vede (la coda resta di `release.merge`).
  app.get("/projects/:projectId/pulls", { config: { access: { kind: "user" }, mcp: { action: "pulls.list", summary: "Le PR aperte di un progetto, con review, stato dei controlli e task collegata.", effect: "read" } }, schema: { params: z.object({ projectId: z.uuid() }) } }, async (request, reply) =>
    handle(reply, async () => ({ items: await listOpenPulls(app.db, app.encryptionKey, request.user!, request.params.projectId) })),
  );
  // Area 8, F1, S8: «Solo analisi» su una PR di un collega (`prs.adopt`, nel servizio).
  const pullParams = z.object({ repositoryId: z.uuid(), prNumber: z.coerce.number().int().positive() });
  for (const [method, on, mcp] of [
    ["post", true, { action: "pulls.setAnalysisOnly", summary: "Segna una PR di un collega come «solo analisi»: Stubwise la legge ma non la corregge (serve `prs.adopt`).", effect: "write" }],
    ["delete", false, { action: "pulls.clearAnalysisOnly", summary: "Toglie il segno «solo analisi» da una PR.", effect: "destructive" }],
  ] as const) {
    app[method]("/repositories/:repositoryId/pulls/:prNumber/analysis-only", { config: { access: { kind: "user" }, mcp }, schema: { params: pullParams } }, async (request, reply) =>
      handle(reply, () => setPrAnalysisOnly(app.db, request.user!, { ...request.params, on })),
    );
  }
  // Area 8, F1, S9: le note di rilascio di una PR (leggere: chi vede; scrivere: `release.merge` o `tickets.edit`).
  app.get("/repositories/:repositoryId/pulls/:prNumber/release-notes", { config: { access: { kind: "user" }, mcp: { action: "pulls.releaseNotes", summary: "Le note di rilascio di una PR.", effect: "read" } }, schema: { params: pullParams } }, async (request, reply) =>
    handle(reply, () => getPrReleaseNotes(app.db, app.encryptionKey, request.user!, request.params)),
  );
  app.put(
    "/repositories/:repositoryId/pulls/:prNumber/release-notes",
    { config: { access: { kind: "user" }, mcp: { action: "pulls.setReleaseNotes", summary: "Scrive le note di rilascio di una PR (serve `release.merge` o `tickets.edit`).", effect: "write" } }, schema: { params: pullParams, body: z.object({ body: z.string().max(20_000) }) } },
    async (request, reply) => handle(reply, () => putPrReleaseNotes(app.db, app.encryptionKey, request.user!, { ...request.params, body: request.body.body })),
  );
  const codeParams = z.object({ code: z.string().min(1).max(40) });
  // ⌘K (rimandi, lotto 5): PRIMA di `/releases/:code`, o «search» sarebbe un codice.
  app.get(
    "/releases/search",
    {
      config: { access: { kind: "user" }, mcp: { action: "releases.search", summary: "Cerca un rilascio per codice o titolo nei progetti che vedi.", effect: "read" } },
      schema: {
        querystring: z.object({ q: z.string().max(200).default("") }),
        // Lo schema della risposta (review del lotto 5, M-9): la forma di `ReleaseSearchResult`.
        response: {
          200: z.object({
            items: z.array(
              z.object({ kind: z.literal("release"), id: z.uuid(), code: z.string(), label: z.string(), projectId: z.uuid(), projectCode: z.string(), status: z.string() }),
            ),
          }),
          ...authErrorResponses,
        },
      },
    },
    async (request) => ({ items: await searchReleases(app.db, request.user!, request.query.q) }),
  );
  app.get("/releases/:code", { config: { access: { kind: "user" }, mcp: { action: "releases.get", summary: "Il dettaglio di un rilascio dal suo codice: PR, ambienti, esito.", effect: "read" } }, schema: { params: codeParams } }, async (request, reply) =>
    handle(reply, () => getRelease(app.db, request.user!, request.params.code)),
  );
  // 201 per una task nuova, 200 per quella già aperta (`existing`); `start` fa partire Claude se si può.
  app.post(
    "/releases/:code/fix",
    { config: { access: { kind: "user" }, mcp: { action: "releases.fix", summary: "Apre (o riprende) la task per sistemare un rilascio andato male; con `start` fa partire Claude se si può.", effect: "write", note: "Con `start` fa partire Claude: spende budget." } }, schema: { params: codeParams, body: z.object({ note: z.string().max(4000).optional(), start: z.boolean().optional() }).default({}) } },
    async (request, reply) =>
      handle(reply, async () => {
        const out = await fixRelease(app.db, request.user!, request.params.code, request.body ?? {});
        return reply.code(out.existing ? 200 : 201).send(out);
      }),
  );

  app.get(
    "/release-queue",
    {
      config: { access: { kind: "user" }, mcp: { action: "releases.queue", summary: "La coda di rilascio: le PR pronte da mergiare nei progetti in cui hai `release.merge`.", effect: "read", note: "Il merge si fa col tool `merge_pull_request`." } },
      schema: { response: { 200: releaseQueueSchema, ...authErrorResponses } },
    },
    async (request) => {
      const projectIds = await projectIdsWithPermission(app.db, request.user!, "release.merge");
      return { items: await listReleaseQueue(app.db, app.encryptionKey, await legacyScope(app.db, projectIds)) };
    },
  );

  // Il CANCELLO (design fase 7 §2, invariante): rende vero, con un controllo
  // vero, il secondo divieto dell'operatore — finora vero solo per assenza
  // di funzionalità (nessuna capacità di merge esisteva prima di questa
  // fase). `release.merge` sulla rotta E dentro releasePullRequest (difesa in
  // profondità, come preApprovePlan/resolvePlan in jobs.ts).
  app.post(
    "/tickets/:id/repositories/:repositoryId/release",
    {
      config: {
        mcp: { action: "tickets.mergePullRequest", summary: "Mergia la PR aperta di un ticket su un suo repository (la coda di rilascio).", effect: "destructive", tool: "merge_pull_request", note: "Non si ritira. Mai un deploy: solo il merge." },
        access: {
          kind: "project",
          permission: "release.merge",
          project: fromTicket("id"),
          resource: ticketVisible("id"),
        },
      },
      schema: {
        params: releaseParamsSchema,
        response: {
          200: releaseResultSchema,
          404: errorSchema,
          409: errorSchema,
          502: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await releasePullRequest(app.db, app.encryptionKey, {
        ticketId: request.params.id,
        repositoryId: request.params.repositoryId,
        actor: { id: request.user!.id, permissions: request.access!.permissions },
        publicUrl: app.publicUrl ?? null,
      });
      if (result.ok) return { merged: true as const, sha: result.sha, releaseCode: result.releaseCode ?? null };

      switch (result.error) {
        case "forbidden":
          // Irraggiungibile dietro `config.access`: difesa in profondità.
          return apiError(reply, 403, "forbidden", "Missing permission");
        case "not_found":
          return apiError(reply, 404, "not_found", "PR not found for this ticket and repository");
        case "already_closed":
          return apiError(reply, 409, "already_closed", "This PR is no longer open");
        case "checks_failed":
          return apiError(
            reply,
            409,
            "checks_failed",
            "The provider's checks are failing on this PR — it cannot be released",
          );
        case "checks_unreadable":
          // Review fix Task 2: un errore di lettura NON è un'assenza di
          // check — mai confuso con "checks_failed" (che dice qualcosa di
          // preciso: sono rossi) né con un rilascio silenzioso.
          return apiError(
            reply,
            409,
            "checks_unreadable",
            "Could not read this PR's checks from the provider — it cannot be released until they can be read",
          );
        case "not_mergeable":
          return apiError(
            reply,
            409,
            "not_mergeable",
            "The provider refused to merge this PR (conflicts or unmet branch rules)",
          );
        case "merge_forbidden":
          return apiError(
            reply,
            403,
            "merge_forbidden",
            "The stored git credentials do not have permission to merge this PR",
          );
        case "merge_failed":
          return apiError(reply, 502, "merge_failed", "The merge request to the provider failed");
      }
    },
  );
}
