import { type GenerationWorktree } from "../generation-worktree.js";

/**
 * REGISTRO IN-PROCESSO dei worktree di generazione del DAG (M7).
 *
 * Il motore documentazione ricorsivo tiene UN worktree git vivo per l'intera durata
 * di una generazione (vedi generation-worktree.ts): l'orientamento lo apre, i job-nodo
 * (explore/synthesize) lo riusano in sola lettura, la finalizzazione lo chiude. Il
 * worktree è aperto con un path `mkdtemp` random NON persistito: l'unico modo per i
 * job-nodo di ottenerne la `dir` è un handle tenuto IN MEMORIA. Questo registro è quel
 * contenitore: una `Map generationId → GenerationWorktree`, valida perché il worker è
 * un SINGOLO processo (la stessa assunzione di deployment di MirrorManager e del
 * serializzatore per-progetto).
 *
 * MUTUA ESCLUSIONE FIX↔GENERAZIONE (invariante del mirror): finché il worktree di una
 * generazione è aperto, NESSUN altro job dello stesso REPOSITORY può toccare il mirror
 * (un `fetch --prune` di ensureMirror cancellerebbe il ref `stubwise/*` checked-out del
 * worktree). Il mirror è del repository, quindi la guardia mirror è per repositoryId.
 * In Fase 3 il fix è PER-PROGETTO (apre un worktree su TUTTI i repo del progetto), quindi
 * il registro traccia anche il `projectId` di ogni generazione ed espone
 * `activeProjectIds()`: il claim dei fix esclude i PROGETTI con una generazione attiva su
 * un loro repo (un fix di progetto e quella generazione condividerebbero il mirror di quel
 * repo). Continua a esporre `activeRepositoryIds()` per la guardia nuova-generazione
 * (niente due generazioni sullo stesso repo). La politica è documentata e LOGGATA nel
 * dispatch.
 *
 * RIAVVIO DEL WORKER (fail-on-restart, issue M2): il registro è in-memoria, quindi al
 * riavvio del worker TUTTI gli handle sono persi. I nodi pendenti sopravvivono nel DB
 * (`requeueStaleNodes` li rende di nuovo claimabili), ma il worktree CONDIVISO aperto
 * dall'orientamento su un commit preciso non c'è più. NON lo riapriamo on-demand: farlo
 * a HEAD rischierebbe documentazione a commit MISTI (parte dei nodi sul vecchio sha,
 * parte sul nuovo). Il dispatch (vedi node-dispatch.ts), quando reclama un nodo la cui
 * generazione NON è registrata (`getWorktreeDir` → null), FALLISCE la generazione
 * (`failGenerationOnRestart`): generazione + nodi non-done + trigger → `failed`. L'utente
 * ri-triggera. Per questo il registro espone solo un getter SINCRONO (`getWorktreeDir`),
 * senza alcuna riapertura dal mirror.
 */

/** Voce del registro: l'handle del worktree + il repository e il progetto cui appartiene. */
interface RegistryEntry {
  repositoryId: string;
  projectId: string;
  worktree: GenerationWorktree;
}

export interface GenerationWorktreeRegistry {
  /**
   * Registra l'handle del worktree appena aperto per `generationId` (lo fa
   * l'orientamento dopo `openGenerationWorktree`). Da quel momento il repository è
   * "generazione attiva" (vedi activeRepositoryIds) e il suo progetto è escluso dai fix
   * (vedi activeProjectIds).
   */
  register(
    generationId: string,
    repositoryId: string,
    projectId: string,
    worktree: GenerationWorktree,
  ): void;
  /**
   * Ritorna la `dir` del worktree REGISTRATO della generazione, oppure `null` se non
   * c'è (riavvio del worker → handle perso). NON riapre nulla: il chiamante (dispatch)
   * tratta `null` come "worktree perso al riavvio" e fa fallire la generazione (vedi
   * failGenerationOnRestart). Sincrono: nessun I/O.
   */
  getWorktreeDir(generationId: string): string | null;
  /** true se per `generationId` esiste un handle registrato (worktree vivo in-process). */
  has(generationId: string): boolean;
  /**
   * GATE EXACTLY-ONCE della finalizzazione: rimuove SINCRONAMENTE l'handle del
   * worktree dal registro e lo ritorna, oppure `null` se non c'era (già rimosso). È il
   * compare-and-swap in-process che garantisce UNA SOLA finalizzazione anche se due
   * nodi-radice si chiudono quasi-contemporaneamente: solo il chiamante che ottiene
   * l'handle (≠ null) procede con la finalizzazione + il close; gli altri ottengono
   * `null` e si fermano. La rimozione è sincrona (niente await tra get e delete) →
   * race-safe nel modello a singolo event-loop di Node. Il chiamante è poi
   * responsabile di chiudere l'handle ritornato.
   */
  claimForFinalize(generationId: string): GenerationWorktree | null;
  /**
   * Insieme dei repositoryId con una generazione attualmente attiva (worktree aperto).
   * Usato dalla guardia nuova-generazione (niente due generazioni sullo stesso repo).
   */
  activeRepositoryIds(): Set<string>;
  /**
   * Insieme dei projectId con una generazione attualmente attiva su un loro repo. Il
   * claim dei fix lo usa per NON reclamare fix-job di quei progetti (mutua esclusione col
   * mirror, per-progetto: un fix di progetto aprirebbe un worktree su TUTTI i repo del
   * progetto, incluso quello con la generazione attiva).
   */
  activeProjectIds(): Set<string>;
}

/**
 * Crea il registro in-processo dei worktree di generazione. Dopo l'eliminazione della
 * riapertura on-demand (fail-on-restart, issue M2) il registro è un puro contenitore
 * in-memoria senza I/O: non richiede più MirrorManager né la chiave di cifratura.
 */
export function createGenerationWorktreeRegistry(): GenerationWorktreeRegistry {
  const entries = new Map<string, RegistryEntry>();

  return {
    register(generationId, repositoryId, projectId, worktree): void {
      entries.set(generationId, { repositoryId, projectId, worktree });
    },

    getWorktreeDir(generationId): string | null {
      return entries.get(generationId)?.worktree.dir ?? null;
    },

    has(generationId): boolean {
      return entries.has(generationId);
    },

    claimForFinalize(generationId): GenerationWorktree | null {
      const entry = entries.get(generationId);
      if (!entry) return null;
      entries.delete(generationId);
      return entry.worktree;
    },

    activeRepositoryIds(): Set<string> {
      const ids = new Set<string>();
      for (const entry of entries.values()) ids.add(entry.repositoryId);
      return ids;
    },

    activeProjectIds(): Set<string> {
      const ids = new Set<string>();
      for (const entry of entries.values()) ids.add(entry.projectId);
      return ids;
    },
  };
}
