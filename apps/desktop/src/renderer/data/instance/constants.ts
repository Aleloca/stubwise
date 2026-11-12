import { GOOGLE_OAUTH_CALLBACK_PATH, googleOauthScopes } from "@stubwise/shared";
import type { WebhookGroup } from "./webhook";

// Costanti dell'istanza senza stato né seme (integrazione area 2, fetta 1:
// le superfici della build app le importano). I moduli d'origine le
// ri-esportano.

export const OTHER_PROJECTS_KEY = "other";

/**
 * Oltre questa percentuale della settimana il lavoro di sfondo (Docs
 * notturni, report) aspetta il reset settimanale (deploy-log, «Quota degli
 * account»). La pagina lo dice in una riga; il prototipo non lo simula.
 */
export const BACKGROUND_WEEKLY_THRESHOLD = 90;

/** I 21 eventi, nell'ordine e nei gruppi dello shape. `monitor` copre anche `server.trouble`, `server.down`, `server.recovered`. */
export const WEBHOOK_EVENTS = [
  { id: "ticket.created", source: "web", group: "tasks" },
  { id: "task.created_by_automation", source: "catalog", group: "tasks" },
  { id: "support.request", source: "catalog", group: "tasks" },
  { id: "job.plan_review", source: "web", group: "work" },
  { id: "job.awaiting_input", source: "web", group: "work" },
  { id: "job.held", source: "web", group: "work" },
  { id: "job.budget_held", source: "web", group: "work" },
  { id: "job.failed", source: "web", group: "work" },
  { id: "job.pr_opened", source: "web", group: "prs" },
  { id: "job.pr_closed", source: "web", group: "prs" },
  { id: "review.completed", source: "web", group: "prs" },
  { id: "pr.analysis_issues", source: "catalog", group: "prs" },
  { id: "release.merged", source: "catalog", group: "prs" },
  { id: "release.succeeded", source: "catalog", group: "prs" },
  { id: "release.failed", source: "catalog", group: "prs" },
  { id: "docs.limit_paused", source: "web", group: "docs" },
  { id: "docs.release_note", source: "catalog", group: "docs" },
  { id: "monitor", source: "web", group: "servers" },
  { id: "server.diagnosis_ready", source: "catalog", group: "servers" },
  { id: "project.pulse", source: "web", group: "project" },
  { id: "project.brief", source: "web", group: "project" },
] as const satisfies readonly { id: string; source: "web" | "catalog"; group: WebhookGroup }[];

/** L'origine finta dell'istanza: i link e il comando di Claude Code la usano. */
export const INSTANCE_ORIGIN = "https://stubwise.example.test";

/**
 * Cosa incollare nella Google Cloud Console (parità col web, shape «How to
 * set it up in Google Cloud»): l'URI di reindirizzamento dell'istanza e gli
 * scope che Stubwise chiede: quelli del server (`googleOauthScopes` di
 * `@stubwise/shared`, il riconsenso unico dell'area 6: Gmail con letto/non
 * letto, Calendar, Drive in lettura).
 */
export const GOOGLE_SETUP = {
  redirectUri: `${INSTANCE_ORIGIN}${GOOGLE_OAUTH_CALLBACK_PATH}`,
  scopes: googleOauthScopes,
} as const;
