import { decrypt, docGenerations, gitAccounts, projects, type Db } from "@stubwise/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { MirrorManager, MirrorProject } from "../../git/mirrors.js";
import { openGenerationWorktree, type GenerationWorktree } from "../generation-worktree.js";

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
 * generazione è aperto, NESSUN altro job dello stesso progetto può toccare il mirror
 * (un `fetch --prune` di ensureMirror cancellerebbe il ref `stubwise/*` checked-out del
 * worktree). Il registro espone `activeProjectIds()`: il loop di dispatch NON reclama
 * un fix-job per un progetto con una generazione attiva, e l'handler di orientamento
 * NON apre una nuova generazione per un progetto che ne ha già una attiva. La politica
 * è documentata e LOGGATA nel dispatch.
 *
 * RIAPERTURA SU RIAVVIO (reopen-on-demand): il registro è in-memoria, quindi al riavvio
 * del worker tutti gli handle sono persi anche se il DAG ha nodi pendenti (li ripristina
 * `requeueStaleNodes`). Quando il dispatch reclama un nodo la cui generazione NON è
 * registrata, `ensureWorktreeDir` RI-APRE il worktree dal mirror al volo. TRADEOFF: si
 * riapre su `HEAD` del default branch, non sul `commitSha` esatto documentato dalla
 * generazione — riaprire a uno sha arbitrario richiederebbe un detached checkout fuori
 * dalle primitive di MirrorManager. In pratica è innocuo: il worktree serve all'agente
 * read-only come `cwd` per leggere il codice; al massimo legge una revisione più nuova
 * di quella seminata, mai un fallimento. Lo sha documentato resta quello scritto in
 * `doc_generations.commitSha` dalla M5a. La riapertura ri-registra l'handle, così i
 * job-nodo successivi della stessa generazione lo riusano.
 */

/** Credenziali git decifrate (mirror di orient-handler.ts). */
const credentialsSchema = z.object({
  username: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  token: z.string().min(1),
});

/** Voce del registro: l'handle del worktree + il progetto a cui appartiene. */
interface RegistryEntry {
  projectId: string;
  worktree: GenerationWorktree;
}

export interface GenerationWorktreeRegistry {
  /**
   * Registra l'handle del worktree appena aperto per `generationId` (lo fa
   * l'orientamento dopo `openGenerationWorktree`). Da quel momento il progetto è
   * "generazione attiva" (vedi activeProjectIds).
   */
  register(generationId: string, projectId: string, worktree: GenerationWorktree): void;
  /**
   * Ritorna la `dir` del worktree della generazione, riaprendolo dal mirror se non
   * registrato (reopen-on-demand dopo un riavvio del worker). Lancia se la
   * generazione/progetto non esistono più o se l'apertura fallisce.
   */
  ensureWorktreeDir(db: Db, generationId: string): Promise<string>;
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
   * Insieme dei projectId con una generazione attualmente attiva (worktree aperto).
   * Il dispatch lo usa per NON reclamare fix-job di quei progetti (mutua esclusione
   * col mirror).
   */
  activeProjectIds(): Set<string>;
}

/**
 * Crea il registro in-processo dei worktree di generazione. `mirrors` è il
 * MirrorManager condiviso (lo stesso del fix), usato per la riapertura on-demand;
 * `encryptionKey` decifra le credenziali git nella riapertura.
 */
export function createGenerationWorktreeRegistry(
  mirrors: MirrorManager,
  encryptionKey: Buffer,
): GenerationWorktreeRegistry {
  const entries = new Map<string, RegistryEntry>();

  return {
    register(generationId, projectId, worktree): void {
      entries.set(generationId, { projectId, worktree });
    },

    async ensureWorktreeDir(db, generationId): Promise<string> {
      const existing = entries.get(generationId);
      if (existing) return existing.worktree.dir;

      // Reopen-on-demand: la generazione non ha un worktree registrato (riavvio del
      // worker). Carica progetto + credenziali e RI-APRE il worktree dal mirror.
      const { projectId, mirrorProject } = await loadMirrorProjectForGeneration(
        db,
        generationId,
        encryptionKey,
      );
      const worktree = await openGenerationWorktree(mirrors, mirrorProject);
      // Doppio-check: un'altra dispatch concorrente potrebbe aver riaperto nel frattempo.
      const raced = entries.get(generationId);
      if (raced) {
        await worktree.close().catch(() => {});
        return raced.worktree.dir;
      }
      entries.set(generationId, { projectId, worktree });
      console.error(
        `[stubwise-worker] worktree della generazione ${generationId} ri-aperto on-demand (riavvio worker)`,
      );
      return worktree.dir;
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

    activeProjectIds(): Set<string> {
      const ids = new Set<string>();
      for (const entry of entries.values()) ids.add(entry.projectId);
      return ids;
    },
  };
}

/**
 * Carica progetto + account git collegato di una generazione e costruisce il
 * MirrorProject (credenziali decifrate). Usato dalla riapertura on-demand. Lancia
 * con un messaggio chiaro se la generazione/progetto non esistono o se le credenziali
 * non sono decifrabili (il chiamante lo propaga: il nodo verrà ripreso dallo stale).
 */
async function loadMirrorProjectForGeneration(
  db: Db,
  generationId: string,
  encryptionKey: Buffer,
): Promise<{ projectId: string; mirrorProject: MirrorProject }> {
  const [row] = await db
    .select({ project: projects, account: gitAccounts })
    .from(docGenerations)
    .innerJoin(projects, eq(projects.id, docGenerations.projectId))
    .innerJoin(gitAccounts, eq(gitAccounts.id, projects.gitAccountId))
    .where(eq(docGenerations.id, generationId));
  if (!row) {
    throw new Error(`generazione ${generationId} o progetto/account collegato non trovato`);
  }
  const { project, account } = row;
  const credentials = credentialsSchema.parse(
    JSON.parse(decrypt(account.encryptedCredentials, encryptionKey)),
  );
  return {
    projectId: project.id,
    mirrorProject: {
      provider: project.provider,
      repoUrl: project.repoUrl,
      defaultBranch: project.defaultBranch,
      credentials,
    },
  };
}
