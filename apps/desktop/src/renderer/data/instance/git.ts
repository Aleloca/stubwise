import { forgetSecret, storeProvidedSecret } from "../admin/secrets";
import { recordChange } from "../changelog/index";
import { changedFields } from "../changelog/settingValues";
import { gate, newId, now, state, visibleProjectIds } from "../store";
import { forbidden, writer } from "../writer";
import { canI, reauthRefusal, refuse } from "./common";
import type { GitAccount, TestOutcome } from "./state";
import type { InstanceRefusal, InstanceResult } from "./types";

// Gli account git d'istanza (area 9b, Task 4): le credenziali con cui
// Stubwise legge e scrive i repository. Si leggono con `git_accounts.view` o
// `.manage` (il preset User dà `.view` a tutti, Ruling 1), si scrivono con
// `.manage`. Il token va nel caveau (`storeProvidedSecret`): qui restano
// l'id e le ultime 4 cifre (RF 1). Creare, sostituire il token ed eliminare
// chiedono la riconferma (+R); modificare, verificare e il revisore
// predefinito no.
//
// Chi usa un account sono i repository (`Repository.gitAccountId`): chi
// guarda legge per nome solo quelli dei progetti che vede, gli altri sono
// un numero (R-G5), nella riga come nel rifiuto `in_use`.
//
// Il revisore predefinito è UNO per ambito, cioè piattaforma + workspace
// (scelta del controller, come il `review-account` del server): sceglierne
// uno ne sostituisce un altro dello stesso ambito e lo dice (`replaced`).

const MANAGE = "git_accounts.manage";
const VIEW = "git_accounts.view";

/** Il nome della piattaforma come si scrive: è il parametro della voce `git_account.created`. */
const PLATFORM = { github: "GitHub", bitbucket: "Bitbucket" } as const;

export type GitAccountView = Omit<GitAccount, "secretId"> & {
  /** I repository dei progetti che chi guarda vede (nome e codice del progetto). */
  repositories: { name: string; projectCode: string }[];
  /** Quelli dei progetti che non vede, solo contati. */
  hiddenRepositories: number;
  /**
   * L'account che smetterebbe di essere revisore predefinito se lo diventasse
   * questo (lo stesso ambito), o `null`: il dialogo lo dice prima.
   */
  replacesAsReviewer: string | null;
};

const accountOf = (id: string) => state.instance.gitAccounts.find((g) => g.id === id);
const objectOf = (a: GitAccount) => ({ type: "git_account", id: a.id, label: a.name });
const canRead = (me: string) => canI(me, VIEW) || canI(me, MANAGE);

/** Ambito del revisore predefinito: piattaforma e workspace (senza maiuscole). */
const scopeOf = (a: GitAccount) => `${a.provider}|${(a.workspace ?? "").toLowerCase()}`;

/** I repository che usano l'account: quelli visibili a `me` per nome, gli altri contati. */
function usageOf(
  me: string,
  accountId: string,
): { repositories: { name: string; projectCode: string }[]; hidden: number } {
  const visible = visibleProjectIds(me);
  const repositories: { name: string; projectCode: string }[] = [];
  let hidden = 0;
  for (const r of state.repositories) {
    if (r.gitAccountId !== accountId) continue;
    const code = state.projectsById.get(r.projectId)?.code;
    if (code && visible.has(r.projectId)) repositories.push({ name: r.name, projectCode: code });
    else hidden += 1;
  }
  return { repositories, hidden };
}

/** Campo per campo, mai `...a`: `secretId` non esce. */
function viewOf(me: string, a: GitAccount): GitAccountView {
  const { repositories, hidden } = usageOf(me, a.id);
  return {
    id: a.id,
    name: a.name,
    provider: a.provider,
    workspace: a.workspace,
    last4: a.last4,
    defaultReviewer: a.defaultReviewer,
    lastValidation: a.lastValidation ? { ...a.lastValidation } : null,
    createdAt: a.createdAt,
    repositories,
    hiddenRepositories: hidden,
    replacesAsReviewer: a.defaultReviewer ? null : (reviewerOfScope(a)?.name ?? null),
  };
}

/** Il revisore predefinito dello stesso ambito di `a`, diverso da `a`. */
const reviewerOfScope = (a: GitAccount): GitAccount | undefined =>
  state.instance.gitAccounts.find(
    (g) => g.id !== a.id && g.defaultReviewer && scopeOf(g) === scopeOf(a),
  );

/** L'account su cui agire: con il permesso (o `forbidden`), esistente (o `not_found`). */
function managed(me: string, id: string): { account: GitAccount } | { refusal: InstanceRefusal } {
  if (!canI(me, MANAGE)) return { refusal: refuse.forbidden() };
  const account = accountOf(id);
  return account ? { account } : { refusal: refuse.notFound() };
}

const nameTaken = (name: string, exceptId: string | null) =>
  state.instance.gitAccounts.some(
    (g) => g.id !== exceptId && g.name.toLowerCase() === name.toLowerCase(),
  );

/** Gli account, coi repository che li usano. */
export async function listGitAccounts(): Promise<GitAccountView[]> {
  const me = await gate("instance.listGitAccounts");
  if (!canRead(me)) throw forbidden();
  return state.instance.gitAccounts.map((a) => viewOf(me, a));
}

/**
 * Aggiunge un account (+R). Bitbucket chiede il workspace (serve a elencare
 * i repository); GitHub non ne ha, quello dato si ignora.
 */
export async function createGitAccount(input: {
  name: string;
  provider: GitAccount["provider"];
  workspace: string | null;
  token: string;
}): Promise<InstanceResult<{ accountId: string }>> {
  const me = await writer("instance.createGitAccount");
  if (!canI(me, MANAGE)) return refuse.forbidden();
  const name = input.name.trim();
  if (!name) return refuse.invalid("name");
  if (input.provider !== "github" && input.provider !== "bitbucket")
    return refuse.invalid("provider");
  const workspace = input.provider === "bitbucket" ? (input.workspace ?? "").trim() : null;
  if (workspace === "") return refuse.invalid("workspace");
  const token = input.token.trim();
  if (!token) return refuse.invalid("token");
  if (nameTaken(name, null)) return refuse.conflict();
  const blocked = reauthRefusal(me, "instance.createGitAccount");
  if (blocked) return blocked;

  const id = newId("git");
  const secret = storeProvidedSecret("git_token", id, token);
  const account: GitAccount = {
    id,
    name,
    provider: input.provider,
    workspace,
    secretId: secret.id,
    last4: secret.last4,
    defaultReviewer: false,
    lastValidation: null,
    createdAt: now(),
  };
  state.instance.gitAccounts.push(account);
  recordChange({
    kind: "git_account.created",
    actorId: me,
    projectId: null,
    object: objectOf(account),
    params: { provider: PLATFORM[account.provider] },
  });
  return { ok: true, accountId: id };
}

/**
 * Nome e workspace, senza riconferma; la voce ha i soli campi cambiati. Un
 * revisore predefinito che cambia workspace (cioè ambito) smette di
 * esserlo: la stessa voce dice anche `defaultReviewer` On → Off.
 */
export async function updateGitAccount(
  id: string,
  input: { name?: string; workspace?: string | null },
): Promise<InstanceResult> {
  const me = await writer("instance.updateGitAccount");
  const found = managed(me, id);
  if ("refusal" in found) return found.refusal;
  const { account } = found;
  const name = input.name === undefined ? account.name : input.name.trim();
  if (!name) return refuse.invalid("name");
  let workspace = account.workspace;
  if (input.workspace !== undefined) {
    const value = (input.workspace ?? "").trim();
    // Bitbucket ne ha sempre uno; GitHub mai.
    if (account.provider === "bitbucket" ? value === "" : value !== "")
      return refuse.invalid("workspace");
    workspace = account.provider === "bitbucket" ? value : null;
  }
  if (nameTaken(name, id)) return refuse.conflict();

  // Cambiando ambito un revisore predefinito smette di esserlo, nella stessa
  // voce (ruling del controller): nel nuovo ambito ce ne può essere già uno.
  const moved = (workspace ?? "").toLowerCase() !== (account.workspace ?? "").toLowerCase();
  const defaultReviewer = account.defaultReviewer && !moved;
  const diff = changedFields(
    { name: account.name, workspace: account.workspace, defaultReviewer: account.defaultReviewer },
    { name, workspace, defaultReviewer },
  );
  if (!diff) return { ok: true };
  account.name = name;
  account.workspace = workspace;
  account.defaultReviewer = defaultReviewer;
  recordChange({
    kind: "git_account.updated",
    actorId: me,
    projectId: null,
    object: objectOf(account),
    ...diff,
  });
  return { ok: true };
}

/** Sostituisce il token (+R): il vecchio esce dal caveau, l'account torna «non ancora verificato». */
export async function replaceGitToken(id: string, token: string): Promise<InstanceResult> {
  const me = await writer("instance.replaceGitToken");
  const found = managed(me, id);
  if ("refusal" in found) return found.refusal;
  const value = token.trim();
  if (!value) return refuse.invalid("token");
  const blocked = reauthRefusal(me, "instance.replaceGitToken");
  if (blocked) return blocked;

  const { account } = found;
  forgetSecret(account.secretId);
  const secret = storeProvidedSecret("git_token", account.id, value);
  account.secretId = secret.id;
  account.last4 = secret.last4;
  account.lastValidation = null;
  // «Sostituito», mai il valore: nessun prima/dopo.
  recordChange({
    kind: "git_account.token_replaced",
    actorId: me,
    projectId: null,
    object: objectOf(account),
  });
  return { ok: true };
}

/**
 * Verifica l'account: l'esito scelto nel riquadro «Prototype only»
 * (`simulateNextTest`, vale una volta), altrimenti `ok`. Una verifica non è
 * una modifica: nessuna voce.
 */
export async function validateGitAccount(
  id: string,
): Promise<InstanceResult<{ outcome: TestOutcome }>> {
  const me = await writer("instance.validateGitAccount");
  const found = managed(me, id);
  if ("refusal" in found) return found.refusal;
  const next = state.instance.simulate.nextTest;
  const outcome = next[id] ?? "ok";
  delete next[id];
  found.account.lastValidation = { at: now(), outcome };
  return { ok: true, outcome };
}

/**
 * Elimina un account (+R). In uso → `in_use` coi repository che chi guarda
 * vede e gli altri contati (R-G5), prima della riconferma: non si chiede il
 * codice per un'azione che sarebbe rifiutata.
 */
export async function deleteGitAccount(id: string): Promise<InstanceResult> {
  const me = await writer("instance.deleteGitAccount");
  const found = managed(me, id);
  if ("refusal" in found) return found.refusal;
  const { repositories, hidden } = usageOf(me, id);
  if (repositories.length > 0 || hidden > 0)
    return refuse.inUse(
      repositories.map((r) => ({ label: r.name, projectCode: r.projectCode })),
      hidden,
    );
  const blocked = reauthRefusal(me, "instance.deleteGitAccount");
  if (blocked) return blocked;

  const { account } = found;
  forgetSecret(account.secretId);
  state.instance.gitAccounts = state.instance.gitAccounts.filter((g) => g.id !== id);
  recordChange({
    kind: "git_account.deleted",
    actorId: me,
    projectId: null,
    object: objectOf(account),
  });
  return { ok: true };
}

/**
 * Rende l'account il revisore predefinito del suo ambito (o smette di
 * esserlo). `replaced` è il nome dell'account che lo era prima, nello stesso
 * ambito, o `null`. Nessuna riconferma.
 *
 * La voce: accendendo, `git_account.default_reviewer_changed` col nome di
 * prima e quello di dopo («GitHub Old → GitHub Stubwise», nomi dati da una
 * persona); spegnendo, `git_account.updated` col campo `defaultReviewer`
 * (On → Off): la frase «ha reso … revisore predefinito» non direbbe il vero.
 */
export async function setDefaultReviewer(
  id: string,
  on: boolean,
): Promise<InstanceResult<{ replaced: string | null }>> {
  const me = await writer("instance.setDefaultReviewer");
  const found = managed(me, id);
  if ("refusal" in found) return found.refusal;
  const { account } = found;
  if (account.defaultReviewer === on) return { ok: true, replaced: null };

  if (!on) {
    account.defaultReviewer = false;
    recordChange({
      kind: "git_account.updated",
      actorId: me,
      projectId: null,
      object: objectOf(account),
      ...changedFields({ defaultReviewer: true }, { defaultReviewer: false })!,
    });
    return { ok: true, replaced: null };
  }

  const previous = reviewerOfScope(account) ?? null;
  if (previous) previous.defaultReviewer = false;
  account.defaultReviewer = true;
  recordChange({
    kind: "git_account.default_reviewer_changed",
    actorId: me,
    projectId: null,
    object: objectOf(account),
    before: previous?.name ?? null,
    after: account.name,
  });
  return { ok: true, replaced: previous?.name ?? null };
}
