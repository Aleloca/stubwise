import { ApiError } from "@stubwise/api-client";
import type { EnvFileView } from "../../projectSettings/envFiles";
import type {
  RemoteRepository,
  RepositorySaveWarning,
  RepositoryView,
} from "../../projectSettings/repositories";
import type { ProjectRefusal, ProjectResult } from "../../projectSettings/types";
import type { TestOutcome } from "../../instance/state";
import { appClient } from "./client";

// Progetto → Settings → Repositories nella build app (ritiro del web vecchio,
// inventario §1.3) sulle rotte che il web vecchio usa: l'elenco, la pagina del
// repository, il webhook, i file d'ambiente e la creazione guidata. Le firme
// sono quelle del prototipo (`projectSettings/repositories.ts`,
// `envFiles.ts`). Differenze dichiarate (parità):
// - scegliere un account git (creare, sfogliare i repository di un account,
//   cambiare l'account) vuole anche `git_accounts.manage` d'istanza: la regola
//   del server, decisa da 46, a cui il prototipo si allinea;
// - la verifica d'accesso del server guarda il repository, il ramo lo
//   controlla qui sui rami della piattaforma; non resta sul server (la
//   ricorda la pagina);
// - il webhook «failed» non si salva sul server: resta in questa sessione fino
//   al tentativo dopo;
// - il segreto del webhook (la creazione lo dà una volta) e i valori delle
//   variabili d'ambiente non passano mai di qui.
// Le pagine vanno per id, le rotte del repository per slug: l'elenco ricorda
// lo slug di ogni id, i file d'ambiente il repository di ogni file.

/* eslint-disable @typescript-eslint/no-explicit-any -- forme del server lette dai Reader */
type Any = any;

/** Le rotte (sul client vero: `client.repositories`, `client.gitAccounts`, `client.environments`, `client.auth`). */
export interface ProjectRepositoriesApi {
  list(projectId: string): Promise<Any[]>;
  me(): Promise<{ instancePermissions: string[]; projectPermissions: Record<string, string[]> }>;
  create(input: Any): Promise<Any>;
  update(slug: string, patch: Any): Promise<Any>;
  configureWebhook(slug: string): Promise<Any>;
  remoteRepositories(gitAccountId: string): Promise<{ fullName: string; cloneUrl?: string; defaultBranch: string | null }[]>;
  branches(gitAccountId: string, fullName: string): Promise<{ branches: string[]; defaultBranch: string | null }>;
  validateRepo(gitAccountId: string, fullName: string): Promise<{ ok: boolean; checks?: { name: string; ok: boolean; detail: string }[] }>;
  gitAccountName(gitAccountId: string): Promise<{ provider: "github" | "bitbucket"; name: string } | null>;
  environments(projectId: string): Promise<{ id: string; name: string; kind: string }[]>;
  envFiles(repositoryId: string): Promise<{ id: string; environmentId: string; path: string; vars: { key: string; setAt?: string }[] }[]>;
  createEnvFile(repositoryId: string, input: { environmentId: string; path: string }): Promise<{ id: string }>;
  importEnvFile(repositoryId: string, fileId: string, content: string): Promise<{ imported: string[]; replaced: string[]; skipped: { line: number; reason: string }[] }>;
  setEnvVar(repositoryId: string, fileId: string, key: string, value: string): Promise<void>;
  removeEnvVar(repositoryId: string, fileId: string, key: string): Promise<void>;
  deleteEnvFile(repositoryId: string, fileId: string): Promise<void>;
}

const HOST = { github: "github.com", bitbucket: "bitbucket.org" } as const;

/**
 * Il tetto dei rami che la piattaforma elenca (`listBranches`, ~200): un
 * elenco così lungo può essere TRONCATO, e un ramo che non c'è non vuol dire
 * che non esista (revisione I3).
 */
const BRANCH_CAP = 200;

/** Gli avvisi non bloccanti del salvataggio che la pagina sa dire; un codice nuovo del server si tace. */
const SAVE_WARNINGS: readonly RepositorySaveWarning[] = ["main_account_identity_unresolved", "default_review_account_invalid"];
const warningsOf = (saved: Any): RepositorySaveWarning[] =>
  ((saved?.warnings ?? []) as string[]).filter((w): w is RepositorySaveWarning => (SAVE_WARNINGS as string[]).includes(w));

/** Il messaggio della piattaforma in un 422/400 del server (lo legge chi configura), o null. */
const platformMessage = (error: unknown): string | null =>
  error instanceof ApiError && error.message.trim() !== "" ? error.message : null;

/** `owner/repo` dall'indirizzo del repository (il nome da solo se non si legge). */
function fullNameOf(repoUrl: string, name: string): string {
  try {
    const path = new URL(repoUrl).pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
    return path.includes("/") ? path : name;
  } catch {
    return name;
  }
}

/** I rifiuti del server nella forma della pagina. `invalid` porta il codice del server come motivo. */
function refusalOf(error: unknown): ProjectRefusal {
  if (!(error instanceof ApiError)) throw error;
  const code = error.code ?? "";
  if (code === "reauth_required") return { ok: false, error: "reauth_required" };
  if (error.status === 404) return { ok: false, error: "not_found" };
  if (error.status === 403) return { ok: false, error: "forbidden" };
  if (error.status === 400 || error.status === 409 || error.status === 422)
    return { ok: false, error: "invalid", reason: reasonOf(code) } as ProjectRefusal;
  throw error;
}

/** I codici del server coi motivi che la pagina sa spiegare. */
function reasonOf(code: string): string {
  if (code.startsWith("review_account") || code.includes("review")) return "review_account";
  if (code.includes("git_account")) return "git_account";
  if (code.includes("protected_branch")) return "protected_branch";
  if (code === "env_file_path_taken" || code === "conflict") return "path_taken";
  return code || "invalid";
}

const has = (me: { instancePermissions: string[]; projectPermissions: Record<string, string[]> }, projectId: string, permission: string) =>
  me.instancePermissions.includes("instance.full_admin") || (me.projectPermissions[projectId] ?? []).includes(permission);

export function createRealProjectRepositories(api: ProjectRepositoriesApi) {
  /** id → slug, progetto (le rotte del repository vanno per slug). */
  const known = new Map<string, { slug: string; projectId: string }>();
  /** fileId → repositoryId (le rotte dei file vanno sotto il repository). */
  const fileRepository = new Map<string, string>();
  /** I webhook la cui ultima configurazione è fallita in questa sessione. */
  const failedWebhooks = new Set<string>();

  /** Lo slug di un repository letto in questa sessione; null se non lo si conosce (→ `not_found`). */
  const slugOf = (repositoryId: string): string | null => known.get(repositoryId)?.slug ?? null;
  /** L'indirizzo di clone che la piattaforma ha dato per (account, repository), se l'elenco è passato di qui. */
  const cloneUrls = new Map<string, string>();

  /** I nomi completi dei repository già nel progetto (dall'elenco del server). */
  async function fullNamesIn(projectId: string): Promise<Set<string>> {
    try {
      // Senza maiuscole: `Audin/Web` e `audin/web` sono lo stesso repository (revisione M5).
      return new Set((await api.list(projectId)).map((r: Any) => fullNameOf(r.repoUrl, r.name).toLowerCase()));
    } catch {
      return new Set();
    }
  }

  function viewOf(r: Any): RepositoryView {
    known.set(r.id, { slug: r.slug, projectId: r.projectId });
    const explicitReview = r.effectiveReviewAccount?.source === "explicit" ? r.effectiveReviewAccount : null;
    return {
      id: r.id,
      name: r.name,
      fullName: fullNameOf(r.repoUrl, r.name),
      url: r.repoUrl,
      provider: r.provider === "github" || r.provider === "bitbucket" ? r.provider : null,
      defaultBranch: r.defaultBranch,
      releaseBranch: r.releaseBranch ?? r.defaultBranch,
      gitAccount: r.gitAccountId ? { id: r.gitAccountId, name: r.gitAccountName ?? "" } : null,
      reviewAccount: r.reviewGitAccountId
        ? { id: r.reviewGitAccountId, name: explicitReview?.name ?? "" }
        : null,
      installCommand: r.installCommand ?? null,
      testCommand: r.testCommand ?? null,
      graphEnabled: r.graphEnabled === true,
      protectedBranches: [...(r.protectedBranches ?? [])],
      webhook: {
        state: failedWebhooks.has(r.id) ? "failed" : r.webhookConfiguredAt ? "configured" : "not_configured",
        configuredAt: r.webhookConfiguredAt ?? null,
      },
    };
  }

  return {
    async listProjectRepositories(
      projectId: string,
    ): Promise<{ canManage: boolean; canChooseGitAccount: boolean; repositories: RepositoryView[] } | null> {
      // Chi vede e chi gestisce: i permessi che il server calcola (`/api/auth/me`).
      const me = await api.me();
      if (!has(me, projectId, "repos.view")) return null;
      const rows = await api.list(projectId);
      return {
        canManage: has(me, projectId, "repos.manage"),
        canChooseGitAccount:
          me.instancePermissions.includes("instance.full_admin") || me.instancePermissions.includes("git_accounts.manage"),
        repositories: rows.map(viewOf),
      };
    },

    async listRemoteRepositories(gitAccountId: string, projectId?: string): Promise<RemoteRepository[]> {
      let rows: { fullName: string; cloneUrl?: string; defaultBranch: string | null }[];
      try {
        rows = await api.remoteRepositories(gitAccountId);
      } catch (error) {
        if (error instanceof ApiError && error.status === 403) throw new Error("forbidden");
        if (error instanceof ApiError && error.status === 404) return [];
        throw error;
      }
      // Già nel progetto, per nome completo: la pagina lo legge, non lo ricalcola.
      const projectFullNames = projectId ? await fullNamesIn(projectId) : new Set<string>();
      for (const r of rows) if (r.cloneUrl) cloneUrls.set(`${gitAccountId}|${r.fullName}`, r.cloneUrl);
      return rows.map((r) => ({
        fullName: r.fullName,
        defaultBranch: r.defaultBranch ?? "main",
        // I rami si caricano per il repository scelto (`listRemoteBranches`): la
        // piattaforma non li dà nell'elenco.
        branches: [r.defaultBranch ?? "main"],
        inProject: projectFullNames.has(r.fullName.toLowerCase()),
      }));
    },

    async listRemoteBranches(
      gitAccountId: string,
      fullName: string,
    ): Promise<{ branches: string[]; defaultBranch: string }> {
      let r: { branches: string[]; defaultBranch: string | null };
      try {
        r = await api.branches(gitAccountId, fullName);
      } catch (error) {
        // 422: la piattaforma non lo fa vedere a questo account. La pagina lo dice (revisione M6).
        if (error instanceof ApiError && error.status === 422) throw new Error("not_visible");
        if (error instanceof ApiError && error.status === 403) throw new Error("forbidden");
        throw error;
      }
      const defaultBranch = r.defaultBranch ?? r.branches[0] ?? "main";
      // Il predefinito per primo, come il prototipo.
      return { defaultBranch, branches: [defaultBranch, ...r.branches.filter((b) => b !== defaultBranch)] };
    },

    async checkRepositoryAccess(input: {
      projectId: string;
      gitAccountId: string;
      fullName: string;
      branch: string;
    }): Promise<ProjectResult<{ outcome: TestOutcome; detail: string | null }>> {
      // Le distinzioni del web vecchio (revisione M2): le credenziali che non si
      // decifrano, i controlli falliti coi loro dettagli, il repository che
      // l'account non vede (422 dei rami), la piattaforma che non risponde.
      let check: { ok: boolean; checks?: { name: string; ok: boolean; detail: string }[] };
      try {
        check = await api.validateRepo(input.gitAccountId, input.fullName);
      } catch (error) {
        if (error instanceof ApiError && error.code === "credentials_undecryptable")
          return { ok: true, outcome: "invalid_credentials", detail: "credentials_undecryptable" };
        if (error instanceof ApiError && error.status === 422) return { ok: true, outcome: "unreachable", detail: platformMessage(error) };
        if (error instanceof TypeError) return { ok: true, outcome: "unreachable", detail: null };
        return refusalOf(error);
      }
      if (!check.ok) {
        const failed = (check.checks ?? []).filter((c) => !c.ok && c.detail.trim() !== "").map((c) => c.detail);
        return { ok: true, outcome: "invalid_credentials", detail: failed.length > 0 ? failed.join(" · ") : null };
      }
      let branches: { branches: string[]; defaultBranch: string | null };
      try {
        branches = await api.branches(input.gitAccountId, input.fullName);
      } catch (error) {
        if (error instanceof ApiError && error.status === 422) return { ok: true, outcome: "invalid_credentials", detail: platformMessage(error) };
        if (error instanceof ApiError && error.code === "credentials_undecryptable")
          return { ok: true, outcome: "invalid_credentials", detail: "credentials_undecryptable" };
        if (error instanceof TypeError) return { ok: true, outcome: "unreachable", detail: null };
        return refusalOf(error);
      }
      // Il predefinito vale sempre; con un elenco che può essere troncato (il
      // tetto della piattaforma) un ramo che manca non si rifiuta (revisione I3).
      const listed = input.branch === branches.defaultBranch || branches.branches.includes(input.branch);
      if (!listed && branches.branches.length < BRANCH_CAP)
        return { ok: false, error: "invalid", reason: "branch" } as ProjectRefusal;
      return { ok: true, outcome: "ok", detail: null };
    },

    async createRepository(
      projectId: string,
      input: {
        gitAccountId: string;
        fullName: string;
        name: string;
        branch: string;
        installCommand: string | null;
        testCommand: string | null;
      },
    ): Promise<ProjectResult<{ repositoryId: string; warnings: RepositorySaveWarning[] }>> {
      const name = input.name.trim();
      if (name === "" || /[\s/]/.test(name)) return { ok: false, error: "invalid", reason: "name" } as ProjectRefusal;
      let created: Any;
      let defaultBranch: string;
      try {
        // Un nome già usato nel progetto (senza maiuscole): la regola della
        // pagina, che il server non ha (revisione M5, divergenza dichiarata).
        const names = new Set((await api.list(projectId)).map((r: Any) => String(r.name).toLowerCase()));
        if (names.has(name.toLowerCase())) return { ok: false, error: "invalid", reason: "name_taken" } as ProjectRefusal;
        const account = await api.gitAccountName(input.gitAccountId);
        if (!account) return { ok: false, error: "invalid", reason: "git_account" } as ProjectRefusal;
        const branches = await api.branches(input.gitAccountId, input.fullName);
        defaultBranch = branches.defaultBranch ?? input.branch;
        const command = (v: string | null) => (v && v.trim() !== "" ? v.trim() : null);
        created = await api.create({
          projectId,
          name,
          gitAccountId: input.gitAccountId,
          // L'indirizzo che la piattaforma ha dato; ricostruito solo se l'elenco non è passato di qui.
          repoUrl: cloneUrls.get(`${input.gitAccountId}|${input.fullName}`) ?? `https://${HOST[account.provider]}/${input.fullName}`,
          defaultBranch,
          testCommand: command(input.testCommand),
          installCommand: command(input.installCommand),
        });
      } catch (error) {
        return refusalOf(error);
      }
      // Dal 201 in poi il repository ESISTE: niente più rifiuti, o un Retry
      // creerebbe un doppione (revisione I2). Quello che non riesce dopo è un avviso.
      known.set(created.id, { slug: created.slug, projectId });
      const warnings = warningsOf(created);
      // Il ramo scelto diverso dal predefinito è quello verso cui Claude apre le PR.
      if (input.branch !== defaultBranch) {
        try {
          for (const w of warningsOf(await api.update(created.slug, { releaseBranch: input.branch })))
            if (!warnings.includes(w)) warnings.push(w);
        } catch {
          warnings.push("release_branch_not_set");
        }
      }
      return { ok: true, repositoryId: created.id, warnings };
    },

    async updateRepository(
      repositoryId: string,
      patch: Partial<Pick<RepositoryView, "name" | "url" | "installCommand" | "testCommand" | "graphEnabled" | "protectedBranches">> & {
        gitAccountId?: string;
        reviewGitAccountId?: string | null;
      },
    ): Promise<ProjectResult<{ warnings: RepositorySaveWarning[] }>> {
      if (patch.name !== undefined && (patch.name.trim() === "" || /[\s/]/.test(patch.name.trim())))
        return { ok: false, error: "invalid", reason: "name" } as ProjectRefusal;
      if (patch.url !== undefined && !/^https:\/\/\S+$/.test(patch.url.trim()))
        return { ok: false, error: "invalid", reason: "url" } as ProjectRefusal;
      const bad = (patch.protectedBranches ?? []).findIndex((b) => b === "" || /\s/.test(b));
      if (bad >= 0) return { ok: false, error: "invalid", reason: "protected_branch", line: bad + 1 } as ProjectRefusal;
      const command = (v: string | null | undefined) => (v === undefined ? undefined : v && v.trim() !== "" ? v.trim() : null);
      const slug = slugOf(repositoryId);
      if (!slug) return { ok: false, error: "not_found" };
      try {
        const saved = await api.update(slug, {
          ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
          ...(patch.url !== undefined ? { repoUrl: patch.url.trim() } : {}),
          ...(patch.gitAccountId !== undefined ? { gitAccountId: patch.gitAccountId } : {}),
          ...(patch.reviewGitAccountId !== undefined ? { reviewGitAccountId: patch.reviewGitAccountId } : {}),
          ...(patch.testCommand !== undefined ? { testCommand: command(patch.testCommand) } : {}),
          ...(patch.installCommand !== undefined ? { installCommand: command(patch.installCommand) } : {}),
          ...(patch.graphEnabled !== undefined ? { graphEnabled: patch.graphEnabled } : {}),
          ...(patch.protectedBranches !== undefined ? { protectedBranches: [...patch.protectedBranches] } : {}),
        });
        return { ok: true, warnings: warningsOf(saved) };
      } catch (error) {
        return refusalOf(error);
      }
    },

    async configureRepositoryWebhook(
      repositoryId: string,
    ): Promise<ProjectResult<{ state: "configured" | "failed"; updated: boolean; detail: string | null }>> {
      const slug = slugOf(repositoryId);
      if (!slug) return { ok: false, error: "not_found" };
      try {
        const r = await api.configureWebhook(slug);
        failedWebhooks.delete(repositoryId);
        return { ok: true, state: "configured", updated: r.updated === true, detail: null };
      } catch (error) {
        // La piattaforma rifiuta (lo scope, le credenziali): «failed», come il prototipo.
        if (error instanceof ApiError && (error.status === 422 || error.code === "credentials_undecryptable")) {
          failedWebhooks.add(repositoryId);
          // Il messaggio della piattaforma (lo scope che manca, …): lo legge chi configura (revisione M3).
          return { ok: true, state: "failed", updated: false, detail: platformMessage(error) };
        }
        return refusalOf(error);
      }
    },

    async listEnvFiles(repositoryId: string): Promise<{
      environments: {
        id: string;
        name: string;
        kind: "test" | "staging" | "production";
        reachesClaude: boolean;
        files: EnvFileView[];
      }[];
    }> {
      const repository = known.get(repositoryId);
      if (!repository) throw new Error("not_found");
      let files: Awaited<ReturnType<ProjectRepositoriesApi["envFiles"]>>;
      try {
        files = await api.envFiles(repositoryId);
      } catch (error) {
        if (error instanceof ApiError && error.status === 403) throw new Error("forbidden");
        if (error instanceof ApiError && error.status === 404) throw new Error("not_found");
        throw error;
      }
      const order = ["test", "staging", "production"];
      const environments = (await api.environments(repository.projectId))
        .filter((e) => order.includes(e.kind))
        .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
      for (const f of files) fileRepository.set(f.id, repositoryId);
      return {
        environments: environments.map((e) => ({
          id: e.id,
          name: e.name,
          kind: e.kind as "test" | "staging" | "production",
          reachesClaude: e.kind === "test",
          files: files
            .filter((f) => f.environmentId === e.id)
            .map((f) => ({ id: f.id, path: f.path, keys: f.vars.map((v) => ({ key: v.key, setAt: v.setAt ?? null })) })),
        })),
      };
    },

    async createEnvFile(
      repositoryId: string,
      input: { environmentId: string; path: string },
    ): Promise<ProjectResult<{ fileId: string }>> {
      try {
        const file = await api.createEnvFile(repositoryId, { environmentId: input.environmentId, path: input.path.trim() });
        fileRepository.set(file.id, repositoryId);
        return { ok: true, fileId: file.id };
      } catch (error) {
        if (error instanceof ApiError && error.status === 400) return { ok: false, error: "invalid", reason: "path" } as ProjectRefusal;
        if (error instanceof ApiError && error.status === 409) return { ok: false, error: "invalid", reason: "path_taken" } as ProjectRefusal;
        return refusalOf(error);
      }
    },

    async importEnvFile(
      fileId: string,
      content: string,
    ): Promise<ProjectResult<{ imported: string[]; replaced: string[]; skipped: { line: number; reason: "syntax" | "key" }[] }>> {
      const repositoryId = fileRepository.get(fileId);
      if (!repositoryId) return { ok: false, error: "not_found" };
      try {
        const r = await api.importEnvFile(repositoryId, fileId, content);
        if (r.imported.length === 0) return { ok: false, error: "invalid", reason: "nothing_to_import" } as ProjectRefusal;
        const replaced = new Set(r.replaced);
        return {
          ok: true,
          imported: r.imported.filter((k) => !replaced.has(k)),
          replaced: [...replaced],
          skipped: r.skipped.map((s) => ({ line: s.line, reason: s.reason === "key" ? "key" : "syntax" })),
        };
      } catch (error) {
        return refusalOf(error);
      }
    },

    async setEnvVar(fileId: string, key: string, value: string): Promise<ProjectResult> {
      const repositoryId = fileRepository.get(fileId);
      if (!repositoryId) return { ok: false, error: "not_found" };
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return { ok: false, error: "invalid", reason: "key" } as ProjectRefusal;
      try {
        await api.setEnvVar(repositoryId, fileId, key, value);
        return { ok: true };
      } catch (error) {
        return refusalOf(error);
      }
    },

    async removeEnvVar(fileId: string, key: string): Promise<ProjectResult> {
      const repositoryId = fileRepository.get(fileId);
      if (!repositoryId) return { ok: false, error: "not_found" };
      try {
        await api.removeEnvVar(repositoryId, fileId, key);
        return { ok: true };
      } catch (error) {
        return refusalOf(error);
      }
    },

    async deleteEnvFile(fileId: string): Promise<ProjectResult> {
      const repositoryId = fileRepository.get(fileId);
      if (!repositoryId) return { ok: false, error: "not_found" };
      try {
        await api.deleteEnvFile(repositoryId, fileId);
        fileRepository.delete(fileId);
        return { ok: true };
      } catch (error) {
        return refusalOf(error);
      }
    },
  };
}

/** Sul client vero (il client si legge a ogni chiamata). */
const liveApi: ProjectRepositoriesApi = {
  list: (projectId) => appClient().repositories.list(projectId) as Promise<Any[]>,
  me: () => appClient().auth.me() as Promise<Any>,
  create: (input) => appClient().repositories.create(input),
  update: (slug, patch) => appClient().repositories.update(slug, patch),
  configureWebhook: (slug) => appClient().repositories.configureWebhook(slug),
  remoteRepositories: (id) => appClient().gitAccounts.repositories(id),
  branches: (id, fullName) => appClient().gitAccounts.branches(id, fullName),
  validateRepo: (id, fullName) => appClient().gitAccounts.validateRepo(id, fullName),
  gitAccountName: async (id) => {
    const account = (await appClient().gitAccounts.list()).find((a) => a.id === id);
    return account && (account.provider === "github" || account.provider === "bitbucket")
      ? { provider: account.provider, name: account.name }
      : null;
  },
  environments: async (projectId) =>
    (await appClient().environments.list(projectId)).map((e) => ({ id: e.id, name: e.name, kind: e.kind })),
  envFiles: (repositoryId) => appClient().repositories.envFiles(repositoryId),
  createEnvFile: (repositoryId, input) => appClient().repositories.createEnvFile(repositoryId, input),
  importEnvFile: (repositoryId, fileId, content) =>
    appClient().repositories.importEnvFile(repositoryId, fileId, content) as Promise<Any>,
  setEnvVar: (repositoryId, fileId, key, value) => appClient().repositories.setEnvVar(repositoryId, fileId, key, value),
  removeEnvVar: (repositoryId, fileId, key) => appClient().repositories.removeEnvVar(repositoryId, fileId, key),
  deleteEnvFile: (repositoryId, fileId) => appClient().repositories.deleteEnvFile(repositoryId, fileId),
};

/** SOLO TEST: le rotte vere. */
export const liveProjectRepositoriesApiForTest = liveApi;

export const liveProjectRepositories = createRealProjectRepositories(liveApi);
