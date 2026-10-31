import { INSTANCE_ORIGIN, forgetSecret, storeSecret } from "../admin/secrets";
import { recordChange } from "../changelog/index";
import type { Project, Repository } from "../model";
import { gate, now, state } from "../store";
import { writer } from "../writer";
import { MANAGE_SETTINGS, canI, managedProject, projectObject, reauthRefusal } from "./common";
import { openProject, settingsOf } from "./reads";
import { MANAGE_REPOS, managedRepository, repositoryObject } from "./repositories";
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

const mask = (last4: string) => `••••${last4}`;

const dsnOf = (key: string, project: Project) =>
  `https://${key}@${new URL(INSTANCE_ORIGIN).host}/ingest/${project.code}`;

/** Lo snippet `init()` dell'SDK, sei righe. */
const snippetOf = (dsn: string) =>
  [
    'import { init } from "@stubwise/sdk/browser";',
    "",
    "init({",
    `  dsn: "${dsn}",`,
    '  environment: "production",',
    "});",
  ].join("\n");

const inboundUrlOf = (project: Project) => `${INSTANCE_ORIGIN}/api/inbound/${project.code}/ticket`;
const gitWebhookUrlOf = (r: Repository) => `${INSTANCE_ORIGIN}/webhooks/git/${r.id}`;

/**
 * La guida passo passo dell'SDK (in inglese, come sul web: è un documento
 * tecnico da dare a chi integra), con la chiave che le si passa.
 */
function guideOf(project: Project, key: string): string {
  const dsn = dsnOf(key, project);
  return [
    `# Send ${project.name}'s errors to Stubwise`,
    "",
    "## 1. Install",
    "",
    "```sh",
    "npm install @stubwise/sdk",
    "```",
    "",
    "## 2. Init, as early as possible",
    "",
    "```ts",
    snippetOf(dsn),
    "```",
    "",
    "## 3. Test",
    "",
    "```ts",
    'import { captureError } from "@stubwise/sdk/browser";',
    'captureError(new Error("Stubwise test error"));',
    "```",
    "",
    `The error appears in ${project.code} within a minute. Requests with a`,
    `missing or old key are refused: the ingestion key is \`${key}\`.`,
    "",
  ].join("\n");
}

export interface IntegrationView {
  ingestion: { last4: string; createdAt: string; maskedDsn: string; maskedSnippet: string };
  inbound: { url: string; auth: string };
  gitWebhooks: {
    repositoryId: string;
    name: string;
    url: string;
    secretLast4: string | null;
    canRegenerate: boolean;
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
            }))
        : [],
    canRegenerateKey: canI(me, MANAGE_SETTINGS, project.id),
    guide: guideOf(project, masked),
  };
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
  const settings = settingsOf(project);
  if (settings.ingestion.secretId) forgetSecret(settings.ingestion.secretId);
  const secret = storeSecret("ingestion_key", project.id);
  settings.ingestion = { secretId: secret.id, last4: secret.value.slice(-4), createdAt: now() };
  recordChange({
    kind: "project.ingestion_key_regenerated",
    actorId: me,
    projectId: project.id,
    object: projectObject(project),
  });
  const dsn = dsnOf(secret.value, project);
  return { ok: true, key: secret.value, dsn, snippet: snippetOf(dsn) };
}

/**
 * Un secret nuovo per il webhook git del repository (+R, `repos.manage`):
 * il valore esce qui e mai più; quello di prima smette di valere.
 */
export async function regenerateWebhookSecret(
  repositoryId: string,
): Promise<ProjectResult<{ secret: string }>> {
  const me = await writer("projectSettings.regenerateWebhookSecret");
  const managed = managedRepository(me, repositoryId);
  if ("refusal" in managed) return managed.refusal;
  const blocked = reauthRefusal(me, "projectSettings.regenerateWebhookSecret");
  if (blocked) return blocked;

  const { repository: r, project } = managed;
  const webhook = r.webhook ?? {
    state: "not_configured",
    configuredAt: null,
    secretId: null,
    last4: null,
  };
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
  return { ok: true, secret: secret.value };
}
