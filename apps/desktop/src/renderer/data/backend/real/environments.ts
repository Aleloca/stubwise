import { ApiError } from "@stubwise/api-client";
import type {
  CreateEnvironmentInput,
  PatchEnvironmentInput,
  ProjectEnvironment as ServerEnvironment,
  Reader,
} from "@stubwise/shared";
import type { EnvironmentInput, EnvironmentList, EnvironmentView } from "../../releases";
import { asPrototypeError } from "./automationRefs";

// Gli ambienti della build app (area 8, F4a) sopra le rotte di F1, con le
// firme del prototipo (`data/releases/reads.ts`, `writes.ts`). Il prototipo
// ha una riga «tutto il progetto» (`repositoryId: null`): sul server è il
// `serverId` dell'ambiente, che il server stende su ogni repository; le righe
// per repository che dicono altro sono le eccezioni. I server si nominano per
// codice (`SRV-<n>`) e si mandano per id, fra quelli che chi scrive vede
// (S3): uno che non vede è `invalid: serverCode`, come nel prototipo.

type Env = Reader<ServerEnvironment>;

/** Le rotte (sul client vero: `client.environments`, `client.repositories`, `client.servers`). */
export interface EnvironmentsApi {
  list(projectId: string): Promise<Env[]>;
  repositories(projectId: string): Promise<{ id: string; name: string }[]>;
  /** I server che chi guarda vede (per codice e id). */
  servers(): Promise<{ id: string; code: string | null }[]>;
  /** `environments.manage` di chi guarda, quando nessun ambiente lo dice. */
  canManage(projectId: string): Promise<boolean>;
  create(projectId: string, body: CreateEnvironmentInput): Promise<Env>;
  update(projectId: string, environmentId: string, patch: PatchEnvironmentInput): Promise<Env>;
  remove(projectId: string, environmentId: string): Promise<void>;
  /** I container di un ambiente su un suo server (R0-D, `PUT …/containers`). */
  setContainers(
    projectId: string,
    environmentId: string,
    body: { serverId: string; containers: string[] },
  ): Promise<{ serverId: string; containers: string[] }>;
}

/** Gli errori nelle parole del prototipo: un server che chi scrive non vede è un codice sbagliato. */
function words(error: unknown): unknown {
  if (error instanceof ApiError && error.code === "server_not_visible") {
    return new Error("invalid: serverCode");
  }
  return asPrototypeError(error);
}

async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw words(error);
  }
}

/** Un ambiente nella forma del prototipo; `null` per un tipo che l'app non conosce. */
export function environmentOf(e: Env): EnvironmentView | null {
  if (e.kind === "__unknown__") return null;
  const perRepo = e.servers.filter((s) => s.serverCode);
  const whole = e.serverId && e.serverCode ? { id: e.serverId, code: e.serverCode } : null;
  // La riga di tutto il progetto prende il commit da una sua repository.
  const sample = whole ? perRepo.find((s) => s.serverId === whole.id) : undefined;
  return {
    id: e.id,
    projectId: e.projectId,
    name: e.name,
    kind: e.kind,
    url: e.url,
    servers: [
      ...(whole
        ? [
            {
              repositoryId: null,
              serverCode: whole.code,
              reportedSha: sample?.reportedSha ?? e.runningCommitSha ?? null,
              reportedAt: sample?.reportedAt ?? null,
              releaseCode: sample?.releaseCode ?? null,
              // I container stanno sulle righe per repository: il server li stende tutte uguali.
              containers: sample?.containers ?? [],
            },
          ]
        : []),
      // Le eccezioni: le repository su un server diverso da quello di tutto il progetto.
      ...perRepo
        .filter((s) => !whole || s.serverId !== whole.id)
        .map((s) => ({
          repositoryId: s.repositoryId,
          serverCode: s.serverCode!,
          reportedSha: s.reportedSha ?? null,
          reportedAt: s.reportedAt ?? null,
          releaseCode: s.releaseCode ?? null,
          containers: s.containers ?? [],
        })),
    ],
  };
}

export function createRealEnvironments(api: EnvironmentsApi) {
  /** Gli ambienti letti, per progetto e tipo (il tipo non cambia in modifica). */
  const known = new Map<string, Env>();

  /** Da codice a id, fra i server che chi scrive vede. */
  async function idsOf(rows: EnvironmentInput["servers"]) {
    const visible = new Map(
      (await api.servers()).flatMap((s) => (s.code ? [[s.code, s.id] as const] : [])),
    );
    return rows.map((r) => {
      const code = r.serverCode.trim().toUpperCase();
      const id = visible.get(code);
      if (!id) throw new Error("invalid: serverCode");
      return { repositoryId: r.repositoryId, serverId: id };
    });
  }

  return {
    async listEnvironments(projectId: string): Promise<EnvironmentList> {
      const [envs, repositories] = await Promise.all([
        call(() => api.list(projectId)),
        call(() => api.repositories(projectId)),
      ]);
      for (const e of envs) known.set(e.id, e);
      const codeOf = new Map(
        envs.flatMap((e) => [
          ...(e.serverId && e.serverCode ? [[e.serverId, e.serverCode] as const] : []),
          ...e.servers.flatMap((s) => (s.serverCode ? [[s.serverId, s.serverCode] as const] : [])),
        ]),
      );
      const onlyHere = [...new Set(envs.flatMap((e) => e.onlyHere ?? []))]
        .flatMap((id) => codeOf.get(id) ?? [])
        .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
      const canManage = envs[0]?.canManage ?? (await api.canManage(projectId));
      return {
        canManage,
        environments: envs.flatMap((e) => environmentOf(e) ?? []),
        repositories: repositories.map((r) => ({ id: r.id, name: r.name })),
        onlyHere,
      };
    },

    async createEnvironment(projectId: string, input: EnvironmentInput) {
      const rows = await idsOf(input.servers);
      const whole = rows.find((r) => r.repositoryId === null);
      const body: CreateEnvironmentInput = {
        name: input.name.trim(),
        kind: input.kind,
        url: input.url?.trim() || null,
        serverId: whole?.serverId ?? null,
        servers: rows.flatMap((r) =>
          r.repositoryId ? [{ repositoryId: r.repositoryId, serverId: r.serverId }] : [],
        ),
      };
      const e = await call(() => api.create(projectId, body));
      known.set(e.id, e);
      const view = environmentOf(e);
      if (!view) throw new Error("not_found");
      return view;
    },

    async updateEnvironment(id: string, patch: Partial<EnvironmentInput>) {
      const before = known.get(id);
      if (!before) throw new Error("not_found");
      // Il server non cambia il tipo: nella build app il dialogo lo blocca.
      if (patch.kind !== undefined && patch.kind !== before.kind) throw new Error("invalid: kind");
      const body: PatchEnvironmentInput = {
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.url !== undefined ? { url: patch.url?.trim() || null } : {}),
      };
      if (patch.servers !== undefined) {
        const rows = await idsOf(patch.servers);
        const whole = rows.find((r) => r.repositoryId === null);
        const named = new Set(rows.flatMap((r) => (r.repositoryId ? [r.repositoryId] : [])));
        body.serverId = whole?.serverId ?? null;
        body.servers = [
          ...rows.flatMap((r) =>
            r.repositoryId ? [{ repositoryId: r.repositoryId, serverId: r.serverId }] : [],
          ),
          // Una repository che prima aveva un server suo e ora no: torna a quello
          // di tutto il progetto (o a nessuno).
          ...before.servers
            .filter((s) => !named.has(s.repositoryId) && s.serverId !== before.serverId)
            .map((s) => ({ repositoryId: s.repositoryId, serverId: whole?.serverId ?? null })),
        ];
      }
      const e = await call(() => api.update(before.projectId, id, body));
      known.set(e.id, e);
      const view = environmentOf(e);
      if (!view) throw new Error("not_found");
      return view;
    },

    /**
     * I container di un ambiente su un suo server (R0-D): il server per
     * codice, fra quelli dell'ambiente letto; uno che non usa è
     * `server_not_in_environment` prima di scrivere, come il 422 del server.
     */
    async setEnvironmentContainers(
      id: string,
      input: { serverCode: string; containers: string[] },
    ): Promise<{ serverCode: string; containers: string[] }> {
      const before = known.get(id);
      if (!before) throw new Error("not_found");
      const code = input.serverCode.trim().toUpperCase();
      const serverId =
        (before.serverCode === code ? before.serverId : null) ??
        before.servers.find((s) => s.serverCode === code)?.serverId;
      if (!serverId) throw new Error("invalid: server_not_in_environment");
      const saved = await call(() =>
        api.setContainers(before.projectId, id, { serverId, containers: input.containers }),
      );
      return { serverCode: code, containers: saved.containers };
    },

    /**
     * Area 9, F5: un ambiente con file d'ambiente vuole la riconferma (403
     * `reauth_required`), che la pagina chiede con `useReauth` prima di
     * ripartire; l'ambiente resta noto finché non è eliminato davvero.
     */
    async deleteEnvironment(
      id: string,
    ): Promise<{ ok: true } | { ok: false; error: "reauth_required" }> {
      const before = known.get(id);
      if (!before) throw new Error("not_found");
      try {
        await api.remove(before.projectId, id);
      } catch (error) {
        if (error instanceof ApiError && error.code === "reauth_required")
          return { ok: false, error: "reauth_required" };
        throw words(error);
      }
      known.delete(id);
      return { ok: true };
    },
  };
}
