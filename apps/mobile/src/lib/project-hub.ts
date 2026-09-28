import { isUnknown } from "@stubwise/shared";
import type { ProjectPulseSummary, Reader, TicketPriority } from "@stubwise/shared";
import { serverIsBroken } from "./server-health";
import { stalledDays } from "./stalled";

/**
 * LA LOGICA PURA DEL DETTAGLIO PROGETTO v3 (28 set 2026, design
 * `docs/plans/2026-09-28-project-hub-v3-design.md`): cosa va in «Tocca a te»,
 * dove porta ogni bottone, cosa «aspetta altri», il badge, l'allarme del
 * monitor, le automazioni accese e il riassunto del backlog.
 *
 * Qui e non nella schermata perché sono REGOLE, e una regola dentro un
 * componente si verifica solo montandolo.
 */

type Summary = Reader<ProjectPulseSummary>;
type MergeItem = Summary["waitingForMerge"][number];

/** L'azione del bottone di una riga di «Tocca a te». */
export type YourTurnAction = "answer" | "approve" | "merge";

export interface YourTurnRow {
  /** Identità della riga: per le PR è `prUrl` — un ticket su due repo ha due PR. */
  key: string;
  ticketId: string;
  ticketNumber: number;
  title: string;
  priority?: Reader<TicketPriority>;
  /** `unknown`: un tipo d'attesa che questa build non conosce (server più nuovo). */
  kind: "question" | "plan_approval" | "merge" | "unknown";
  /** `null`: la riga c'è, il bottone no — resta premibile verso il ticket. */
  action: YourTurnAction | null;
  notificationId?: string;
  merge?: { prUrl: string; repositoryId?: string; repositoryName?: string };
}

/**
 * Dove si va. I bottoni portano DOVE SI DECIDE, non decidono dalla riga
 * (design, decisione 1): approvare un piano senza leggerlo toglierebbe senso
 * al cancello.
 */
export type HubDestination =
  | { kind: "inboxCard"; notificationId: string }
  | { kind: "ticket"; ticketId: string }
  | {
      kind: "confirmMerge";
      ticketId: string;
      ticketNumber: number;
      title: string;
      repositoryId: string;
      repositoryName?: string;
      prUrl: string;
    };

/**
 * «Tocca a te»: le domande e i piani di `waitingForYou`, poi le PR con
 * `canMerge`.
 *
 * ⚠️ `canMerge` si LEGGE, non si deduce dal ruolo: lo calcola il server
 * (CLAUDE.md, «I due divieti dell'operatore», punto 2). Una PR senza
 * `canMerge` non entra qui, in nessun caso.
 *
 * ⚠️ Il bottone Mergia vuole `canMerge` E `repositoryId`: senza il secondo
 * (un server più vecchio, che non lo manda) la rotta di rilascio non è
 * chiamabile, quindi la riga resta — è comunque il tuo turno — ma senza
 * bottone, e il tap porta al ticket.
 */
export function yourTurnRows(summary: Summary): YourTurnRow[] {
  const decisions: YourTurnRow[] = summary.waitingForYou.map((item) => {
    const kind = isUnknown(item.kind) ? "unknown" : item.kind;
    return {
      key: `you-${item.ticketId}-${item.notificationId}`,
      ticketId: item.ticketId,
      ticketNumber: item.ticketNumber,
      title: item.title,
      ...(item.priority !== undefined ? { priority: item.priority } : {}),
      kind,
      action: kind === "question" ? "answer" : kind === "plan_approval" ? "approve" : null,
      notificationId: item.notificationId,
    };
  });

  const merges: YourTurnRow[] = summary.waitingForMerge
    .filter((item) => item.canMerge)
    .map((item) => ({
      key: `merge-${item.prUrl}`,
      ticketId: item.ticketId,
      ticketNumber: item.ticketNumber,
      title: item.title,
      ...(item.priority !== undefined ? { priority: item.priority } : {}),
      kind: "merge",
      action: item.repositoryId !== undefined ? "merge" : null,
      merge: mergeFields(item),
    }));

  return [...decisions, ...merges];
}

function mergeFields(item: MergeItem): NonNullable<YourTurnRow["merge"]> {
  return {
    prUrl: item.prUrl,
    ...(item.repositoryId !== undefined ? { repositoryId: item.repositoryId } : {}),
    ...(item.repositoryName !== undefined ? { repositoryName: item.repositoryName } : {}),
  };
}

/** Dove porta il BOTTONE di una riga di «Tocca a te»; `null` se non ne ha uno. */
export function buttonDestination(row: YourTurnRow): HubDestination | null {
  if (row.action === "answer" && row.notificationId !== undefined) {
    return { kind: "inboxCard", notificationId: row.notificationId };
  }
  if (row.action === "approve") return { kind: "ticket", ticketId: row.ticketId };
  if (row.action === "merge" && row.merge?.repositoryId !== undefined) {
    return {
      kind: "confirmMerge",
      ticketId: row.ticketId,
      ticketNumber: row.ticketNumber,
      title: row.title,
      repositoryId: row.merge.repositoryId,
      ...(row.merge.repositoryName !== undefined ? { repositoryName: row.merge.repositoryName } : {}),
      prUrl: row.merge.prUrl,
    };
  }
  return null;
}

/** Il tap su una riga, fuori dal bottone: sempre il ticket. */
export function rowDestination(row: { ticketId: string }): HubDestination {
  return { kind: "ticket", ticketId: row.ticketId };
}

/**
 * Il numero del badge di Adesso: le righe di «Tocca a te». Una PR senza
 * repository conta lo stesso — è il tuo turno anche se da qui non la mergi.
 */
export function yourTurnCount(summary: Summary): number {
  return summary.waitingForYou.length + summary.waitingForMerge.filter((item) => item.canMerge).length;
}

export type OthersTrailing =
  | { kind: "who"; who: "requester" | "maintainer" }
  | { kind: "merge" }
  | { kind: "stalled"; days: number };

export interface OthersRow {
  key: string;
  ticketId: string;
  ticketNumber: number;
  title: string;
  trailing: OthersTrailing;
}

/**
 * «Aspetta altri · fermi», nell'ordine del §4: le attese altrui, poi le PR
 * che non puoi mergiare tu, poi i fermi. I giorni di fermo li conta il
 * CLIENT dalla data (`lib/stalled.ts`); il MOTIVO resta nel ticket.
 *
 * Un ruolo sconosciuto (server più nuovo) ricade sul richiedente, il meno
 * privilegiato dei due — mai un valore grezzo mostrato.
 */
export function othersRows(summary: Summary, now: Date): OthersRow[] {
  return [
    ...summary.waitingForOthers.map((item) => ({
      key: `other-${item.ticketId}`,
      ticketId: item.ticketId,
      ticketNumber: item.ticketNumber,
      title: item.title,
      trailing: {
        kind: "who" as const,
        who: !isUnknown(item.who.kind) && item.who.kind === "maintainer" ? ("maintainer" as const) : ("requester" as const),
      },
    })),
    ...summary.waitingForMerge
      .filter((item) => !item.canMerge)
      .map((item) => ({
        key: `merge-${item.prUrl}`,
        ticketId: item.ticketId,
        ticketNumber: item.ticketNumber,
        title: item.title,
        trailing: { kind: "merge" as const },
      })),
    ...summary.stalled.map((item) => ({
      key: `stalled-${item.ticketId}`,
      ticketId: item.ticketId,
      ticketNumber: item.ticketNumber,
      title: item.title,
      trailing: { kind: "stalled" as const, days: stalledDays(item.stalledSince, now) },
    })),
  ];
}

/**
 * Adesso non ha niente da mostrare: al posto dei blocchi va la frase del
 * polso (§4.5). Il backlog pronto non conta — sta nella tab Lavoro.
 */
export function nowIsEmpty(summary: Summary): boolean {
  return (
    summary.waitingForYou.length === 0 &&
    summary.waitingForMerge.length === 0 &&
    summary.waitingForOthers.length === 0 &&
    summary.running.length === 0 &&
    summary.stalled.length === 0
  );
}

export interface MonitorAlert {
  /** Il PRIMO server giù, nell'ordine della risposta: è quello che si nomina. */
  serverId: string;
  serverName: string;
  offline: boolean;
  checksDown: number;
  brokenCount: number;
  serverCount: number;
}

/**
 * Un server del progetto è giù? `serverIsBroken` è la regola già usata dal
 * monitor: offline o con controlli giù. Un server mai connesso NON è un
 * guasto, e un banner rosso che c'è sempre smette di dire qualcosa.
 */
export function monitorAlert(servers: readonly { id: string; name: string; status: string; checksDown: number }[]): MonitorAlert | null {
  const broken = servers.filter((server) => serverIsBroken(server));
  const first = broken[0];
  if (first === undefined) return null;
  return {
    serverId: first.id,
    serverName: first.name,
    offline: first.status === "offline",
    checksDown: first.checksDown,
    brokenCount: broken.length,
    serverCount: servers.length,
  };
}

/**
 * Le automazioni ACCESE di un progetto, contate sui booleani di
 * `projectSchema` (`packages/shared/src/schemas/project.ts`), verificati sul
 * codice il 28 set 2026 — sono cinque:
 *  - `docAutoUpdate` (documentazione aggiornata a ogni push);
 *  - `dailyReportEnabled` (report giornaliero);
 *  - `backlogEnabled` (backlog di discovery);
 *  - `pulseEnabled` (pulse proattivo) — ⚠️ solo se c'è ANCHE il backlog: senza
 *    non ha niente da proporre, e il poller pesca solo i progetti con entrambi
 *    i flag (CLAUDE.md, fase 2). Contarlo prometterebbe un'automazione che non
 *    succede;
 *  - `weeklyBriefEnabled` (brief settimanale).
 *
 * `graphEnabled` NON è qui: è per repository, non per progetto.
 */
export function activeAutomationCount(project: {
  docAutoUpdate: boolean;
  dailyReportEnabled: boolean;
  backlogEnabled: boolean;
  pulseEnabled: boolean;
  weeklyBriefEnabled: boolean;
}): number {
  return [
    project.docAutoUpdate,
    project.dailyReportEnabled,
    project.backlogEnabled,
    project.pulseEnabled && project.backlogEnabled,
    project.weeklyBriefEnabled,
  ].filter(Boolean).length;
}

export interface BacklogSummary {
  total: number;
  ready: number;
  toPrepare: number;
  /** Da 0 a 1: la parte verde della barra. */
  readyFraction: number;
}

/**
 * Il backlog in due numeri: pronte (`backlogReadyCount` del polso) e da
 * preparare (le altre voci ATTIVE: il `total` della lista, che esclude già
 * convertite e archiviate).
 *
 * I due numeri vengono da due risposte diverse, quindi possono raccontare
 * momenti diversi per qualche secondo: le pronte si tengono entro il totale,
 * così non escono mai «-1 da preparare» né una barra oltre il pieno.
 */
export function backlogSummary(total: number, readyCount: number): BacklogSummary {
  const ready = Math.min(readyCount, total);
  return {
    total,
    ready,
    toPrepare: Math.max(0, total - ready),
    readyFraction: total > 0 ? ready / total : 0,
  };
}
