import { storeSecret } from "../admin/secrets";
import { recordChange } from "../changelog/index";
import { changedFields, type FieldValue } from "../changelog/settingValues";
import { SEED_GIT_ACCOUNT_IDS } from "../instance/seed";
import type { GitAccount, TestOutcome } from "../instance/state";
import type { Project, Repository } from "../model";
import { gate, newId, now, state } from "../store";
import { can, viewerFor } from "../viewer";
import { forbidden, writer } from "../writer";
import { canI, managedProject, refuse } from "./common";
import { openProject } from "./reads";
import type { ProjectRefusal, ProjectResult } from "./types";

// Progetto → Settings → Repositories (area 9c, Task 4): l'elenco, la
// creazione guidata, la modifica e il webhook git. Si leggono con
// `repos.view`, si scrivono con `repos.manage` nel progetto; ordine dei
// controlli di `common.ts`. Regole del web:
// - un repository si crea solo dopo una verifica `ok` della STESSA terna
//   (account, repository, ramo), fatta da chi crea, nello stesso progetto
//   (`access_not_verified`); la verifica vale per una creazione;
// - il nome è unico nel progetto (`name_taken`): è nell'indirizzo dei Docs;
// - l'indirizzo è `https`; l'account di review è della stessa piattaforma e
//   diverso dal principale (`review_account`); un ramo protetto non è vuoto
//   e non ha spazi;
// - il ramo di default NON si modifica: è un fatto della piattaforma
//   (R-K20), viene da `listRemoteRepositories` e la vista lo mostra (ruling
//   del controller (pre-flight), P27). Il ramo scelto alla creazione è
//   quello verso cui Claude apre le PR (`releaseBranch`);
// - nessuna eliminazione di un repository che sta in un progetto, come sul
//   web (quello rimasto senza progetto si elimina dal Task 5).
// Le verifiche e gli esiti simulati stanno nello stato (P29). Una voce per
// campo cambiato (`repository.updated`, `params.field`); il webhook scrive
// `repository.webhook_configured` con lo stato di prima e di dopo.

const VIEW = "repos.view";
export const MANAGE_REPOS = "repos.manage";

export interface RepositoryView {
  id: string;
  name: string;
  fullName: string;
  url: string;
  provider: "github" | "bitbucket" | null;
  defaultBranch: string;
  gitAccount: { id: string; name: string } | null;
  reviewAccount: { id: string; name: string } | null;
  installCommand: string | null;
  testCommand: string | null;
  graphEnabled: boolean;
  protectedBranches: string[];
  webhook: { state: "not_configured" | "configured" | "failed"; configuredAt: string | null };
}

export interface RemoteRepository {
  fullName: string;
  defaultBranch: string;
  branches: string[];
}

/** I rami di un repository finto della piattaforma, il predefinito per primo. */
const remote = (fullName: string, extra: string[] = []): RemoteRepository => ({
  fullName,
  defaultBranch: "main",
  branches: ["main", "develop", ...extra],
});

/**
 * Ciò che ogni account git del seme vede sulla sua piattaforma (finto). Un
 * account nato dall'app non vede niente: nessuna rete.
 */
const REMOTE_REPOSITORIES: Readonly<Record<string, readonly RemoteRepository[]>> = {
  [SEED_GIT_ACCOUNT_IDS.bitbucketAudin]: [
    remote("audin/audin-app", ["release/2026.10"]),
    remote("audin/audin-admin"),
    remote("audin/audin-scripts"),
    remote("audin/bellavista-store"),
    remote("audin/fatture-api"),
    remote("audin/portale-utenti", ["feature/rate"]),
  ],
  [SEED_GIT_ACCOUNT_IDS.githubStubwise]: [
    remote("stubwise/guide"),
    remote("stubwise/sdk-examples"),
    remote("stubwise/stubwise", ["release/2026.10"]),
  ],
  [SEED_GIT_ACCOUNT_IDS.githubShop]: [remote("vetrina-web/shop-frontend")],
};

const HOST = { github: "github.com", bitbucket: "bitbucket.org" } as const;

const accountOf = (id: string | null | undefined): GitAccount | undefined =>
  id ? state.instance.gitAccounts.find((g) => g.id === id) : undefined;
const accountRef = (a: GitAccount | undefined) => (a ? { id: a.id, name: a.name } : null);
const remoteOf = (accountId: string, fullName: string) =>
  REMOTE_REPOSITORIES[accountId]?.find((r) => r.fullName === fullName);

/** L'oggetto delle voci di un repository: il nome come etichetta. */
export const repositoryObject = (r: Repository) => ({
  type: "repository",
  id: r.id,
  label: r.name,
});

/** Campo per campo, mai `...r`: l'id e le ultime 4 del secret del webhook non escono. */
function viewOf(r: Repository): RepositoryView {
  const account = accountOf(r.gitAccountId);
  return {
    id: r.id,
    name: r.name,
    fullName: r.fullName ?? r.name,
    url: r.url ?? "",
    provider: account?.provider ?? null,
    defaultBranch: r.defaultBranch ?? "main",
    gitAccount: accountRef(account),
    reviewAccount: accountRef(accountOf(r.reviewGitAccountId)),
    installCommand: r.installCommand ?? null,
    testCommand: r.testCommand ?? null,
    graphEnabled: r.graphEnabled ?? false,
    protectedBranches: [...(r.protectedBranches ?? [])],
    webhook: {
      state: r.webhook?.state ?? "not_configured",
      configuredAt: r.webhook?.configuredAt ?? null,
    },
  };
}

/**
 * Il repository su cui scrivere: il suo progetto visibile e aperto (o
 * `not_found`: R-G5), con `permission` nel progetto (o `forbidden`).
 */
export function managedRepository(
  me: string,
  repositoryId: string,
  permission: string = MANAGE_REPOS,
): { repository: Repository; project: Project } | { refusal: ProjectRefusal } {
  const repository = state.repositories.find((r) => r.id === repositoryId);
  const project = repository ? openProject(me, repository.projectId) : null;
  if (!repository || !project) return { refusal: refuse.notFound() };
  if (!canI(me, permission, project.id)) return { refusal: refuse.forbidden() };
  return { repository, project };
}

/** I repository del progetto; `null` senza `repos.view` o su un progetto invisibile o archiviato. */
export async function listProjectRepositories(
  projectId: string,
): Promise<{ canManage: boolean; repositories: RepositoryView[] } | null> {
  const me = await gate("projectSettings.listProjectRepositories");
  const project = openProject(me, projectId);
  if (!project || !canI(me, VIEW, project.id)) return null;
  return {
    canManage: canI(me, MANAGE_REPOS, project.id),
    repositories: state.repositories.filter((r) => r.projectId === project.id).map(viewOf),
  };
}

/**
 * I repository che un account git vede sulla sua piattaforma (finti), coi
 * rami. Per chi ha `repos.manage` in almeno un progetto: è il passo 2 della
 * creazione. Un account sconosciuto non vede niente.
 */
export async function listRemoteRepositories(gitAccountId: string): Promise<RemoteRepository[]> {
  const me = await gate("projectSettings.listRemoteRepositories");
  if (!can(viewerFor(me), MANAGE_REPOS)) throw forbidden();
  if (!accountOf(gitAccountId)) return [];
  return (REMOTE_REPOSITORIES[gitAccountId] ?? []).map((r) => ({
    ...r,
    branches: [...r.branches],
  }));
}

/** La terna scelta, valida: l'account, il repository che quell'account vede, un suo ramo. */
function chosenTriple(input: {
  gitAccountId: string;
  fullName: string;
  branch: string;
}): { account: GitAccount; remote: RemoteRepository } | { reason: string } {
  const account = accountOf(input.gitAccountId);
  if (!account) return { reason: "git_account" };
  const found = remoteOf(account.id, input.fullName);
  if (!found) return { reason: "repository" };
  if (!found.branches.includes(input.branch)) return { reason: "branch" };
  return { account, remote: found };
}

/**
 * Verifica che l'account possa leggere e scrivere il repository sul ramo:
 * l'esito scelto nel riquadro «Prototype only» (vale una volta), altrimenti
 * `ok`. Chi crea lo fa prima di creare; resta la sua ultima verifica nel
 * progetto. Una verifica non è una modifica: nessuna voce.
 */
export async function checkRepositoryAccess(input: {
  projectId: string;
  gitAccountId: string;
  fullName: string;
  branch: string;
}): Promise<ProjectResult<{ outcome: TestOutcome }>> {
  const me = await writer("projectSettings.checkRepositoryAccess");
  const managed = managedProject(me, input.projectId, MANAGE_REPOS);
  if ("refusal" in managed) return managed.refusal;
  const triple = chosenTriple(input);
  if ("reason" in triple) return refuse.invalid(triple.reason);

  const checks = state.repositoryChecks;
  const outcome = checks.nextRepositoryCheck ?? "ok";
  checks.nextRepositoryCheck = null;
  checks.checks = checks.checks.filter(
    (c) => !(c.personId === me && c.projectId === managed.project.id),
  );
  checks.checks.push({
    personId: me,
    projectId: managed.project.id,
    gitAccountId: triple.account.id,
    fullName: triple.remote.fullName,
    branch: input.branch,
    outcome,
    at: now(),
  });
  return { ok: true, outcome };
}

/**
 * Solo prototipo: l'esito della prossima verifica d'accesso (riquadro
 * «Prototype only», che vede solo chi gestisce i repository).
 */
export async function simulateNextRepositoryCheck(outcome: TestOutcome): Promise<void> {
  const me = await writer("projectSettings.simulateNextRepositoryCheck");
  if (!can(viewerFor(me), MANAGE_REPOS)) throw forbidden();
  state.repositoryChecks.nextRepositoryCheck = outcome;
}

/** Il nome di un repository: non vuoto, senza spazi né `/` (è un pezzo dell'indirizzo dei Docs). */
const validName = (name: string): boolean => name !== "" && !/[\s/]/.test(name);

const nameTaken = (projectId: string, name: string, exceptId: string | null): boolean =>
  state.repositories.some(
    (r) =>
      r.projectId === projectId && r.id !== exceptId && r.name.toLowerCase() === name.toLowerCase(),
  );

const command = (value: string | null): string | null => {
  const v = value?.trim() ?? "";
  return v === "" ? null : v;
};

/**
 * Crea un repository nel progetto, dopo una verifica `ok` della stessa
 * terna fatta da chi crea; la verifica è consumata. Il webhook nasce da
 * configurare; lo spazio dei Docs nasce mai generato.
 */
export async function createRepository(
  projectId: string,
  input: {
    gitAccountId: string;
    fullName: string;
    name: string;
    branch: string;
    installCommand: string | null;
    testCommand: string | null;
  },
): Promise<ProjectResult<{ repositoryId: string }>> {
  const me = await writer("projectSettings.createRepository");
  const managed = managedProject(me, projectId, MANAGE_REPOS);
  if ("refusal" in managed) return managed.refusal;
  const { project } = managed;
  const triple = chosenTriple(input);
  if ("reason" in triple) return refuse.invalid(triple.reason);
  const name = input.name.trim();
  if (!validName(name)) return refuse.invalid("name");
  if (nameTaken(project.id, name, null)) return refuse.invalid("name_taken");
  const checks = state.repositoryChecks;
  const check = checks.checks.find((c) => c.personId === me && c.projectId === project.id);
  if (
    !check ||
    check.outcome !== "ok" ||
    check.gitAccountId !== triple.account.id ||
    check.fullName !== triple.remote.fullName ||
    check.branch !== input.branch
  )
    return refuse.invalid("access_not_verified");

  checks.checks = checks.checks.filter((c) => c !== check);
  const repository: Repository = {
    id: newId("repo"),
    projectId: project.id,
    name,
    fullName: triple.remote.fullName,
    defaultBranch: triple.remote.defaultBranch,
    releaseBranch: input.branch,
    gitAccountId: triple.account.id,
    url: `https://${HOST[triple.account.provider]}/${triple.remote.fullName}`,
    installCommand: command(input.installCommand),
    testCommand: command(input.testCommand),
    reviewGitAccountId: null,
    graphEnabled: false,
    protectedBranches: [],
    webhook: { state: "not_configured", configuredAt: null, secretId: null, last4: null },
  };
  state.repositories.push(repository);
  state.docSpaces.push({
    repositoryId: repository.id,
    projectId: project.id,
    name,
    generation: {
      status: "never",
      lastAt: null,
      commit: null,
      costUsd: null,
      provider: null,
      reason: null,
    },
    brief: null,
    releases: [],
    graph: { status: "disabled" },
  });
  recordChange({
    kind: "repository.created",
    actorId: me,
    projectId: project.id,
    object: repositoryObject(repository),
  });
  return { ok: true, repositoryId: repository.id };
}

type RepositoryPatch = Partial<
  Pick<
    RepositoryView,
    "name" | "url" | "installCommand" | "testCommand" | "graphEnabled" | "protectedBranches"
  >
> & { gitAccountId?: string; reviewGitAccountId?: string | null };

/** I campi della voce `repository.updated`, nell'ordine della pagina. */
const FIELDS = [
  "name",
  "url",
  "gitAccount",
  "reviewGitAccount",
  "installCommand",
  "testCommand",
  "graphEnabled",
  "protectedBranches",
] as const;

/**
 * Cambia i campi dati; gli altri restano com'erano. Niente `defaultBranch`:
 * è un fatto della piattaforma (P27). Una voce per campo cambiato.
 */
export async function updateRepository(
  repositoryId: string,
  patch: RepositoryPatch,
): Promise<ProjectResult> {
  const me = await writer("projectSettings.updateRepository");
  const managed = managedRepository(me, repositoryId);
  if ("refusal" in managed) return managed.refusal;
  const { repository: r, project } = managed;

  const name = patch.name === undefined ? r.name : patch.name.trim();
  if (!validName(name)) return refuse.invalid("name");
  if (nameTaken(project.id, name, r.id)) return refuse.invalid("name_taken");
  const url = patch.url === undefined ? (r.url ?? "") : patch.url.trim();
  if (patch.url !== undefined && !/^https:\/\/\S+$/.test(url)) return refuse.invalid("url");
  for (const key of ["installCommand", "testCommand"] as const)
    if (patch[key] !== undefined && patch[key] !== null && typeof patch[key] !== "string")
      return refuse.invalid(key === "installCommand" ? "install_command" : "test_command");
  if (patch.graphEnabled !== undefined && typeof patch.graphEnabled !== "boolean")
    return refuse.invalid("graph");
  const branches = patch.protectedBranches ?? r.protectedBranches ?? [];
  if (
    !Array.isArray(branches) ||
    branches.some((b) => typeof b !== "string" || b === "" || /\s/.test(b))
  )
    return refuse.invalid("protected_branch");
  const gitAccountId = patch.gitAccountId ?? r.gitAccountId ?? null;
  const account = accountOf(gitAccountId);
  if (patch.gitAccountId !== undefined && !account) return refuse.invalid("git_account");
  const reviewId =
    patch.reviewGitAccountId === undefined
      ? (r.reviewGitAccountId ?? null)
      : patch.reviewGitAccountId;
  // Si controlla quando cambia uno dei due: l'account di review è della
  // stessa piattaforma del principale e diverso da lui (regola del web).
  const review = reviewId === null ? undefined : accountOf(reviewId);
  if (
    (patch.gitAccountId !== undefined || patch.reviewGitAccountId !== undefined) &&
    reviewId !== null &&
    (!review || !account || review.id === account.id || review.provider !== account.provider)
  )
    return refuse.invalid("review_account");

  const next = {
    name,
    url,
    gitAccountId,
    reviewGitAccountId: reviewId,
    installCommand:
      patch.installCommand === undefined
        ? (r.installCommand ?? null)
        : command(patch.installCommand),
    testCommand:
      patch.testCommand === undefined ? (r.testCommand ?? null) : command(patch.testCommand),
    graphEnabled: patch.graphEnabled ?? r.graphEnabled ?? false,
    protectedBranches: [...branches],
  };
  // I valori della voce: gli account per nome (`null` = il revisore predefinito).
  const valuesOf = (v: typeof next): Record<(typeof FIELDS)[number], FieldValue> => ({
    name: v.name,
    url: v.url,
    gitAccount: accountOf(v.gitAccountId)?.name ?? null,
    reviewGitAccount: accountOf(v.reviewGitAccountId)?.name ?? null,
    installCommand: v.installCommand,
    testCommand: v.testCommand,
    graphEnabled: v.graphEnabled,
    protectedBranches: v.protectedBranches,
  });
  const before = valuesOf({
    name: r.name,
    url: r.url ?? "",
    gitAccountId: r.gitAccountId ?? null,
    reviewGitAccountId: r.reviewGitAccountId ?? null,
    installCommand: r.installCommand ?? null,
    testCommand: r.testCommand ?? null,
    graphEnabled: r.graphEnabled ?? false,
    protectedBranches: [...(r.protectedBranches ?? [])],
  });
  const after = valuesOf(next);
  const voices = FIELDS.flatMap((field) => {
    const diff = changedFields({ [field]: before[field] }, { [field]: after[field] });
    return diff ? [{ field, diff }] : [];
  });
  Object.assign(r, next);
  const space = state.docSpaces.find((s) => s.repositoryId === r.id);
  if (space) space.name = r.name;
  for (const { field, diff } of voices)
    recordChange({
      kind: "repository.updated",
      actorId: me,
      projectId: project.id,
      object: repositoryObject(r),
      ...diff,
      params: { field },
    });
  return { ok: true };
}

/**
 * «Configure automatically»: l'esito scelto nel riquadro «Prototype only»
 * (vale una volta), altrimenti `configured`. `updated` se era già
 * configurato (il web dice «aggiornato»). Configurandolo si imposta anche il
 * secret, se non c'era (il valore va alla piattaforma, a nessuno qui). La
 * data è quella dell'ultimo tentativo, riuscito o no.
 */
export async function configureRepositoryWebhook(
  repositoryId: string,
): Promise<ProjectResult<{ state: "configured" | "failed"; updated: boolean }>> {
  const me = await writer("projectSettings.configureRepositoryWebhook");
  const managed = managedRepository(me, repositoryId);
  if ("refusal" in managed) return managed.refusal;
  const { repository: r, project } = managed;

  const outcome = state.repositoryChecks.nextWebhookSetup ?? "configured";
  state.repositoryChecks.nextWebhookSetup = null;
  const webhook = r.webhook ?? {
    state: "not_configured",
    configuredAt: null,
    secretId: null,
    last4: null,
  };
  const previous = webhook.state;
  webhook.state = outcome;
  webhook.configuredAt = now();
  if (outcome === "configured" && webhook.last4 === null) {
    const secret = storeSecret("git_webhook_secret", r.id);
    webhook.secretId = secret.id;
    webhook.last4 = secret.value.slice(-4);
  }
  r.webhook = webhook;
  recordChange({
    kind: "repository.webhook_configured",
    actorId: me,
    projectId: project.id,
    object: repositoryObject(r),
    before: previous,
    after: outcome,
  });
  return {
    ok: true,
    state: outcome,
    updated: outcome === "configured" && previous === "configured",
  };
}

/** Solo prototipo: come finisce la prossima configurazione del webhook. */
export async function simulateNextWebhookSetup(outcome: "configured" | "failed"): Promise<void> {
  const me = await writer("projectSettings.simulateNextWebhookSetup");
  if (!can(viewerFor(me), MANAGE_REPOS)) throw forbidden();
  state.repositoryChecks.nextWebhookSetup = outcome;
}
