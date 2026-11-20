// Il catalogo dei tipi di avviso (area 8, F2, R-5 = a): UN posto per il
// prototipo, il server e il worker. Era `domain/alerts/catalog.ts` del
// prototipo (area 8a, spec «Notifiche: iscrizioni per progetto») più le righe
// dei server di `data/servers/alertTypes.ts` (area 8b). Ogni tipo dice chi
// può iscriversi (non ci si iscrive a ciò che non si può vedere), il valore
// di partenza per chi non ha toccato niente e chi lo riceve senza
// iscrizione. Fuori dal catalogo, e quindi coi destinatari fissi:
// `security.alert` (ignora le preferenze, va solo all'interessato), le
// decisioni, la Chat, le Automazioni, e (S-4) tutti i kind di oggi che
// un'area non ha ancora portato qui. Nessuna tabella: è codice.

export type AlertGroup = "prs" | "releases" | "docs" | "tasks" | "members" | "support" | "monitor" | "claude";

/** Le famiglie nell'ordine in cui si mostrano. */
export const ALERT_GROUPS: readonly AlertGroup[] = [
  "prs",
  "releases",
  "docs",
  "tasks",
  // Area 10, F5: chi entra in un progetto (dopo le task, come nel prototipo).
  "members",
  "support",
  "monitor",
  "claude",
];

/** Chi riceve un avviso senza iscrizione (lo dice il produttore). */
export type MandatoryReason =
  | "merged"
  | "pr_author"
  | "task_author"
  | "assignee"
  /** Area 8, F4b: chi ha chiesto un'analisi a mano ne riceve SEMPRE l'esito (decisione del maintainer, 15 nov 2026). */
  | "analysis_requester"
  /** Area 10, F5 (D-11 = b): la persona aggiunta a un progetto riceve SEMPRE `member.added`. */
  | "added"
  /** Area 11, F2 (N-1 = a): chi è menzionato in un commento della doc di prodotto riceve SEMPRE `product_doc.mention`. */
  | "mentioned"
  /** Area 11, F2 (N-1 = a): chi SEGUE una pagina di prodotto ne riceve sempre `updated` e `question`, anche con la riga spenta. */
  | "follower";

/**
 * Il valore di partenza («App») per un membro che non ha toccato niente, dai
 * permessi di ADESSO: spento, acceso per ogni membro, o per chi ha un
 * permesso nel progetto. Un dato, non una funzione, perché lo legga il server.
 */
export type DefaultRule = "off" | "members" | { perm: string };

export interface AlertType {
  /** Il `kind` della notifica, e il `type` delle iscrizioni. */
  type: string;
  group: AlertGroup;
  labelKey: string;
  /** Chi può iscriversi: un permesso nel progetto, o l'esserne membro. */
  subscribe: { perm: string | "member" };
  /** Il valore di partenza (App), nel prototipo e nella build app salvo `appDefaultOn`. */
  defaultOn: DefaultRule;
  /**
   * Il valore di partenza nella build app (il server), quando diverso dal
   * prototipo. M-1 = a *(M)*: i `monitor.*` arrivano dal routing di oggi
   * (solo `monitor.manage`) e non cambiano destinatari di colpo (S-4); il
   * prototipo resta com'era (46).
   */
  appDefaultOn?: DefaultRule;
  /** Il Telefono di partenza, quando App parte acceso (e degli obbligatori). */
  defaultPhone: boolean;
  /** Chi lo riceve senza iscrizione: i motivi che un avviso di questo tipo può portare. */
  mandatory: MandatoryReason[];
  /** Solo obbligatorio: nessuna iscrizione, lo ricevono solo i destinatari obbligatori. */
  mandatoryOnly?: boolean;
  /**
   * Un kind di prima con lo stesso significato di uno nuovo (shape [A 10]):
   * nelle Preferenze è una riga sola, quella del tipo indicato, e
   * l'interruttore scrive entrambe le iscrizioni. Ognuno tiene il suo default.
   */
  sameRowAs?: string;
  /** Il default vale anche per i full admin che non sono membri del progetto (R-L10). */
  defaultForFullAdmins?: boolean;
  /**
   * Area 11, F2: il permesso nel progetto per VEDERE l'oggetto dell'avviso.
   * Vale per TUTTI, anche per gli obbligatori: la visibilità viene prima di
   * tutto (una menzione a chi non legge più i Docs del progetto non arriva).
   */
  seePerm?: string;
}

const label = (type: string) => `alerts.types.${type.replace(/\./g, "_")}`;

function row(
  type: string,
  group: AlertGroup,
  perm: string | "member",
  defaultOn: DefaultRule,
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

/** Gli avvisi dei server (area 8b): li riceve ogni membro, di partenza chi opera sui server e ogni full admin. */
function serverRow(type: string, defaultPhone: boolean, extra: Partial<AlertType> = {}): AlertType {
  return row(type, "monitor", "member", { perm: "servers.operate" }, defaultPhone, [], {
    defaultForFullAdmins: true,
    ...extra,
  });
}

/**
 * I tipi del catalogo, nell'ordine in cui si mostrano dentro la famiglia.
 * `release.failed` porta anche `task_author`: un merge fatto fuori da
 * Stubwise da un'identità non collegata va all'autore della task della PR.
 */
export const ALERT_TYPES: readonly AlertType[] = [
  row("pr.opened", "prs", "member", "off", false),
  row("pr.analysis_issues", "prs", "repos.view", { perm: "release.merge" }, false, ["pr_author"]),
  row("pr.corrected", "prs", "repos.view", "off", true, ["pr_author"], { mandatoryOnly: true }),
  row("release.merged", "releases", "member", "off", false),
  row("release.succeeded", "releases", "member", "off", false),
  row("release.failed", "releases", "member", { perm: "release.merge" }, true, [
    "merged",
    "task_author",
  ]),
  row("docs.release_note", "docs", "docs.view", "off", false),
  row("task.created", "tasks", "tickets.view_all", "off", false),
  row("task.created_by_automation", "tasks", "tickets.view_all", "off", false, ["assignee"]),
  row("support.request", "support", "backlog.view_all", { perm: "backlog.edit" }, false),
  row("job.pr_opened", "prs", "member", "members", false),
  row("review.completed", "prs", "member", "members", false),
  row("ticket.created", "tasks", "member", "members", false, [], { sameRowAs: "task.created" }),
  row("request.created", "support", "member", "members", false, [], {
    sameRowAs: "support.request",
  }),
  row("docs.nightly_attention", "docs", "member", "members", false),
  // Area 11, F2 (N-1 = a, maintainer): la doc di prodotto. La menzione è SOLO
  // obbligatoria (nessun interruttore, come pr.corrected), col Telefono
  // acceso; aggiornamento e domanda hanno la riga del progetto, accesa di
  // partenza per chi scrive la doc, e chi segue la pagina li riceve sempre.
  // Tutti e tre solo a chi legge i Docs del progetto (`seePerm`).
  row("product_doc.mention", "docs", "docs.view", "off", true, ["mentioned"], { mandatoryOnly: true, seePerm: "docs.view" }),
  row("product_doc.updated", "docs", "docs.view", { perm: "docs.edit" }, false, ["follower"], { seePerm: "docs.view" }),
  row("product_doc.question", "docs", "docs.view", { perm: "docs.edit" }, false, ["follower"], { seePerm: "docs.view" }),
  // I kind di prima dei server confluiscono nella riga di `server.trouble`.
  row("monitor.alert", "monitor", "member", "members", true, [], {
    sameRowAs: "server.trouble",
    appDefaultOn: { perm: "monitor.manage" },
  }),
  // Il Telefono della riga anche per i «rientrato» (decisione del maintainer, 14 nov 2026).
  row("monitor.recovered", "monitor", "member", "members", true, [], {
    sameRowAs: "server.trouble",
    appDefaultOn: { perm: "monitor.manage" },
  }),
  row("job.failed", "claude", "member", "members", false),
  // Area 10, F5 (D-11 = b, maintainer): alla persona aggiunta (obbligatorio) e a
  // chi gestisce i membri del progetto (iscrizione, acceso di partenza,
  // spegnibile); mai a chi ha fatto l'ingresso (`exclude` del produttore).
  row("member.added", "members", "project.members.manage", { perm: "project.members.manage" }, false, ["added"]),
  row("project.brief", "claude", "member", "members", false),
  serverRow("server.trouble", true),
  serverRow("server.down", true, { sameRowAs: "server.trouble" }),
  serverRow("server.recovered", true, { sameRowAs: "server.trouble" }),
  serverRow("server.diagnosis_ready", true, { mandatory: ["analysis_requester"] }),
];

/**
 * I tipi che il server della build app pubblica DAVVERO (la F2 li accende
 * man mano, con il loro produttore): solo questi hanno righe nelle
 * Preferenze dell'app. Il prototipo li mostra tutti. Un tipo entra qui con
 * il suo `notification_kind` (il test di parità lo pretende).
 */
export const LIVE_ALERT_TYPES: readonly string[] = [
  "release.failed",
  // Area 8, F2, S4 (72): i produttori ci sono (alla nascita e alla riuscita del rilascio).
  "release.merged",
  "release.succeeded",
  // Area 8, F2, S4 (72): il webhook di una PR aperta.
  "pr.opened",
  // Area 8, F2, S4 (72): la nota di rilascio del giro notturno.
  "docs.release_note",
  // Area 8, F2, S4 (72): la review che chiede modifiche.
  "pr.analysis_issues",
  // Area 8, F2, S4 (72): una correzione spinta sul ramo di un collega.
  "pr.corrected",
  "monitor.alert",
  "monitor.recovered",
  // Area 8, F3, S7 (72): la richiesta nata da una conversazione.
  "support.request",
  // Area 8, F4b, S6 (72): la diagnosi dell'analisi di un server, e l'esito per chi l'ha chiesta.
  "server.diagnosis_ready",
  // Area 10, F5 (72): un ingresso in un progetto (putProjectMember, invito accettato).
  "member.added",
];

export const alertTypeOf = (kind: string): AlertType | undefined =>
  ALERT_TYPES.find((t) => t.type === kind);

export const isCatalogKind = (kind: string): boolean => alertTypeOf(kind) !== undefined;

export const isLiveAlertType = (kind: string): boolean => LIVE_ALERT_TYPES.includes(kind);

/** Il tipo che fa da riga per `kind` nelle Preferenze (se stesso, o quello di `sameRowAs`). */
export const rowTypeOf = (kind: string): string => alertTypeOf(kind)?.sameRowAs ?? kind;

/** I tipi di una riga delle Preferenze: quello della riga, poi i kind di prima che vi confluiscono. */
export function rowPartners(rowType: string): AlertType[] {
  const main = alertTypeOf(rowType);
  if (!main) return [];
  return [main, ...ALERT_TYPES.filter((t) => t.sameRowAs === rowType)];
}

/** Le righe con almeno un tipo vivo: quelle che la build app mostra. */
export function liveRowTypes(): string[] {
  const rows = new Set<string>();
  for (const t of LIVE_ALERT_TYPES) rows.add(rowTypeOf(t));
  return ALERT_TYPES.map((t) => t.type).filter((t) => rows.has(t));
}

/** Se il default di partenza vale per chi ha questi permessi nel progetto. */
export function defaultApplies(rule: DefaultRule, holds: (perm: string) => boolean): boolean {
  if (rule === "off") return false;
  if (rule === "members") return true;
  return holds(rule.perm);
}
