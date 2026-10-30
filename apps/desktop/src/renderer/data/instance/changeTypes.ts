import { registerChangeTypes, type ChangeType } from "../changelog/index";

// I tipi di voce del registro dell'area 9b, TUTTI qui (Task 1): ogni task
// dopo scrive solo tipi già registrati. Il `readPermission` è il permesso che
// gestisce l'oggetto, sempre un `.manage`: Claude non ne ha nessuno, quindi
// non legge nessuna di queste voci (test in `instance.test.ts`). La frase sta
// in `changelog.kinds.<kind>`, il gruppo del filtro «Type» in
// `changelog.groups.<group>` (il test di `Audit.test.tsx` controlla le due
// lingue).
//
// - `ai`: provider (`ai_providers.manage`), modelli, automazione, budget e
//   lingua dei contenuti (`settings.manage`);
// - `integrations`: account git, plugin, app Google, archiviazione e webhook
//   (l'URL del webhook entra nel prima/dopo: non è un segreto);
// - `servers`: i server d'istanza (`monitor.manage`). Scelta del controller:
//   le voci SSH le legge chi gestisce il monitor, che vede tutti i server;
//   chi ha solo `servers.ssh.manage` non le legge senza `changelog.view`;
// - `queue`: di PROGETTO, la coda e il Retry (`settings.manage`).

const instance =
  (group: string, readPermission: string) =>
  (kind: string): ChangeType => ({
    kind,
    templateKey: `changelog.kinds.${kind}`,
    readPermission,
    scope: "instance",
    group,
  });
const project =
  (group: string, readPermission: string) =>
  (kind: string): ChangeType => ({
    kind,
    templateKey: `changelog.kinds.${kind}`,
    readPermission,
    scope: "project",
    group,
  });

const providers = instance("ai", "ai_providers.manage");
const aiSettings = instance("ai", "settings.manage");
const git = instance("integrations", "git_accounts.manage");
const plugins = instance("integrations", "plugins.manage");
const google = instance("integrations", "integrations.manage");
const settings = instance("integrations", "settings.manage");
const servers = instance("servers", "monitor.manage");
const queue = project("queue", "settings.manage");

export const INSTANCE_CHANGE_TYPES: readonly ChangeType[] = [
  providers("provider.created"),
  providers("provider.updated"),
  providers("provider.reordered"),
  providers("provider.credential_replaced"),
  providers("provider.deleted"),
  aiSettings("model.changed"),
  aiSettings("automation.changed"),
  aiSettings("budget.changed"),
  aiSettings("content_language.changed"),
  git("git_account.created"),
  git("git_account.updated"),
  git("git_account.token_replaced"),
  git("git_account.deleted"),
  git("git_account.default_reviewer_changed"),
  plugins("plugin.registered"),
  plugins("plugin.ref_updated"),
  plugins("plugin.smoke_rerun"),
  plugins("plugin.removed"),
  google("google_app.created"),
  google("google_app.updated"),
  google("google_app.secret_replaced"),
  google("google_app.deleted"),
  settings("storage.changed"),
  settings("storage.secret_replaced"),
  settings("webhook.changed"),
  servers("server.created"),
  servers("server.updated"),
  servers("server.deleted"),
  servers("server.agent_key_regenerated"),
  servers("server.thresholds_changed"),
  servers("server.check_changed"),
  servers("server.ssh_access_changed"),
  queue("queue.paused"),
  queue("queue.resumed"),
  queue("job.retried"),
];

registerChangeTypes(INSTANCE_CHANGE_TYPES);
