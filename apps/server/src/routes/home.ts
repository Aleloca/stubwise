import { departments } from "@stubwise/db";
import { departmentHomeViewSchema, meHomeViewSchema, setHomeBodySchema } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { apiError } from "../errors.js";
import {
  blockError,
  canManageDepartmentHome,
  departmentHomeOf,
  markDepartmentHomeSeen,
  meHome,
  resetPersonalHome,
  setDepartmentHome,
  setPersonalHome,
} from "../services/home.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * La Home a blocchi (integrazione area 2, fetta 3). `/api/me/home` risponde
 * con la Home già risolta per chi guarda; la Home di un reparto la legge
 * chiunque (è la disposizione predefinita, non dati) e la cambia un full
 * admin o chi ha `department.home.manage` in quel reparto, con i soli filtri
 * pubblici. Regole e servizio in `services/home.ts`.
 */

const BLOCK_MESSAGES = {
  filter_not_visible: "A filter block names a filter you cannot see",
  filter_not_public: "A department Home can only show public filters",
} as const;

const departmentParams = z.object({ departmentId: z.uuid() });

export async function homeRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/me/home",
    {
      config: { access: { kind: "user" } },
      schema: { response: { 200: meHomeViewSchema, ...authErrorResponses } },
    },
    async (request) => meHome(app.db, request.user!),
  );

  app.put(
    "/me/home",
    {
      config: { access: { kind: "user" } },
      schema: {
        body: setHomeBodySchema,
        response: { 200: meHomeViewSchema, 400: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const viewer = request.user!;
      const error = await blockError(app.db, viewer, request.body.blocks, { publicOnly: false });
      if (error) return apiError(reply, 400, error, BLOCK_MESSAGES[error]);
      await setPersonalHome(app.db, viewer, request.body.blocks);
      return meHome(app.db, viewer);
    },
  );

  app.delete(
    "/me/home",
    {
      config: { access: { kind: "user" } },
      schema: { response: { 204: z.null(), ...authErrorResponses } },
    },
    async (request, reply) => {
      await resetPersonalHome(app.db, request.user!);
      return reply.code(204).send(null);
    },
  );

  app.post(
    "/me/home/seen/:departmentId",
    {
      config: { access: { kind: "user" } },
      schema: { params: departmentParams, response: { 204: z.null(), ...authErrorResponses } },
    },
    async (request, reply) => {
      await markDepartmentHomeSeen(app.db, request.user!, request.params.departmentId);
      return reply.code(204).send(null);
    },
  );

  async function departmentExists(id: string): Promise<boolean> {
    const [row] = await app.db.select({ id: departments.id }).from(departments).where(eq(departments.id, id));
    return row !== undefined;
  }

  app.get(
    "/departments/:departmentId/home",
    {
      config: { access: { kind: "user" } },
      schema: {
        params: departmentParams,
        response: { 200: departmentHomeViewSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { departmentId } = request.params;
      if (!(await departmentExists(departmentId))) return apiError(reply, 404, "not_found", "Department not found");
      return departmentHomeOf(app.db, departmentId);
    },
  );

  app.put(
    "/departments/:departmentId/home",
    {
      config: { access: { kind: "user" } },
      schema: {
        params: departmentParams,
        body: setHomeBodySchema,
        response: { 200: departmentHomeViewSchema, 400: errorSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const viewer = request.user!;
      const { departmentId } = request.params;
      if (!(await departmentExists(departmentId))) return apiError(reply, 404, "not_found", "Department not found");
      if (!(await canManageDepartmentHome(app.db, viewer, departmentId))) {
        return apiError(reply, 403, "forbidden", "You cannot manage this department's Home");
      }
      const error = await blockError(app.db, viewer, request.body.blocks, { publicOnly: true });
      if (error) return apiError(reply, 400, error, BLOCK_MESSAGES[error]);
      return setDepartmentHome(app.db, viewer, departmentId, request.body.blocks);
    },
  );
}
