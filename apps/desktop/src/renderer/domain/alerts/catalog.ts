import type { MandatoryReason } from "../../data/model";
import type { Permission } from "../../data/viewer";

// Il catalogo dei tipi di avviso (area 8a, spec «Notifiche: iscrizioni per
// progetto»). Ogni tipo dice chi può iscriversi (non ci si iscrive a ciò che
// non si può vedere), il valore di partenza per chi non ha toccato niente e
// chi lo riceve senza iscrizione. Le aree successive aggiungono righe con
// `registerAlertTypes` (8b: server in difficoltà, diagnosi pronta), non
// meccanismi nuovi. Fuori dal catalogo, e quindi coi destinatari fissi:
// `security.alert` (ignora le preferenze, va solo all'interessato), le
// decisioni (`DECISION_NOTIFICATION_KINDS`), Chat e Automazioni.

export type AlertGroup = "prs" | "releases" | "docs" | "tasks" | "support" | "monitor" | "claude";

/** Le famiglie nell'ordine in cui si mostrano. */
export const ALERT_GROUPS: readonly AlertGroup[] = [
  "prs",
  "releases",
  "docs",
  "tasks",
  "support",
  "monitor",
  "claude",
];

export interface AlertType {
  /** Il `kind` della notifica, e il `type` delle iscrizioni. */
  type: string;
  group: AlertGroup;
  labelKey: string;
  /** Chi può iscriversi: un permesso nel progetto, o l'esserne membro. */
  subscribe: { perm: Permission | "member" };
  /** Il valore di partenza (App) per un membro senza righe, dai permessi di adesso. */
  defaultOn: (perms: (p: Permission) => boolean) => boolean;
  /** Il Telefono di partenza, quando App parte acceso (e degli obbligatori). */
  defaultPhone: boolean;
  /** Chi lo riceve senza iscrizione: i motivi che un avviso di questo tipo può portare. */
  mandatory: MandatoryReason[];
  /**
   * Solo obbligatorio: nessuna iscrizione, lo ricevono solo i destinatari
   * obbligatori («Claude ha corretto la tua PR»). Il permesso dice comunque
   * chi può vederlo.
   */
  mandatoryOnly?: boolean;
  /**
   * Un kind di prima con lo stesso significato di uno nuovo (shape [A 10]):
   * nelle Preferenze è una riga sola, quella del tipo indicato, e
   * l'interruttore scrive entrambe le iscrizioni. Ognuno tiene il suo
   * default, così il passaggio non cambia ciò che ognuno riceve.
   */
  sameRowAs?: string;
}

const members = () => true;
const off = () => false;
const holds = (perm: Permission) => (perms: (p: Permission) => boolean) => perms(perm);

const label = (type: string) => `alerts.types.${type.replace(/\./g, "_")}`;

function row(
  type: string,
  group: AlertGroup,
  perm: Permission | "member",
  defaultOn: AlertType["defaultOn"],
  defaultPhone: boolean,
  mandatory: MandatoryReason[] = [],
  extra: Partial<AlertType> = {},
): AlertType {
  return {
    type,
    group,
    labelKey: label(type),
    subscribe: { perm },
    defaultOn,
    defaultPhone,
    mandatory,
    ...extra,
  };
}

/**
 * I tipi del catalogo, nell'ordine in cui si mostrano dentro la famiglia.
 * `release.failed` porta anche `task_author`: un merge fatto fuori da
 * Stubwise da un'identità non collegata va all'autore della task della PR
 * (`mergeMandatory`).
 */
export const ALERT_TYPES: AlertType[] = [
  // Dallo spec (8a).
  row("pr.opened", "prs", "member", off, false),
  row("pr.analysis_issues", "prs", "repos.view", holds("release.merge"), false, ["pr_author"]),
  row("pr.corrected", "prs", "repos.view", off, true, ["pr_author"], { mandatoryOnly: true }),
  row("release.merged", "releases", "member", off, false),
  row("release.succeeded", "releases", "member", off, false),
  row("release.failed", "releases", "member", holds("release.merge"), true, [
    "merged",
    "task_author",
  ]),
  row("docs.release_note", "docs", "docs.view", off, false),
  row("task.created", "tasks", "tickets.view_all", off, false),
  // Decisione del 29 ott 2026: le task create da un'automazione hanno un
  // tipo loro (non partono come «Nuova task»), e l'assegnatario lo riceve
  // sempre — è chi dovrà farla.
  row("task.created_by_automation", "tasks", "tickets.view_all", off, false, ["assignee"]),
  row("support.request", "support", "backlog.view_all", holds("backlog.edit"), false),
  // R-K12: segue una conversazione chi la vede (ogni membro), quindi l'avviso
  // lo può ricevere ogni membro; acceso di default solo per chi risponde.
  row("support.customer_replied", "support", "member", holds("support.reply"), true, [
    "follows_conversation",
  ]),
  // I kind di prima: la regola di oggi (tutti i membri) come default.
  row("job.pr_opened", "prs", "member", members, false),
  row("review.completed", "prs", "member", members, false),
  row("ticket.created", "tasks", "member", members, false, [], { sameRowAs: "task.created" }),
  row("request.created", "support", "member", members, false, [], {
    sameRowAs: "support.request",
  }),
  row("docs.nightly_attention", "docs", "member", members, false),
  row("monitor.alert", "monitor", "member", members, true),
  row("monitor.recovered", "monitor", "member", members, false),
  row("job.failed", "claude", "member", members, false),
  row("project.brief", "claude", "member", members, false),
];

/**
 * Il catalogo «di partenza»: i tipi qui sopra più quelli registrati al
 * caricamento dei moduli (8b), fotografato al primo `resetAlertTypes`.
 */
let baseline: AlertType[] | null = null;

/**
 * Rimette il catalogo com'era al caricamento: la prima chiamata (il primo
 * `resetApi`, dopo gli import) lo fotografa, le successive tolgono ciò che
 * è stato registrato dopo (le righe di prova dei test). Lo chiama `resetApi`.
 */
export function resetAlertTypes(): void {
  if (baseline === null) baseline = [...ALERT_TYPES];
  else ALERT_TYPES.splice(0, ALERT_TYPES.length, ...baseline);
}

/**
 * Il punto d'estensione delle aree successive (8b): aggiunge i tipi, o
 * sostituisce quelli con lo stesso `type`. Va chiamato al caricamento di un
 * modulo importato STATICAMENTE dal livello dati (`data/…`), mai da una
 * pagina o da un import dinamico: la fotografia del catalogo si scatta al
 * primo `resetApi`, non a fine caricamento. Quindi un tipo registrato dopo
 * il primo reset (una pagina caricata in lazy) sparirebbe al reset
 * successivo, e una registrazione di prova fatta prima del primo reset di un
 * file di test resterebbe nel catalogo per tutto quel file.
 */
export function registerAlertTypes(rows: AlertType[]): void {
  for (const r of rows) {
    const i = ALERT_TYPES.findIndex((t) => t.type === r.type);
    if (i >= 0) ALERT_TYPES[i] = r;
    else ALERT_TYPES.push(r);
  }
}

export const alertTypeOf = (kind: string): AlertType | undefined =>
  ALERT_TYPES.find((t) => t.type === kind);

export const isCatalogKind = (kind: string): boolean => alertTypeOf(kind) !== undefined;

/** Il tipo che fa da riga per `kind` nelle Preferenze (se stesso, o quello di `sameRowAs`). */
export const rowTypeOf = (kind: string): string => alertTypeOf(kind)?.sameRowAs ?? kind;

/** I tipi di una riga delle Preferenze: quello della riga, poi i kind di prima che vi confluiscono. */
export function rowPartners(rowType: string): AlertType[] {
  const main = alertTypeOf(rowType);
  if (!main) return [];
  return [main, ...ALERT_TYPES.filter((t) => t.sameRowAs === rowType)];
}
