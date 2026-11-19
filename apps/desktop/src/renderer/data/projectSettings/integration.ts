import { visiblePeopleFor } from "../access/whoCan";
import { INSTANCE_ORIGIN, forgetSecret, storeSecret } from "../admin/secrets";
import { recordChange } from "../changelog/index";
import type { Project, Repository } from "../model";
import { gate, now, state } from "../store";
import { writer } from "../writer";
import {
  MANAGE_SETTINGS,
  canI,
  managedProject,
  nameOf,
  projectObject,
  reauthRefusal,
} from "./common";
import { openProject, settingsOf } from "./reads";
import {
  MANAGE_REPOS,
  accountOf,
  managedRepository,
  notConfiguredWebhook,
  repositoryObject,
} from "./repositories";
import { dsnWithKey, guideText, maskKey, snippetOf } from "./integrationText";
import type { ProjectResult } from "./types";

// Progetto → Settings → Integration (area 9c, Task 4): come gli altri
// sistemi mandano al progetto errori ed eventi. La legge ogni membro.
// - La chiave d'ingestione è del progetto: si rigenera con
//   `project.settings.manage` e la riconferma (+R); il valore nuovo
//   (`storeSecret("ingestion_key", projectId)`) esce UNA volta, nel
//   risultato, con DSN e snippet interi; quello di prima smette di valere
//   (`forgetSecret`). Il seme ne ha solo le ultime 4.
// - DSN, snippet, autenticazione del webhook in arrivo e guida dell'SDK si
//   leggono con la chiave mascherata (`••••<last4>`).
// - Il secret del webhook git è per repository, allo stesso modo, con
//   `repos.manage`.
// Le forme degli indirizzi sono quelle del web, sull'origine finta
// dell'istanza.

const mask = maskKey;

const dsnOf = (key: string, project: Project) =>
  dsnWithKey(`https://${new URL(INSTANCE_ORIGIN).host}/ingest/${project.code}`, key);

const inboundUrlOf = (project: Project) => `${INSTANCE_ORIGIN}/api/inbound/${project.code}/ticket`;
const gitWebhookUrlOf = (r: Repository) => `${INSTANCE_ORIGIN}/webhooks/git/${r.id}`;

const guideOf = (project: Project, key: string) => guideText(project, dsnOf(key, project), key);

export interface IntegrationView {
  ingestion: {
    last4: string;
    /** `null` per una chiave fatta prima che il server lo registrasse (F5). */
    createdAt: string | null;
    /**
     * Chi l'ha creata («made Oct 2 by Laura Costa»); `null` nel seme o se
     * chi guarda non vede quella persona (R-G5).
     */
    createdBy: { id: string; name: string } | null;
    maskedDsn: string;
    maskedSnippet: string;
  };
  inbound: { url: string; auth: string };
  gitWebhooks: {
    repositoryId: string;
    name: string;
    url: string;
    secretLast4: string | null;
    canRegenerate: boolean;
    /**
     * Lo stato del webhook e la piattaforma (area 9, F5): stanno nella vista,
     * così la pagina legge una fonte sola. `provider` è `null` se non si sa
     * (la build app: il server non lo manda), e la frase dice «la piattaforma».
     */
    state: "not_configured" | "configured" | "failed";
    provider: "github" | "bitbucket" | null;
  }[];
  canRegenerateKey: boolean;
  guide: string;
}

/**
 * Integration come la legge chi guarda; `null` su un progetto invisibile o
 * archiviato. I webhook git ci sono per chi vede o gestisce i repository
 * (`repos.view` o `repos.manage`): per gli altri membri il nome di un
 * repository non è una cosa che vedono altrove.
 */
export async function getIntegration(projectId: string): Promise<IntegrationView | null> {
  const me = await gate("projectSettings.getIntegration");
  const project = openProject(me, projectId);
  if (!project) return null;
  const { ingestion } = settingsOf(project);
  const masked = mask(ingestion.last4);
  const maskedDsn = dsnOf(masked, project);
  const canManageRepos = canI(me, MANAGE_REPOS, project.id);
  return {
    ingestion: {
      last4: ingestion.last4,
      createdAt: ingestion.createdAt,
      createdBy:
        ingestion.createdById !== null && visiblePeopleFor(me).has(ingestion.createdById)
          ? { id: ingestion.createdById, name: nameOf(ingestion.createdById)! }
          : null,
      maskedDsn,
      maskedSnippet: snippetOf(maskedDsn),
    },
    inbound: { url: inboundUrlOf(project), auth: `Bearer ${masked}` },
    gitWebhooks:
      canManageRepos || canI(me, "repos.view", project.id)
        ? state.repositories
            .filter((r) => r.projectId === project.id)
            .map((r) => ({
              repositoryId: r.id,
              name: r.name,
              url: gitWebhookUrlOf(r),
              secretLast4: r.webhook?.last4 ?? null,
              canRegenerate: canManageRepos,
              state: r.webhook?.state ?? "not_configured",
              provider: accountOf(r.gitAccountId)?.provider ?? null,
            }))
        : [],
    canRegenerateKey: canI(me, MANAGE_SETTINGS, project.id),
    guide: guideOf(project, masked),
  };
}

/** La chiave d'ingestione intera, col DSN e lo snippet: escono una volta sola. */
export interface IngestionKeyOnce {
  key: string;
  dsn: string;
  snippet: string;
}

/**
 * Una chiave d'ingestione nuova per il progetto, a nome di `me`: quella di
 * prima smette di valere. Non è una scrittura a sé (non guarda chi può): la
 * chiamano `regenerateIngestionKey` e, alla nascita del progetto,
 * `createProject` (area 9, F5, decisione del maintainer: la chiave intera
 * esce una volta a chi crea).
 */
export function issueIngestionKey(project: Project, me: string): IngestionKeyOnce {
  const settings = settingsOf(project);
  if (settings.ingestion.secretId) forgetSecret(settings.ingestion.secretId);
  const secret = storeSecret("ingestion_key", project.id);
  settings.ingestion = {
    secretId: secret.id,
    last4: secret.value.slice(-4),
    createdAt: now(),
    createdById: me,
  };
  const dsn = dsnOf(secret.value, project);
  return { key: secret.value, dsn, snippet: snippetOf(dsn) };
}

/**
 * Una chiave d'ingestione nuova (+R, `project.settings.manage`): il valore,
 * il DSN e lo snippet interi escono qui e mai più; la chiave di prima smette
 * di valere.
 */
export async function regenerateIngestionKey(
  projectId: string,
): Promise<ProjectResult<{ key: string; dsn: string; snippet: string }>> {
  const me = await writer("projectSettings.regenerateIngestionKey");
  const managed = managedProject(me, projectId);
  if ("refusal" in managed) return managed.refusal;
  const blocked = reauthRefusal(me, "projectSettings.regenerateIngestionKey");
  if (blocked) return blocked;

  const { project } = managed;
  const once = issueIngestionKey(project, me);
  recordChange({
    kind: "project.ingestion_key_regenerated",
    actorId: me,
    projectId: project.id,
    object: projectObject(project),
  });
  return { ok: true, ...once };
}

/**
 * Un secret nuovo per il webhook git del repository (+R, `repos.manage`):
 * il valore esce qui e mai più; quello di prima smette di valere. `mode`
 * dice se è già sulla piattaforma o va copiato a mano.
 */
export async function regenerateWebhookSecret(
  repositoryId: string,
): Promise<ProjectResult<{ secret: string; mode: "manual" | "platform" }>> {
  const me = await writer("projectSettings.regenerateWebhookSecret");
  const managed = managedRepository(me, repositoryId);
  if ("refusal" in managed) return managed.refusal;
  const blocked = reauthRefusal(me, "projectSettings.regenerateWebhookSecret");
  if (blocked) return blocked;

  const { repository: r, project } = managed;
  const webhook = r.webhook ?? notConfiguredWebhook();
  // Come il server (F5): se il webhook l'ha configurato Stubwise, il segreto
  // nuovo va anche sulla piattaforma («platform»); altrimenti si copia a mano.
  const mode = webhook.state === "configured" ? "platform" : "manual";
  if (webhook.secretId) forgetSecret(webhook.secretId);
  const secret = storeSecret("git_webhook_secret", r.id);
  webhook.secretId = secret.id;
  webhook.last4 = secret.value.slice(-4);
  r.webhook = webhook;
  recordChange({
    kind: "repository.webhook_secret_regenerated",
    actorId: me,
    projectId: project.id,
    object: repositoryObject(r),
  });
  return { ok: true, secret: secret.value, mode };
}
