import { inboxDecisionActionSchema } from "@stubwise/shared";
import type { InboxItem, Reader } from "@stubwise/shared";

/** Chi guarda l'inbox: il solo dato che `sectionize` legge di `SessionUser`. */
export interface InboxViewer {
  role: "admin" | "member";
}

/**
 * Le azioni DECISIONALI, derivate dallo schema condiviso (stessa scelta di
 * `INBOX_DECISION_ACTIONS` in `apps/web/src/lib/api.ts`): l'insieme che
 * `POST /api/inbox/:id/actions/:action` accetta, e quindi anche l'insieme che
 * rende una riga "da decidere" invece che "da sapere".
 */
const DECISION_ACTIONS = new Set<string>(inboxDecisionActionSchema.options);

/**
 * I kind la cui decisione è riservata a un maintainer — speculare a
 * `adminOnly: true` nel catalogo server (`packages/notifications/src/actions.ts`,
 * `CATALOG_FOR_KIND`). Duplicato qui invece di importato: quel modulo non è nel
 * grafo di `@stubwise/shared` e non deve entrarci solo per due nomi di kind, che
 * cambiano di rado quanto il catalogo stesso.
 *
 * Serve a distinguere, a parità di "nessuna azione decisionale disponibile per
 * chi guarda", DUE letture diverse: un kind qui dentro senza decisione è "sta
 * aspettando un maintainer" (`waitingOthers`); un kind fuori da questo elenco
 * senza decisione è solo informativo (`fromProjects`).
 */
const ADMIN_GATED_KINDS = new Set<string>(["job.plan_review", "job.budget_held"]);

/** Il kind ha una decisione riservata a un maintainer? (vedi {@link ADMIN_GATED_KINDS}). */
export function isAdminGatedKind(kind: string): boolean {
  return ADMIN_GATED_KINDS.has(kind);
}

/**
 * La riga offre a CHI GUARDA un'azione decisionale? `actions` arriva già
 * filtrato dal server per ruolo e identità (vedi `inboxItemSchema`): se contiene
 * `approve_plan`/`reject_plan`/`relaunch`/`answer`, è perché QUESTO utente può
 * davvero premerla — non c'è un secondo controllo di permesso da rifare qui.
 */
export function hasDecisionAction(item: Reader<InboxItem>): boolean {
  return item.actions.some((action) => DECISION_ACTIONS.has(action));
}

export interface InboxSections {
  /** Blocca il viewer ORA: una domanda a cui rispondere, una proposta da avviare, un lavoro da rilanciare. */
  blocksYou: Reader<InboxItem>[];
  /** Decisione riservata al maintainer che la sta guardando (piano da approvare, budget sforato). */
  onlyYouMaintainer: Reader<InboxItem>[];
  /** La stessa famiglia di decisioni, vista da chi NON la può prendere: informativa, aspetta qualcun altro. */
  waitingOthers: Reader<InboxItem>[];
  /** Tutto il resto: aggiornamenti dai progetti, niente da decidere. */
  fromProjects: Reader<InboxItem>[];
}

/**
 * Divide le righe APERTE dell'inbox nelle quattro sezioni del canvas (`1b`/
 * `1c`): "Ti blocca", "Solo tu · maintainer", "In attesa di altri", "Dai
 * progetti". Pura: nessuna chiamata di rete, nessun accesso a `Date.now()` —
 * l'ordinamento resta quello con cui `items` arriva (il server decide l'ordine
 * di lista).
 *
 * La regola, riga per riga:
 * 1. niente decisione E kind admin-gated → `waitingOthers` (es. l'operatore
 *    vede il PROPRIO piano in approvazione, ma non può approvarlo lui);
 * 2. decisione presente E kind admin-gated E il viewer è admin →
 *    `onlyYouMaintainer` (il piano è SUO da approvare/rifiutare);
 * 3. decisione presente (in ogni altro caso) → `blocksYou` (domanda,
 *    proposta del pulse, un lavoro da rilanciare: chiunque riceva la riga con
 *    quell'azione la può premere);
 * 4. il resto → `fromProjects`.
 *
 * `viewer` è per lo più ridondante con `actions` (il server non manda mai
 * `approve_plan` a un operatore), ma resta un parametro esplicito — e non
 * un'inferenza dal solo `actions` — per due ragioni: rende la regola leggibile
 * senza dover ricordare a memoria il catalogo server, e mette un fallback
 * difensivo per il caso (mai dovrebbe accadere, ma un payload di un server più
 * vecchio non è escluso) di una decisione admin-gated recapitata a chi non è
 * admin: qui degrada a `blocksYou` (si mostra, azionabile) invece che sparire.
 */
export function sectionize(items: Reader<InboxItem>[], viewer: InboxViewer): InboxSections {
  const sections: InboxSections = { blocksYou: [], onlyYouMaintainer: [], waitingOthers: [], fromProjects: [] };

  for (const item of items) {
    // Difensivo: il chiamante normalmente passa già solo le righe aperte
    // (`GET /api/inbox` senza `status` torna l'inbox aperta), ma la funzione
    // resta corretta anche su un elenco misto.
    if (item.status !== "open") continue;

    const decision = hasDecisionAction(item);
    const gated = isAdminGatedKind(item.kind);

    if (!decision && gated) {
      sections.waitingOthers.push(item);
    } else if (decision && gated && viewer.role === "admin") {
      sections.onlyYouMaintainer.push(item);
    } else if (decision) {
      sections.blocksYou.push(item);
    } else {
      sections.fromProjects.push(item);
    }
  }

  return sections;
}
