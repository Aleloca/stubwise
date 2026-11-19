import { automations, type Db } from "@stubwise/db";
import type { AutomationFlow } from "@stubwise/shared";
import { eq, sql } from "drizzle-orm";
import { AutomationError, configErrorsOf, latestVersion, managedAutomation, notFound, seen, sees, type AutomationRecord } from "../automations/model.js";
import { createAutomation, deleteDraft, saveDraft } from "../automations/writes.js";
import type { ActionObject, CatalogEntry, CatalogRefusal } from "./catalog.js";

/**
 * Area 10, F2 (S1): le BOZZE di automazione di progetto da Claude. Le voci
 * chiamano i servizi delle rotte (`apps/server/src/automations/writes.ts`), mai
 * le rotte; `test-claude.ts` (il modello) non è raggiungibile da qui
 * (`claude-actions-effects.test.ts`). Claude non pubblica, non accende, non
 * mette in pausa e non avvia niente: quei nomi stanno nel test del «mai».
 *
 * «Annulla» guarda la revisione della bozza (`stamp` = versione, rev e se è
 * bozza): chiunque l'abbia salvata dopo Claude, anche la stessa persona dal
 * costruttore, la fa cadere.
 */

const refused = (code: CatalogRefusal["code"], message: string) => ({ ok: false as const, refusal: { code, message } });

/** Gli errori dei servizi delle automazioni, nel linguaggio del catalogo. */
function automationRefusal(error: unknown): { ok: false; refusal: CatalogRefusal } {
  if (!(error instanceof AutomationError)) throw error;
  const code: CatalogRefusal["code"] =
    error.status === 403 ? "forbidden" : error.status === 404 ? "not_found" : error.code === "stale" ? "conflict" : "invalid";
  const issues = Array.isArray(error.extra["issues"]) ? ` ${JSON.stringify(error.extra["issues"]).slice(0, 500)}` : "";
  return refused(code, `${error.code}${issues}`);
}

/**
 * Lo stato di un'automazione come `stamp` di «Annulla»: l'ultima versione
 * (`n:rev:bozza|pubblicata`) più nome e descrizione (review di F2, M3: un
 * cambio di nome dopo Claude fa cadere l'«Annulla» come un salvataggio).
 */
export async function automationStamp(tx: Db, automationId: string): Promise<string | null> {
  const last = await latestVersion(tx, automationId);
  if (!last) return null;
  const [a] = await tx.select({ name: automations.name, description: automations.description }).from(automations).where(eq(automations.id, automationId));
  return `${last.n}:${last.rev}:${last.publishedAt === null ? "draft" : "published"}:${JSON.stringify([a?.name ?? "", a?.description ?? ""])}`;
}

/**
 * Review di F2 (I2, M2): l'automazione di chi chiede, PRIMA di ogni altro
 * controllo — 404 se non la vede (niente oracolo su esistenza o rev di un
 * progetto nascosto), 403 senza `automations.manage`, `project_only` per una
 * generale (Claude scrive solo bozze di progetto) — e bloccata `FOR UPDATE`
 * come la pubblicazione, così rev e flusso si leggono sotto il lock.
 */
async function lockedProjectAutomation(tx: Db, user: Parameters<typeof managedAutomation>[1], code: string): Promise<AutomationRecord> {
  const visible = await managedAutomation(tx, user, code);
  if (visible.projectId === null) throw new AutomationError(422, "project_only", "Claude writes only project automations");
  const [locked] = await tx.select().from(automations).where(eq(automations.id, visible.id)).for("update");
  if (!locked) throw notFound();
  return locked;
}

/** L'esecuzione in corso è l'inverso di un «Annulla»? (L'esecutore imposta la variabile.) */
async function isUndo(tx: Db): Promise<boolean> {
  const [row] = await tx.execute<{ id: string | null }>(sql`select nullif(current_setting('stubwise.undo_of_claude_action_id', true), '') as id`);
  return (row?.id ?? null) !== null;
}

async function automationObject(tx: Db, a: { id: string; code: string }): Promise<ActionObject> {
  const stamp = await automationStamp(tx, a.id);
  return { kind: "automation", id: a.id, code: a.code, ...(stamp ? { stamp } : {}) };
}

const USER = { kind: "user" as const };
const body = (args: Record<string, unknown>) => ({ body: args });

export const AUTOMATION_ENTRIES: CatalogEntry[] = [
  {
    fn: "createAutomation",
    route: "POST /api/automations",
    access: USER,
    request: body,
    async run(tx, user, args) {
      const input = args as { projectId: string; name: string; description?: string; flow: AutomationFlow };
      try {
        // Prima il progetto (404, 403), POI il flusso: un errore del flusso non
        // dice niente di un progetto che chi chiede non vede.
        if (!sees(await seen(tx, user), input.projectId)) throw notFound();
        const issues = await configErrorsOf(tx, { projectId: input.projectId }, input.flow, user.id);
        const created = await createAutomation(tx, user, { projectId: input.projectId, name: input.name, ...(input.description !== undefined ? { description: input.description } : {}), flow: input.flow });
        if (issues.length > 0) throw new AutomationError(422, "flow_errors", "The flow has configuration errors", { issues });
        return {
          ok: true,
          result: {
            inverse: { fn: "deleteAutomationDraft", args: { code: created.code, expectedRev: 1 } },
            objects: [await automationObject(tx, created)],
            codes: [created.code],
          },
        };
      } catch (error) {
        return automationRefusal(error);
      }
    },
  },
  {
    fn: "saveAutomationDraft",
    route: "PUT /api/automations/:code/draft",
    access: USER,
    request: (args) => ({ params: { code: args["code"] }, body: args }),
    async run(tx, user, args) {
      const input = args as { code: string; flow: AutomationFlow; expectedRev: number | null; name?: string; description?: string };
      try {
        const a = await lockedProjectAutomation(tx, user, input.code);
        const was = await latestVersion(tx, a.id);
        // `saveDraft` lascia salvare sopra la PROPRIA bozza con una rev vecchia
        // (il costruttore della stessa persona in due schede); da Claude no: la
        // rev letta è quella di adesso, o niente.
        const current = was && was.publishedAt === null ? was.rev : null;
        if (current !== input.expectedRev) throw new AutomationError(409, "stale", "Someone changed the draft", { rev: current });
        // Review di F2 (M3): nome e descrizione sono dell'automazione, non della
        // bozza: su un'accesa senza bozza Claude non li cambia.
        if (current === null && (input.name !== undefined || input.description !== undefined)) {
          throw new AutomationError(422, "not_a_draft", "Name and description change only on a draft");
        }
        // Review di F2 (M1): l'inverso rimette il flusso di PRIMA, anche se aveva
        // errori (una bozza può averne): non si rivalida.
        if (!(await isUndo(tx))) {
          const issues = await configErrorsOf(tx, a, input.flow, user.id);
          if (issues.length > 0) throw new AutomationError(422, "flow_errors", "The flow has configuration errors", { issues });
        }
        await saveDraft(tx, user, input.code, {
          flow: input.flow,
          expectedRev: input.expectedRev,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
        });
        const now = await latestVersion(tx, a.id);
        // Su una bozza: il flusso (e nome/descrizione) di prima. Su un'accesa
        // senza bozza il salvataggio ha aperto la versione dopo: annullare la toglie.
        const inverse =
          was && was.publishedAt === null
            ? {
                fn: "saveAutomationDraft" as const,
                args: {
                  code: a.code,
                  flow: was.flow,
                  expectedRev: now!.rev,
                  ...(input.name !== undefined ? { name: a.name } : {}),
                  ...(input.description !== undefined ? { description: a.description } : {}),
                },
              }
            : { fn: "deleteAutomationDraft" as const, args: { code: a.code, expectedRev: now!.rev } };
        return { ok: true, result: { inverse, objects: [await automationObject(tx, a)], codes: [a.code] } };
      } catch (error) {
        return automationRefusal(error);
      }
    },
  },
  {
    fn: "deleteAutomationDraft",
    route: "DELETE /api/automations/:code/draft",
    access: USER,
    request: (args) => ({ params: { code: args["code"] } }),
    async run(tx, user, args) {
      const input = args as { code: string; expectedRev: number };
      try {
        const a = await lockedProjectAutomation(tx, user, input.code);
        // `deleteDraft` lascia passare una bozza di chi la elimina anche con una
        // rev diversa; da Claude no: la rev letta deve essere quella di adesso.
        const last = await latestVersion(tx, a.id);
        if (last && last.publishedAt === null && last.rev !== input.expectedRev) throw new AutomationError(409, "stale", "Someone changed the draft", { rev: last.rev });
        await deleteDraft(tx, user, input.code, { expectedRev: input.expectedRev });
        return { ok: true, result: { inverse: null, objects: [{ kind: "automation", id: a.id, code: a.code }], codes: [a.code] } };
      } catch (error) {
        return automationRefusal(error);
      }
    },
  },
];
