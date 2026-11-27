import { createHash } from "node:crypto";
import {
  departmentMembers,
  departmentProjectPermissions,
  departmentRoles,
  departments,
  projectAccess,
  projectAccessRowCounts,
  projects,
  tickets,
  users,
  type Db,
} from "@stubwise/db";
import {
  DEPARTMENT_PERMISSIONS,
  PROJECT_PERMISSIONS,
  departmentColorTokenSchema,
  departmentPreviewSchema,
  departmentRoleViewSchema,
  departmentViewSchema,
  type DepartmentView,
} from "@stubwise/shared";
import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { projectPermissionsFor, requireReauth, type RouteAccess } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { keepingManagersIn, RoleRuleError } from "../services/roles.js";
import { sendRoleRuleError } from "./roles.js";
import { apiError } from "../errors.js";
import { recordChange } from "../services/change-log.js";
import { judgeDepartmentDraft, savedDepartmentShape } from "../services/department-access.js";

type DepartmentTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** L'oggetto «reparto» di una voce, col nome di ora. */
async function departmentObject(tx: DepartmentTx, id: string) {
  const [d] = await tx
    .select({ name: departments.name })
    .from(departments)
    .where(eq(departments.id, id));
  return { type: "department", id, label: d?.name ?? "" };
}

/**
 * Le persone entrate e uscite di una voce di reparto: gli id (la lettura toglie
 * quelle che chi guarda non vede) e, in parallelo, le email di allora.
 */
async function peopleParams(tx: DepartmentTx, added: string[], removed: string[]) {
  const ids = [...added, ...removed];
  const emails = new Map(
    ids.length
      ? (
          await tx
            .select({ id: users.id, email: users.email })
            .from(users)
            .where(inArray(users.id, ids))
        ).map((u) => [u.id, u.email])
      : [],
  );
  return {
    added,
    removed,
    addedNames: added.map((u) => emails.get(u) ?? ""),
    removedNames: removed.map((u) => emails.get(u) ?? ""),
  };
}
import { authErrorResponses, errorSchema } from "./shared.js";

/** La transazione del PATCH ha visto che la scrittura fa arrivare permessi: serve la riconferma. */
class ReauthNeeded extends Error {}

/**
 * Reparti (integrazione area 2, fetta 1): la pagina Reparti
 * dell'amministrazione del prototipo (`pages/admin/DepartmentsPage.tsx`):
 * nome, colore, persone. Letti da ogni persona (servono a ogni task e ai
 * selettori), gestiti con `departments.manage`. Il ripiego («General») si
 * rinomina ma non si elimina: è dove nasce una task senza autore umano.
 */

const MANAGE: RouteAccess = { kind: "instance", permission: "departments.manage" };
const idParamsSchema = z.object({ id: z.uuid() });
const nameSchema = z.string().trim().min(1).max(80);

type DepartmentRow = typeof departments.$inferSelect;

/**
 * Area 9, F8 (la review del renderer): la versione OPACA di ciò che il `PATCH`
 * scrive (nome, colore, persone, permessi di progetto), come quella dei plugin
 * di un progetto. Un salvataggio con `ifMatch` vecchio è 409 `stale`.
 */
export function departmentVersion(row: Pick<DepartmentRow, "name" | "colorToken">, shape: { memberIds: readonly string[]; projectPermissions: readonly string[] }): string {
  const canonical = { name: row.name, colorToken: row.colorToken, memberIds: [...shape.memberIds].sort(), projectPermissions: [...shape.projectPermissions].sort() };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16);
}

function toView(row: DepartmentRow, projectPermissions: readonly string[] = [], version = ""): DepartmentView {
  return {
    id: row.id,
    name: row.name,
    colorToken: row.colorToken as DepartmentView["colorToken"],
    isDefault: row.isDefault,
    projectPermissions: [...projectPermissions].sort(),
    version,
  };
}

/** Gli errori delle scritture di un reparto (area 9, F8): `missing` dell'escalation, il progetto di `last_manager`. */
const departmentErrorSchema = errorSchema.extend({
  permission: z.string().optional(),
  missing: z.array(z.string()).optional(),
  projectId: z.string().optional(),
  projectCode: z.string().optional(),
  /** `stale`: la versione di adesso. */
  version: z.string().optional(),
});

/**
 * La scrittura della bozza di un reparto (nome e colore, persone, permessi di
 * progetto), con le sue voci del registro, nella transazione di chi chiama.
 * Le regole (riconferma, escalation, ultimo gestore) le ha già applicate la
 * rotta.
 */
async function writeDepartment(
  tx: DepartmentTx,
  actor: { id: string; email: string },
  current: DepartmentRow,
  input: {
    name?: string | undefined;
    colorToken?: DepartmentRow["colorToken"] | undefined;
    next?: string[] | undefined;
    nextPerms?: string[] | undefined;
    before: { memberIds: readonly string[]; projectPermissions: readonly string[] };
  },
): Promise<DepartmentRow> {
  const { id } = current;
  const { name, colorToken, next, nextPerms } = input;
  const patch: Partial<DepartmentRow> = {};
  if (name !== undefined) patch.name = name;
  if (colorToken !== undefined) patch.colorToken = colorToken;
  const [row] =
    Object.keys(patch).length > 0
      ? await tx.update(departments).set(patch).where(eq(departments.id, id)).returning()
      : [current];
  // Area 9, F2: il nome (e il colore) prima e dopo.
  if (Object.keys(patch).length > 0) {
    await recordChange(tx, {
      type: "department.updated",
      actor,
      projectId: null,
      data: {
        object: { type: "department", id, label: row!.name },
        before: current.name,
        after: row!.name,
        params: { color: row!.colorToken },
      },
    });
  }
  if (next) {
    const membersBefore = new Set(input.before.memberIds);
    // Chi esce dal reparto perde anche i suoi ruoli lì (fix fetta 3): se
    // gestiva la Home, lo dice anche la voce dei gestori (review di F2, m5).
    const losingHome = (
      await tx
        .select({ userId: departmentRoles.userId, permissions: departmentRoles.permissions })
        .from(departmentRoles)
        .where(eq(departmentRoles.departmentId, id))
    )
      .filter((r) => !next.includes(r.userId) && r.permissions.includes("department.home.manage"))
      .map((r) => r.userId);
    if (losingHome.length) {
      await recordChange(tx, {
        type: "department.home_managers_changed",
        actor,
        projectId: null,
        data: {
          object: { type: "department", id, label: row!.name },
          params: await peopleParams(tx, [], losingHome),
        },
      });
    }
    await tx
      .delete(departmentRoles)
      .where(
        next.length > 0
          ? and(eq(departmentRoles.departmentId, id), notInArray(departmentRoles.userId, next))
          : eq(departmentRoles.departmentId, id),
      );
    await tx
      .delete(departmentMembers)
      .where(
        next.length > 0
          ? and(eq(departmentMembers.departmentId, id), notInArray(departmentMembers.userId, next))
          : eq(departmentMembers.departmentId, id),
      );
    // Chi entra lo riceve PER ULTIMO fra i suoi reparti: il suo «primo
    // reparto» (dove nascono le sue task) non cambia.
    for (const userId of next) {
      await tx.execute(sql`
        insert into "department_members" ("department_id", "user_id", "position")
        select ${id}, ${userId}, coalesce(max("position") + 1, 0)
        from "department_members" where "user_id" = ${userId}
        on conflict do nothing
      `);
    }
    const added = next.filter((u) => !membersBefore.has(u));
    const removed = [...membersBefore].filter((u) => !next.includes(u));
    if (added.length || removed.length) {
      await recordChange(tx, {
        type: "department.members_changed",
        actor,
        projectId: null,
        data: {
          object: { type: "department", id, label: row!.name },
          params: await peopleParams(tx, added, removed),
        },
      });
    }
  }
  if (nextPerms) {
    // Area 9, F8 (R-6): i permessi di progetto, con l'insieme di prima e di dopo.
    const previous = [...input.before.projectPermissions].sort();
    const added = nextPerms.filter((p) => !previous.includes(p));
    const removed = previous.filter((p) => !nextPerms.includes(p));
    if (removed.length) {
      await tx
        .delete(departmentProjectPermissions)
        .where(
          and(
            eq(departmentProjectPermissions.departmentId, id),
            inArray(departmentProjectPermissions.permission, removed),
          ),
        );
    }
    if (added.length) {
      await tx
        .insert(departmentProjectPermissions)
        .values(
          added.map((permission) => ({ departmentId: id, permission, grantedByUserId: actor.id })),
        );
    }
    if (added.length || removed.length) {
      await recordChange(tx, {
        type: "department.permissions_changed",
        actor,
        projectId: null,
        data: {
          object: { type: "department", id, label: row!.name },
          before: previous.join(","),
          after: nextPerms.join(","),
          params: { added, removed },
        },
      });
    }
  }
  return row!;
}

export async function departmentRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  /** Un altro reparto ha già quel nome (senza distinguere maiuscole). */
  async function nameTaken(name: string, except?: string): Promise<boolean> {
    const rows = await app.db
      .select({ id: departments.id })
      .from(departments)
      .where(sql`lower(${departments.name}) = lower(${name})`);
    return rows.some((r) => r.id !== except);
  }

  app.get(
    "/",
    {
      config: { mcp: { action: "departments.list", summary: "I reparti, coi membri e i permessi di progetto che danno.", effect: "read" }, access: { kind: "user" } },
      schema: { response: { 200: z.array(departmentViewSchema), ...authErrorResponses } },
    },
    async (request) => {
      const rows = await app.db
        .select()
        .from(departments)
        .orderBy(desc(departments.isDefault), asc(departments.name));
      // Area 9, F8 (R-1): i permessi di progetto che il reparto dà, SOLO a chi
      // gestisce i reparti (l'elenco lo legge chiunque: le task, i selettori).
      const manages = request.user!.instancePermissions.has("departments.manage");
      const perms = await app.db.select().from(departmentProjectPermissions);
      const members = await app.db.select({ departmentId: departmentMembers.departmentId, userId: departmentMembers.userId }).from(departmentMembers);
      return rows.map((r) => {
        const own = perms.filter((p) => p.departmentId === r.id).map((p) => p.permission);
        const version = departmentVersion(r, { memberIds: members.filter((m) => m.departmentId === r.id).map((m) => m.userId), projectPermissions: own });
        return toView(r, manages ? own : [], version);
      });
    },
  );

  async function rolesOf(db: Pick<typeof app.db, "select">, departmentId?: string) {
    return db
      .select({
        departmentId: departmentRoles.departmentId,
        userId: departmentRoles.userId,
        permissions: departmentRoles.permissions,
      })
      .from(departmentRoles)
      .where(departmentId ? eq(departmentRoles.departmentId, departmentId) : undefined)
      .orderBy(asc(departmentRoles.departmentId), asc(departmentRoles.userId));
  }

  /**
   * I ruoli di reparto di tutti (fetta 3): chi gestisce la Home di quale
   * reparto. Li legge ogni persona, come l'elenco dei reparti: non danno
   * accesso a dati. Rotta LETTERALE: registrata prima delle `/:id`.
   */
  app.get(
    "/roles",
    {
      config: { mcp: { action: "departments.roles", summary: "I ruoli di reparto: chi gestisce la Home di quale reparto.", effect: "read" }, access: { kind: "user" } },
      schema: { response: { 200: z.array(departmentRoleViewSchema), ...authErrorResponses } },
    },
    async () => rolesOf(app.db),
  );

  /**
   * SOSTITUISCE i ruoli di un reparto (fetta 3): `departments.manage`, che è
   * il permesso dei reparti Home compresa — quindi nessun confronto
   * d'escalation su `department.home.manage` e nessuna riconferma (decisione
   * del maintainer, 9 nov 2026). Una persona senza permessi esce dall'elenco.
   */
  app.put(
    "/:id/roles",
    {
      config: { mcp: { action: "departments.setRoles", summary: "Sostituisce i ruoli di un reparto (chi ne gestisce la Home).", effect: "destructive", note: "Sostituisce l'insieme: chi non c'è più perde il ruolo, chi è in elenco lo ottiene. Cambia cosa possono fare altre persone: dillo all'utente nella riga che annuncia l'azione." }, access: MANAGE },
      schema: {
        params: idParamsSchema,
        body: z.object({
          roles: z
            .array(
              z.object({
                userId: z.uuid(),
                permissions: z
                  .array(z.enum(DEPARTMENT_PERMISSIONS))
                  .max(DEPARTMENT_PERMISSIONS.length),
              }),
            )
            .max(2000),
        }),
        response: {
          200: z.array(departmentRoleViewSchema),
          400: errorSchema,
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const wanted = new Map<string, string[]>();
      for (const r of request.body.roles) {
        const perms = [...new Set([...(wanted.get(r.userId) ?? []), ...r.permissions])];
        wanted.set(r.userId, perms);
      }
      const ids = [...wanted.keys()];
      // Tutto sotto il lock del reparto (fix della review della fetta 3): due
      // PUT concorrenti si serializzano, e `before` è quello davvero sostituito.
      const outcome = await app.db.transaction(async (tx) => {
        const [dept] = await tx
          .select({ id: departments.id })
          .from(departments)
          .where(eq(departments.id, id))
          .for("update");
        if (!dept) return "not_found" as const;
        // Un ruolo di reparto vale solo per chi è nel reparto.
        if (ids.length) {
          const members = await tx
            .select({ id: departmentMembers.userId })
            .from(departmentMembers)
            .where(
              and(eq(departmentMembers.departmentId, id), inArray(departmentMembers.userId, ids)),
            );
          if (members.length !== ids.length) return "invalid_person" as const;
        }
        const before = await rolesOf(tx, id);
        await tx.delete(departmentRoles).where(eq(departmentRoles.departmentId, id));
        const rows = [...wanted].filter(([, p]) => p.length > 0);
        if (rows.length) {
          await tx
            .insert(departmentRoles)
            .values(
              rows.map(([userId, permissions]) => ({ departmentId: id, userId, permissions })),
            );
        }
        const after = await rolesOf(tx, id);
        // Area 9, F2: chi è entrato e chi è uscito fra i gestori della Home.
        const managers = (list: { userId: string; permissions: string[] }[]) =>
          new Set(
            list
              .filter((r) => r.permissions.includes("department.home.manage"))
              .map((r) => r.userId),
          );
        const [was, now] = [managers(before), managers(after)];
        const added = [...now].filter((u) => !was.has(u));
        const removed = [...was].filter((u) => !now.has(u));
        if (added.length || removed.length) {
          await recordChange(tx, {
            type: "department.home_managers_changed",
            actor: request.user!,
            projectId: null,
            data: {
              object: await departmentObject(tx, id),
              params: await peopleParams(tx, added, removed),
            },
          });
        }
        return { before, after };
      });
      if (outcome === "not_found") return apiError(reply, 404, "not_found", "Department not found");
      if (outcome === "invalid_person") {
        return apiError(
          reply,
          400,
          "invalid_person",
          "A department role is only for people in the department",
        );
      }
      // Il registro delle modifiche d'istanza non c'è ancora sul server (area 9): una riga di log.
      const people = (rows: { userId: string; permissions: string[] }[]) =>
        rows.map((r) => ({ userId: r.userId, permissions: r.permissions }));
      request.log.info(
        {
          event: "department.home_managers_changed",
          actorId: request.user!.id,
          departmentId: id,
          before: people(outcome.before),
          after: people(outcome.after),
        },
        "department roles changed",
      );
      return outcome.after;
    },
  );

  // Area 9, F8 (F8-2 = a): l'anteprima di una BOZZA (persone e permessi non
  // ancora salvati), calcolata qui con la regola della scrittura: il client
  // legge, non deduce. Non scrive niente.
  app.post(
    "/:id/preview",
    {
      config: { mcp: { action: "departments.preview", summary: "Anteprima di una modifica di reparto: chi guadagna o perde quali permessi. Non scrive niente.", effect: "write" }, access: MANAGE },
      schema: {
        params: idParamsSchema,
        body: z.object({
          memberIds: z.array(z.uuid()).max(2000),
          projectPermissions: z.array(z.enum(PROJECT_PERMISSIONS)).max(PROJECT_PERMISSIONS.length),
        }),
        response: { 200: departmentPreviewSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const [current] = await app.db
        .select({ id: departments.id })
        .from(departments)
        .where(eq(departments.id, request.params.id));
      if (!current) return apiError(reply, 404, "not_found", "Department not found");
      const draft = {
        memberIds: [...new Set(request.body.memberIds)],
        projectPermissions: [...new Set(request.body.projectPermissions)],
      };
      return judgeDepartmentDraft(
        app.db,
        request.user!,
        await savedDepartmentShape(app.db, current.id),
        draft,
      );
    },
  );

  app.post(
    "/",
    {
      config: { mcp: { action: "departments.create", summary: "Crea un reparto.", effect: "write" }, access: MANAGE },
      schema: {
        body: z.object({ name: nameSchema, colorToken: departmentColorTokenSchema }),
        response: { 201: departmentViewSchema, 409: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { name, colorToken } = request.body;
      if (await nameTaken(name)) {
        return apiError(
          reply,
          409,
          "department_name_taken",
          "A department with this name already exists",
        );
      }
      const row = await app.db.transaction(async (tx) => {
        const [created] = await tx.insert(departments).values({ name, colorToken }).returning();
        await recordChange(tx, {
          type: "department.created",
          actor: request.user!,
          projectId: null,
          data: { object: { type: "department", id: created!.id, label: name } },
        });
        return created!;
      });
      return reply.code(201).send(toView(row, [], departmentVersion(row, { memberIds: [], projectPermissions: [] })));
    },
  );

  app.patch(
    "/:id",
    {
      // Area 9, F8 (F8-3 = a): la riconferma solo quando la scrittura fa
      // ARRIVARE permessi a qualcuno (un permesso aggiunto, o una persona
      // aggiunta a un reparto che ne dà). Nome, colore e togliere no.
      config: { mcp: { action: "departments.update", summary: "Modifica un reparto: nome, colore, membri, permessi di progetto che dà.", effect: "destructive", note: "Togliere membri o permessi toglie accesso a quelle persone; DARE permessi (o aggiungere persone a un reparto che ne dà) chiede la riconferma e da qui risponde session_required: quello si fa dall'app. Cambia cosa possono fare altre persone: dillo all'utente nella riga che annuncia l'azione." }, access: MANAGE, partialReauth: true },
      schema: {
        params: idParamsSchema,
        body: z.object({
          name: nameSchema.optional(),
          colorToken: departmentColorTokenSchema.optional(),
          // L'insieme INTERO delle persone del reparto.
          memberIds: z.array(z.uuid()).max(2000).optional(),
          // Area 9, F8 (R-3): l'insieme INTERO dei permessi di progetto che il
          // reparto dà. Stringhe: un permesso che non è di progetto è un
          // `invalid_permission` col suo nome, non un errore di validazione.
          projectPermissions: z.array(z.string().min(1).max(80)).max(64).optional(),
          // Area 9, F8: la versione della bozza (dall'elenco). Facoltativa: un
          // client di prima non la manda, e per lui vince l'ultima scrittura.
          ifMatch: z.string().min(1).max(64).optional(),
        }),
        response: {
          200: departmentViewSchema,
          ...authErrorResponses,
          400: departmentErrorSchema,
          403: departmentErrorSchema,
          404: errorSchema,
          409: departmentErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { name, colorToken, memberIds, projectPermissions } = request.body;
      const [current] = await app.db.select().from(departments).where(eq(departments.id, id));
      if (!current) return apiError(reply, 404, "not_found", "Department not found");
      if (name !== undefined && (await nameTaken(name, id))) {
        return apiError(
          reply,
          409,
          "department_name_taken",
          "A department with this name already exists",
        );
      }
      const next = memberIds === undefined ? undefined : [...new Set(memberIds)];
      if (next && next.length > 0) {
        const found = await app.db
          .select({ id: users.id, isAgent: users.isAgent })
          .from(users)
          .where(inArray(users.id, next));
        if (found.length !== next.length) {
          return apiError(reply, 400, "person_not_found", "One of the people does not exist");
        }
        // R-L9: Claude (e ogni utente di sistema) non ENTRA in un reparto. Chi
        // c'è già resta (review di F8, I2: il trigger della 0109 l'ha messo nel
        // ripiego in ogni istanza esistente, e il client rimanda l'insieme
        // intero); i permessi non li riceve comunque (`memberPermissionsSql`).
        const already = new Set(
          (await app.db.select({ userId: departmentMembers.userId }).from(departmentMembers).where(eq(departmentMembers.departmentId, id))).map((m) => m.userId),
        );
        if (found.some((u) => u.isAgent && !already.has(u.id)))
          return apiError(reply, 400, "not_a_person", "Claude is not a person of a department");
      }
      const nextPerms =
        projectPermissions === undefined ? undefined : [...new Set(projectPermissions)].sort();
      // F8-3 = a, prima di ogni altro controllo che legge: arrivano permessi a qualcuno?
      const grants = (saved: { memberIds: readonly string[]; projectPermissions: readonly string[] }) => {
        const permsAfter = nextPerms ?? saved.projectPermissions;
        const addsPerm = permsAfter.some((p) => !saved.projectPermissions.includes(p));
        const addsPerson = (next ?? saved.memberIds).some((u) => !saved.memberIds.includes(u));
        return addsPerm || (addsPerson && permsAfter.length > 0);
      };
      // Prima una lettura fuori, per rispondere presto; il giudizio che conta è
      // DENTRO, sul salvato bloccato (registro, area 9): una persona tolta nel
      // frattempo e rimandata da una bozza vecchia senza `ifMatch` è aggiunta.
      let reauthed = grants(await savedDepartmentShape(app.db, id));
      if (reauthed && !(await requireReauth(request, reply))) return reply;
      const write = () => app.db.transaction(async (tx) => {
          // Il reparto bloccato: il giudizio e la scrittura vedono lo stesso salvato.
          const [locked] = await tx.select().from(departments).where(eq(departments.id, id)).for("update");
          const before = await savedDepartmentShape(tx, id);
          if (!reauthed && grants(before)) throw new ReauthNeeded();
          const ifMatch = request.body.ifMatch;
          if (ifMatch !== undefined && ifMatch !== departmentVersion(locked!, before)) {
            throw new RoleRuleError(409, "stale", "The department changed since you loaded it", { version: departmentVersion(locked!, before) });
          }
          const draft = {
            memberIds: next ?? before.memberIds,
            projectPermissions: nextPerms ?? before.projectPermissions,
          };
          // Prima l'escalation (come il prototipo): chi mette `instance.full_admin`
          // senza averlo si sente dire questo, non «non è di progetto».
          const judgement = await judgeDepartmentDraft(
            tx as unknown as Db,
            request.user!,
            before,
            draft,
          );
          if (judgement.missing.length > 0) {
            throw new RoleRuleError(
              403,
              "escalation",
              `You cannot grant a permission you do not have (${judgement.missing[0]})`,
              { permission: judgement.missing[0]!, missing: judgement.missing },
            );
          }
          const notProject = draft.projectPermissions.find(
            (p) => !(PROJECT_PERMISSIONS as readonly string[]).includes(p),
          );
          if (notProject !== undefined)
            throw new RoleRuleError(400, "invalid_permission", "Not a project permission", {
              permission: notProject,
            });
          // F8-5 = a: i progetti dove qualcuno PERDE un permesso del reparto (chi
          // esce, o tutti se un permesso si toglie) non restano senza gestore.
          const removedPeople = before.memberIds.filter((u) => !draft.memberIds.includes(u));
          const removesPerm = before.projectPermissions.some(
            (p) => !draft.projectPermissions.includes(p),
          );
          const losing = removesPerm ? before.memberIds : removedPeople;
          const touched = losing.length
            ? (
                // Anche i progetti visti per workspace (0238, D10): lì il reparto vale.
                await tx
                  .selectDistinct({ projectId: projectAccess.projectId })
                  .from(projectAccess)
                  .where(and(inArray(projectAccess.userId, losing), projectAccessRowCounts))
              ).map((r) => r.projectId)
            : [];
          let row: DepartmentRow = current;
          await keepingManagersIn(tx, touched, async () => {
            row = await writeDepartment(tx, request.user!, current, {
              name,
              colorToken,
              next,
              nextPerms,
              before,
            });
          });
          return { row, perms: draft.projectPermissions, version: departmentVersion(row, draft) };
        });
      try {
        let updated: Awaited<ReturnType<typeof write>>;
        try {
          updated = await write();
        } catch (error) {
          if (!(error instanceof ReauthNeeded)) throw error;
          // La regola della riconferma è UNA (`requireReauth`): risponde lei se manca.
          if (!(await requireReauth(request, reply))) return reply;
          reauthed = true;
          updated = await write();
        }
        return toView(updated.row, updated.perms, updated.version);
      } catch (error) {
        if (error instanceof RoleRuleError && error.code === "last_manager")
          return sendLastManager(reply, request.user!, error);
        return sendRoleRuleError(reply, error);
      }
    },
  );

  /**
   * 409 `last_manager` col `projectId` e il `projectCode`, SOLO se chi guarda
   * vede quel progetto (F8-5 = a; invisibile = 404, senza eccezioni).
   */
  async function sendLastManager(
    reply: Parameters<typeof sendRoleRuleError>[0],
    viewer: SessionUser,
    error: RoleRuleError,
  ) {
    const projectId =
      typeof error.extra["projectId"] === "string" ? error.extra["projectId"] : null;
    const visible = projectId
      ? await projectPermissionsFor(app.db, viewer, projectId, { includeArchived: true })
      : null;
    const [p] =
      projectId && visible
        ? await app.db
            .select({ code: projects.code })
            .from(projects)
            .where(eq(projects.id, projectId))
        : [];
    return reply
      .code(409)
      .send({
        code: error.code,
        message: error.message,
        // Invisibile = 404, senza eccezioni: id e codice solo a chi vede il progetto.
        ...(p ? { projectId: projectId!, projectCode: p.code } : {}),
      });
  }

  app.delete(
    "/:id",
    {
      config: { mcp: { action: "departments.delete", summary: "Elimina un reparto: i suoi membri perdono i permessi che dava.", effect: "destructive", note: "Cambia cosa possono fare altre persone: dillo all'utente nella riga che annuncia l'azione." }, access: MANAGE },
      schema: {
        params: idParamsSchema,
        querystring: z.object({ moveTasksTo: z.uuid().optional() }),
        response: {
          204: z.null(),
          400: errorSchema,
          404: errorSchema,
          409: departmentErrorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { moveTasksTo } = request.query;
      const [current] = await app.db.select().from(departments).where(eq(departments.id, id));
      if (!current) return apiError(reply, 404, "not_found", "Department not found");
      if (current.isDefault) {
        return apiError(
          reply,
          400,
          "department_is_default",
          "The fallback department cannot be deleted",
        );
      }
      // Conteggio e trasloco nella stessa transazione, col reparto bloccato:
      // una task assegnata al reparto nel frattempo si sposta anche lei, o il
      // controllo la vede — mai un 500 dalla FK.
      let outcome: "department_has_tasks" | "department_move_target_invalid" | null;
      try {
        outcome = await app.db.transaction(async (tx) => {
          await tx.execute(sql`select 1 from "departments" where "id" = ${id} for update`);
          // Area 9, F8 (F8-5 = a): un reparto che dava permessi, eliminato, non
          // lascia un progetto delle sue persone senza gestore.
          const shape = await savedDepartmentShape(tx, id);
          const touched =
            shape.projectPermissions.length > 0 && shape.memberIds.length > 0
              ? (
                  await tx
                    .selectDistinct({ projectId: projectAccess.projectId })
                    .from(projectAccess)
                    .where(and(inArray(projectAccess.userId, [...shape.memberIds]), projectAccessRowCounts))
                ).map((r) => r.projectId)
              : [];
          const [{ count }] = (await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(tickets)
            .where(eq(tickets.departmentId, id))) as [{ count: number }];
          if (count > 0) {
            if (!moveTasksTo) return "department_has_tasks" as const;
            const [target] =
              moveTasksTo === id
                ? []
                : await tx
                    .select({ id: departments.id })
                    .from(departments)
                    .where(eq(departments.id, moveTasksTo));
            if (!target) return "department_move_target_invalid" as const;
            // In SQL: il trasloco non è lavoro sulla task, `updated_at` resta.
            // Il cambio di reparto non entra nel feed (scelta della fetta 1).
            await tx.execute(
              sql`update "tickets" set "department_id" = ${moveTasksTo} where "department_id" = ${id}`,
            );
          }
          await keepingManagersIn(tx, touched, async () => {
            await tx.delete(departments).where(eq(departments.id, id));
          });
          await recordChange(tx, {
            type: "department.deleted",
            actor: request.user!,
            projectId: null,
            data: { object: { type: "department", id, label: current.name } },
          });
          return null;
        });
      } catch (error) {
        if (error instanceof RoleRuleError && error.code === "last_manager")
          return sendLastManager(reply, request.user!, error);
        throw error;
      }
      if (outcome === "department_has_tasks") {
        return apiError(reply, 400, "department_has_tasks", "Move the department's tasks first");
      }
      if (outcome === "department_move_target_invalid") {
        return apiError(
          reply,
          400,
          "department_move_target_invalid",
          "Choose another existing department",
        );
      }
      return reply.code(204).send(null);
    },
  );
}
