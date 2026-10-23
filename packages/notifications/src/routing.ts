import type { InstancePermission, ProjectPermission } from "@stubwise/shared";
import type { NotificationEvent, NotificationKind } from "./format.js";
import { permissionsForProposalActions } from "./proposal-permissions.js";

/**
 * Instradamento PURO delle notifiche: da un evento (+ il contesto già risolto
 * dal chiamante) all'elenco dei destinatari che se lo vedranno comparire in
 * inbox.
 *
 * Nessun I/O qui: le query che risolvono deciders, membri, follower,
 * richiedente e persone del ticket vivono in `./publish.ts`. Tenere la decisione separata dalla
 * lettura la rende testabile senza DB ed è l'unico punto da cambiare quando le
 * regole di routing evolvono.
 */

/** Chi è coinvolto da un evento, già risolto in id utente dal chiamante. */
export interface RoutingContext {
  /**
   * Chi può DECIDERE sull'evento: chi ha il permesso pertinente del kind
   * ({@link permissionForKind}) nel progetto dell'evento — o nell'istanza, per
   * i permessi d'istanza — più i full admin. Sostituisce gli `admins` di prima
   * della fase permessi: un `Developer` non riceve un piano da approvare, un
   * `Project Lead` sì.
   */
  deciders: string[];
  /**
   * Chi VEDE il progetto dell'evento (membri + full admin): ogni destinatario
   * di un evento di progetto ci deve stare dentro, così nessuno riceve una card
   * che il filtro a lettura gli nasconderebbe (né la sua push o il suo DM).
   * `null` = evento senza progetto (fatti d'istanza): nessun filtro.
   */
  members: string[] | null;
  /** Chi segue il progetto dell'evento (`project_follows`). */
  followers: string[];
  /** Operatore che ha lanciato il job (`ai_jobs.requested_by_user_id`). */
  requestedBy?: string;
  /** Assegnatario del ticket (`tickets.assignee_id`). */
  assignee?: string;
  /**
   * Chi ha aperto il ticket. Oggi lo schema NON ha una colonna reporter (i
   * ticket nascono da ingestion/widget/Slack, senza autore interno): il campo
   * resta nel contratto perché il routing lo prevede e `publish` lo popolerà
   * appena la colonna esiste, senza toccare queste regole.
   */
  reporter?: string;
  /**
   * Proprietario della casella Google da cui nasce l'evento (fase 6): l'UNICO
   * destinatario dell'audience `mailbox_owner`. Il chiamante lo risolve da
   * `google_accounts.user_id`.
   */
  mailboxOwner?: string;
  /**
   * Titolare dell'account di cui parla l'evento (secondo fattore): l'UNICO
   * destinatario dell'audience `account_owner`. Il chiamante lo passa in
   * `PublishOpts.accountUserId`.
   */
  accountOwner?: string;
}

/** I pubblici possibili di un kind (vedi {@link AUDIENCE_FOR_KIND}). */
export type Audience =
  | "deciders"
  | "broadcast"
  | "requester"
  | "mailbox_owner"
  | "project_deciders"
  | "account_owner";

/**
 * Pubblico di un kind: `deciders` per gli eventi che richiedono una DECISIONE
 * (solo chi ha il permesso di prenderla) o che sono fatti d'istanza; `broadcast` per
 * gli eventi di AVANZAMENTO, che interessano anche le persone del ticket e chi
 * segue il progetto; `requester` per le domande dell'AI, che riguardano chi ha
 * lanciato il job (più i deciders, che possono sempre sbloccarlo).
 *
 * Record esaustivo su `NotificationKind`: un kind nuovo non compila finché non
 * gli si sceglie un pubblico.
 */
const AUDIENCE_FOR_KIND: Record<NotificationKind, Audience> = {
  // Decisionali: qualcuno deve approvare il piano o sbloccare un job fermo.
  "job.plan_review": "deciders",
  "job.held": "deciders",
  "job.budget_held": "deciders",
  // Avanzamento del lavoro su un ticket.
  "ticket.created": "broadcast",
  "job.pr_opened": "broadcast",
  "job.pr_closed": "broadcast",
  "job.failed": "broadcast",
  "review.completed": "broadcast",
  // Fatti d'istanza (anche quando portano un progetto): chi gestisce
  // l'impostazione o il monitor.
  "docs.limit_paused": "deciders",
  "docs.nightly_attention": "deciders",
  // Il maintainer deve sapere che un collaboratore ha chiesto qualcosa.
  "request.created": "deciders",
  "monitor.alert": "deciders",
  "monitor.recovered": "deciders",
  // La domanda dell'AI è rivolta a chi ha chiesto quel lavoro: chi segue il
  // progetto, l'assegnatario e il reporter non c'entrano — rispondere è una
  // decisione sul come procedere, non un aggiornamento da leggere.
  "job.awaiting_input": "requester",
  // Il pulse ha la FORMA della domanda ma non il suo pubblico: non è rivolto a
  // chi ha chiesto un lavoro (non c'è nessun job dietro), è un suggerimento al
  // TEAM su un progetto fermo. Chi segue il progetto è esattamente chi vuole
  // saperlo. Senza ticket restano deciders ∪ follower: assegnatario,
  // richiedente e reporter non esistono per questo evento.
  "project.pulse": "broadcast",
  // Il brief racconta com'è andata la settimana su un progetto: lo vuole chi
  // quel progetto lo segue, più gli admin. Stesso pubblico del pulse, per la
  // stessa ragione — e come il pulse non ha ticket, quindi assegnatario,
  // richiedente e reporter non esistono per questo evento.
  "project.brief": "broadcast",
  // ⚠️ PRIVACY PER COSTRUZIONE (fase 6): la proposta nasce dalla casella di una
  // persona, e la vede SOLO quella persona. Non è un caso particolare di
  // `requester` — che include sempre i deciders — ed è per questo che
  // l'audience esiste come valore a sé: qui un admin in più non è "uno che può
  // sbloccare", è qualcuno che legge la posta di un collega.
  "google.proposal": "mailbox_owner",
  // Fase permessi: la proposta PASSATA dal proprietario al progetto. Un'audience
  // a sé, e non `deciders`, per due ragioni che quella non ha: i permessi
  // pertinenti dipendono dalle AZIONI dell'evento (vedi
  // {@link deciderPermissionsFor}), e il proprietario della casella ne è
  // escluso — la sua card ce l'ha già. Non tocca `mailbox_owner`: la card del
  // proprietario resta sua sola; questa è una card NUOVA.
  "google.proposal_handed": "project_deciders",
  // Secondo fattore: l'avviso di sicurezza riguarda UN account, e lo riceve
  // solo il suo titolare. Un'audience a sé e non `mailbox_owner`: le due
  // invarianti sono diverse (quella dice «la posta è privata», questa «chi
  // subisce un'azione sul proprio account lo sa») e devono poter evolvere
  // separate. In comune hanno solo che nessun admin entra per ruolo.
  "security.alert": "account_owner",
};

/** Pubblico del kind. Unico punto in cui si legge {@link AUDIENCE_FOR_KIND}. */
export function audienceFor(kind: NotificationKind): Audience {
  return AUDIENCE_FOR_KIND[kind];
}

/** Il permesso che fa di qualcuno un DECIDER per un kind (`null` = i soli full admin). */
export type KindPermission = ProjectPermission | InstancePermission | null;

/**
 * Il permesso PERTINENTE di un kind: chi ce l'ha (nel progetto dell'evento, o
 * nell'istanza per i permessi d'istanza) è fra i `deciders`, insieme ai full
 * admin. È la traduzione degli `admins` di prima: ciascun kind prende il
 * permesso della rotta che decide su di lui.
 *
 * Esaustivo su `NotificationKind`, come {@link AUDIENCE_FOR_KIND}: un kind
 * nuovo non compila finché non gli si sceglie un permesso. `null` vuol dire
 * «nessun permesso è la decisione»: restano i full admin, che prima della
 * fase permessi erano gli admin che ricevevano tutto — e sono membri impliciti
 * di ogni progetto, quindi ricevono le notifiche rivolte ai membri.
 */
export const PERMISSION_FOR_KIND: Record<NotificationKind, KindPermission> = {
  // Il piano lo approva solo chi ha `plans.approve` (i due divieti).
  "job.plan_review": "plans.approve",
  // Un job fermo (limite, gate dell'automazione, budget) è una DECISIONE: la
  // riceve chi può decidere del lavoro nel progetto, come prima la ricevevano
  // i soli admin (ruling R32) — non chiunque possa avviare un run.
  "job.held": "plans.approve",
  "job.budget_held": "plans.approve",
  // Chi ha chiesto qualcosa da collaboratore lo deve sapere chi gestisce i
  // membri del progetto (ruling R14: «collaboratore» = senza
  // `project.members.manage`).
  "request.created": "project.members.manage",
  // Fatti d'istanza: chi gestisce il monitor, chi gestisce le impostazioni.
  "monitor.alert": "monitor.manage",
  "monitor.recovered": "monitor.manage",
  "docs.limit_paused": "settings.manage",
  "docs.nightly_attention": "settings.manage",
  // Alla domanda dell'agente risponde, oltre al richiedente, chi può decidere
  // del piano: `plans.approve`, l'equivalente del maintainer che prima la
  // sbloccava (`actorAllows` su `answer` usa lo stesso permesso).
  "job.awaiting_input": "plans.approve",
  // Avanzamento: nessuna decisione, quindi nessun permesso. I destinatari sono
  // le persone del ticket e i follower (fra i membri), più i full admin.
  "ticket.created": null,
  "job.pr_opened": null,
  "job.pr_closed": null,
  "job.failed": null,
  "review.completed": null,
  "project.pulse": null,
  "project.brief": null,
  // Privacy per costruzione: la proposta non ha deciders (vedi `mailbox_owner`).
  "google.proposal": null,
  // Per EVENTO, non per kind: i permessi li danno le azioni della proposta
  // passata ({@link deciderPermissionsFor}). `null` qui è il ripiego di chi
  // legge questa mappa senza l'evento in mano: i soli full admin.
  "google.proposal_handed": null,
  // Nessun decider: un solo destinatario, il titolare (vedi `account_owner`).
  "security.alert": null,
};

/** Permesso pertinente del kind. Unico punto in cui si legge {@link PERMISSION_FOR_KIND}. */
export function permissionForKind(kind: NotificationKind): KindPermission {
  return PERMISSION_FOR_KIND[kind];
}

/**
 * I permessi che fanno di qualcuno un DECIDER per QUESTO evento. Per quasi
 * ogni kind è il solo {@link permissionForKind}; per la proposta passata
 * (`google.proposal_handed`) sono i permessi delle sue azioni
 * (`permissionsForProposalActions`): basta averne UNO nel progetto per
 * riceverla — quali opzioni potrà confermare lo ricontrolla il server, azione
 * per azione. Una proposta passata senza azioni che chiedano permessi va ai
 * soli full admin (`[null]`).
 */
export function deciderPermissionsFor(event: NotificationEvent): KindPermission[] {
  if (event.kind === "google.proposal_handed") {
    const permissions = permissionsForProposalActions(Array.isArray(event.actions) ? event.actions : []);
    return permissions.length > 0 ? permissions : [null];
  }
  return [permissionForKind(event.kind)];
}

/**
 * Destinatari dell'evento, senza duplicati e in ordine stabile (deciders prima,
 * poi le persone del ticket, infine i follower del progetto). L'ordine non ha
 * significato funzionale ma rende deterministici test e insert.
 *
 * Su ogni pubblico tranne `mailbox_owner` i destinatari sono intersecati con
 * chi VEDE il progetto (`ctx.members`): un follower uscito dal progetto, un
 * richiedente rimosso o un assegnatario senza più accesso non ricevono nulla.
 * La domanda non resta orfana: i deciders la ricevono comunque.
 */
export function recipientsFor(event: NotificationEvent, ctx: RoutingContext): string[] {
  const visible = (ids: (string | undefined | null)[]): string[] => {
    const unique = dedupe(ids);
    if (ctx.members === null) return unique;
    const members = new Set(ctx.members);
    return unique.filter((id) => members.has(id));
  };
  switch (audienceFor(event.kind)) {
    case "deciders":
      return visible(ctx.deciders);
    case "requester":
      // Chi ha lanciato il job più i deciders. Senza richiedente (run
      // dell'automazione), o con un richiedente che non vede più il progetto,
      // restano i deciders: qualcuno deve pur rispondere.
      return visible([...ctx.deciders, ctx.requestedBy]);
    case "mailbox_owner":
      // Un solo destinatario, e NESSUN decider: senza `mailboxOwner` risolto la
      // notifica non ha destinatari — meglio nessuna notifica che una notifica
      // alla persona sbagliata. Nessun filtro di appartenenza: la posta è del
      // proprietario della casella, non del progetto.
      return dedupe([ctx.mailboxOwner]);
    case "account_owner":
      // Il solo titolare dell'account, nessun decider e nessun filtro di
      // appartenenza (l'evento non ha progetto). Senza titolare risolto,
      // nessun destinatario: un avviso di sicurezza alla persona sbagliata è
      // peggio di un avviso mancato.
      return dedupe([ctx.accountOwner]);
    case "project_deciders":
      // I decisori del progetto (fra chi lo vede), MAI il proprietario della
      // casella: ha già la sua card, e questa esiste perché lui non poteva
      // decidere.
      return visible(ctx.deciders).filter((id) => id !== ctx.mailboxOwner);
    case "broadcast":
      return visible([
        ...ctx.deciders,
        ctx.requestedBy,
        ctx.assignee,
        ctx.reporter,
        ...ctx.followers,
      ]);
  }
}

/** Scarta i valori non risolti e i doppioni, preservando la prima occorrenza. */
function dedupe(ids: (string | undefined | null)[]): string[] {
  return [...new Set(ids.filter((id): id is string => !!id))];
}
