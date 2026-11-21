import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSaveProductBlocks, useSessionPersonId } from "../../../data/queries";
import type { ProductBlock, ProductBlockOp, ProductPageView } from "../../../data/types";
import { applyBlockOps, isTextBlock } from "../../../domain/productDocs/blocks";
import { pushEntry, stillAsLeft, undoEntryOf, type UndoEntry, type UndoStack } from "./undo";

// La sessione dell'editor di una pagina (shape product-editor.md §3.12,
// §3.12b): le scritture in fila, una alla volta; «Saving…» → «Saved» solo
// dopo la risposta; l'errore tiene la scrittura in testa alla fila e Retry
// rimanda le STESSE operazioni (le successive restano dietro). Ogni
// scrittura è la sua: nessuna si unisce a un'altra in fila (un `merge` per
// scrittura, rimando del Task 1).
//
// ⌘Z / ⇧⌘Z ([PE 21]): la pila è di questa sessione e si riempie SOLO da
// `save()`: le scritture altrui, anche dal vivo, non ci entrano. Annullare
// manda `backward` (rifare `forward`) con `undoOf`, la revisione annullata:
// il livello dati la lascia come revisione a sé e permette di rimettere con
// lo stesso id un blocco che questa sessione ha tolto. Se un blocco da
// annullare è stato cambiato da altri dopo, il passo si salta e si toglie
// dalla pila, senza scrivere: anche quando le sue operazioni non si
// applicano più alla pagina (altri hanno tolto il blocco vicino a cui
// tornerebbe). Un rifiuto del livello dati che non cambierebbe riprovando
// (`invalid: …`) si scarta: la fila va avanti, e la barra dice «Couldn't
// save a change: the page had changed» finché non si preme un tasto; la
// modifica scartata sparisce dallo schermo (la pagina torna quella letta).
// La sessione nasce col montaggio della pagina:
// cambiare pagina o persona (lo spazio si rimonta) la svuota.
//
// Il blocco col fuoco ([PE 18], Review Focus 1, Task 11): mentre chi guarda
// ci scrive, le scritture ALTRUI su quel blocco non si vedono (`hold`): il
// suo testo e il suo cursore non cambiano. La sessione tiene due pagine: la
// vera (`blocks`, su cui ragionano ⌘Z, il salvataggio e le bozze) e quella da
// disegnare (`shown`), uguale tranne che per il blocco tenuto, che resta com'era
// finché è solo qualcun altro a cambiarlo. All'uscita il blocco torna quello
// vero; se chi guarda ci ha scritto, la sua scrittura parte all'uscita e vale
// per ultima, e la cronologia tiene entrambe le versioni.

export type SaveState = "idle" | "saving" | "saved" | "error";

interface Batch {
  ops: ProductBlockOp[];
  /**
   * La revisione della base su cui le operazioni sono calcolate, presa
   * all'ingresso in fila (build app): una revisione altrui riletta nel
   * frattempo non la sposta, e il server dice `stale` (revisione di R11-4, 2).
   */
  baseSeq?: number;
  /** La revisione che la scrittura annulla (letta all'invio: la scrittura annullata è già tornata). */
  undoOf?: () => string | undefined;
  onDone?: (revisionId: string | null) => void;
}

/** Le operazioni sopra la pagina, una alla volta; quelle che non valgono più (un blocco tolto da altri) si saltano. */
export function rebase(blocks: readonly ProductBlock[], ops: readonly ProductBlockOp[]): ProductBlock[] {
  let list = [...blocks];
  for (const op of ops) {
    try {
      list = applyBlockOps(list, [op]).blocks;
    } catch {
      // Già nella pagina (una scrittura confermata) o non più possibile: niente.
    }
  }
  return list;
}

/** Le operazioni si applicano ancora alla pagina (prova a secco). */
function applies(blocks: readonly ProductBlock[], ops: readonly ProductBlockOp[]): boolean {
  try {
    applyBlockOps(blocks, ops);
    return true;
  } catch {
    return false;
  }
}

/** Le operazioni toccano il blocco `id`. */
function touches(ops: readonly ProductBlockOp[], id: string): boolean {
  return ops.some((op) => {
    switch (op.op) {
      case "set":
      case "insert":
        return op.block.id === id;
      case "delete":
      case "move":
        return op.blockId === id;
      case "merge":
        return op.firstId === id || op.secondId === id;
    }
  });
}

/**
 * Un rifiuto che riprovando non cambierebbe, e il suo perché: l'input non vale
 * per la pagina (`invalid: …`, anche `invalid: stale`), chi scrive non può più
 * (`forbidden`), la pagina non c'è più (`not_found`) — I4 della revisione di
 * R11-1 —, la sezione la tiene un altro che ci sta scrivendo (`section_busy`,
 * F4: `by` è il nome, se chi guarda lo vede). Ogni altro errore (rete,
 * server) si riprova con Retry.
 */
export type DropReason = "changed" | "forbidden" | "gone" | "busy";

/**
 * «Mostra le due versioni» (21 nov 2026, maintainer; shape product-editor.md,
 * emendamento omonimo): la versione propria di un blocco di testo che una
 * scrittura scartata cambiava. `afterId` = il blocco che lo precedeva, dove
 * rimetterlo se un altro l'ha tolto (`null`: in cima).
 */
export interface OwnVersion {
  blockId: string;
  own: ProductBlock;
  afterId: string | null;
}

/**
 * Le versioni proprie di una scrittura scartata: i blocchi di testo che
 * scriveva. Solo una scrittura di testo (tutta `set`, le bozze dei blocchi):
 * un gesto di struttura (dividere è un `set` più un `insert`, unire, spostare,
 * togliere) non ha una versione da mostrare.
 */
function ownVersionsOf(ops: readonly ProductBlockOp[], view: readonly ProductBlock[]): OwnVersion[] {
  if (ops.some((op) => op.op !== "set")) return [];
  const out: OwnVersion[] = [];
  for (const op of ops) {
    if (op.op !== "set" || !isTextBlock(op.block)) continue;
    const i = view.findIndex((b) => b.id === op.block.id);
    out.push({ blockId: op.block.id, own: op.block, afterId: i > 0 ? view[i - 1]!.id : null });
  }
  return out;
}
const rejected = (error: unknown): DropReason | null => {
  if (!(error instanceof Error)) return null;
  if (error.message === "section_busy") return "busy";
  if (error.message.startsWith("invalid:")) return "changed";
  if (error.message === "forbidden") return "forbidden";
  if (error.message === "not_found") return "gone";
  return null;
};

export function useEditorSession(page: ProductPageView) {
  const [sessionId] = useState(() => `ses-${crypto.randomUUID()}`);
  const me = useSessionPersonId();
  const client = useQueryClient();
  const write = useSaveProductBlocks();
  const writeRef = useRef(write.mutateAsync);
  writeRef.current = write.mutateAsync;

  // La pagina come l'ha vista l'ultima risposta (o l'ultima lettura): una
  // scrittura confermata la aggiorna nello stesso giro in cui esce dalla
  // fila, così il testo non torna indietro per un attimo.
  const [base, setBase] = useState(page.blocks);
  const baseRef = useRef(base);
  baseRef.current = base;

  // Il blocco tenuto ([PE 18]) e la pagina da disegnare: la pagina vera col
  // blocco tenuto com'era disegnato (se c'è ancora). Si DERIVA a ogni disegno
  // invece di tenerne una copia (11b, Task 12): una copia scritta da due
  // parti — il gesto che lascia il blocco e la lettura nuova arrivata nello
  // stesso giro, come la bozza di Claude al posto del paragrafo — poteva
  // tornare alla pagina di prima sopra quella nuova.
  const heldRef = useRef<string | null>(null);
  const [heldBlock, setHeldBlock] = useState<ProductBlock | null>(null);
  const shown = useMemo(
    () => (heldBlock ? base.map((b) => (b.id === heldBlock.id ? heldBlock : b)) : base),
    [base, heldBlock],
  );

  const [seen, setSeen] = useState(page.blocks);
  /** La revisione della base (`page.seq` nella build app; il prototipo non la dà). */
  const seqRef = useRef(page.seq);
  if (seen !== page.blocks) {
    setSeen(page.blocks);
    setBase(page.blocks);
    baseRef.current = page.blocks;
    seqRef.current = page.seq;
  }

  const queue = useRef<Batch[]>([]);
  const [pending, setPending] = useState<ProductBlockOp[][]>([]);
  const busy = useRef(false);
  const failed = useRef(false);
  const [state, setState] = useState<SaveState>("idle");
  const [skipped, setSkipped] = useState(false);
  /** L'ultima scrittura rifiutata dal livello dati e scartata. */
  const [dropped, setDropped] = useState<DropReason | false>(false);
  /** Chi tiene la sezione di una scrittura scartata per `section_busy` (`null`: non si vede). */
  const [droppedBy, setDroppedBy] = useState<string | null>(null);
  /** Le versioni proprie non salvate, una per blocco, finché non si riprendono o si scartano. */
  const [owns, setOwnsState] = useState<OwnVersion[]>([]);
  // Letto all'uscita dalla pagina (`unsaved`), dopo un'attesa: non quello dell'ultimo disegno.
  const ownsRef = useRef<OwnVersion[]>([]);
  const setOwns = useCallback((next: (old: OwnVersion[]) => OwnVersion[]) => {
    ownsRef.current = next(ownsRef.current);
    setOwnsState(ownsRef.current);
  }, []);
  /** L'ultimo scarto ha lasciato una versione da riprendere (la barra dice dove guardare). */
  const [droppedKept, setDroppedKept] = useState(false);
  /** Tiene le versioni proprie: una nuova sullo stesso blocco sostituisce la vecchia. */
  const keepOwn = useCallback((versions: readonly OwnVersion[]) => {
    if (versions.length === 0) return false;
    const ids = new Set(versions.map((v) => v.blockId));
    setOwns((old) => [...old.filter((o) => !ids.has(o.blockId)), ...versions]);
    return true;
  }, [setOwns]);
  const stackRef = useRef<UndoStack>({ undo: [], redo: [] });
  const [stack, setStackState] = useState<UndoStack>(stackRef.current);
  const setStack = (next: UndoStack) => {
    stackRef.current = next;
    setStackState(next);
  };
  const revisions = useRef(new WeakMap<UndoEntry, { done?: string | null; undone?: string | null }>());
  const pageRef = useRef({ id: page.id, code: page.code });

  /** La pagina con le scritture di questa sessione non ancora confermate. */
  const current = () => rebase(baseRef.current, queue.current.flatMap((b) => b.ops));
  const view = useMemo(() => rebase(base, pending.flat()), [base, pending]);
  const shownView = useMemo(() => rebase(shown, pending.flat()), [shown, pending]);

  // Chi aspetta che la fila sia vuota (11b, Task 12): un gesto di Claude
  // sulla pagina (la bozza di schermata) scrive fuori dalla fila e non deve
  // arrivare prima di una scrittura di questa sessione ancora in volo. Una
  // fila ferma su un errore li libera lo stesso: il gesto prova, e il
  // livello dati dice se la pagina gli va ancora bene.
  const waiters = useRef<(() => void)[]>([]);
  const release = useCallback(() => {
    const list = waiters.current;
    waiters.current = [];
    for (const done of list) done();
  }, []);
  const settled = useCallback(
    (): Promise<void> =>
      (queue.current.length === 0 && !busy.current) || failed.current
        ? Promise.resolve()
        : new Promise<void>((done) => {
            waiters.current.push(done);
          }),
    [],
  );

  const pump = useCallback(async () => {
    if (busy.current || failed.current) return;
    const batch = queue.current[0];
    if (!batch) {
      release();
      return;
    }
    busy.current = true;
    setState("saving");
    try {
      const result = await writeRef.current({
        pageId: pageRef.current.id,
        ops: batch.ops,
        sessionId,
        undoOf: batch.undoOf?.(),
        ...(batch.baseSeq !== undefined ? { baseSeq: batch.baseSeq } : {}),
      });
      client.setQueryData(
        ["as", me, "productDocs", "page", pageRef.current.code],
        (old: ProductPageView | null | undefined) =>
          old ? { ...old, blocks: result.blocks, updatedAt: result.updatedAt, updatedById: result.updatedById } : old,
      );
      baseRef.current = result.blocks;
      setBase(result.blocks);
      // La base delle scritture ancora in fila NON si sposta: le revisioni di
      // questa sessione il server le dà nello `stale` e l'adapter non le conta
      // come conflitto; una revisione altrui in mezzo sì.
      // Una scrittura di questa sessione sul blocco tenuto si vede; le altre lo lasciano com'era.
      const held = heldRef.current;
      if (held && touches(batch.ops, held)) setHeldBlock(result.blocks.find((b) => b.id === held) ?? null);
      queue.current.shift();
      setPending(queue.current.map((b) => b.ops));
      batch.onDone?.(result.revisionId);
      busy.current = false;
      if (queue.current.length > 0) void pump();
      else {
        setState("saved");
        release();
      }
    } catch (error) {
      busy.current = false;
      const reason = rejected(error);
      if (reason) {
        // Riprovare darebbe lo stesso rifiuto: la scrittura esce dalla fila.
        // Il testo che cambiava resta da riprendere (pagina cambiata, sezione presa).
        const kept =
          (reason === "changed" || reason === "busy") && keepOwn(ownVersionsOf(batch.ops, current()));
        setDroppedKept(kept);
        queue.current.shift();
        setPending(queue.current.map((b) => b.ops));
        setDropped(reason);
        const by = (error as { by?: unknown }).by;
        setDroppedBy(reason === "busy" && typeof by === "string" ? by : null);
        if (queue.current.length > 0) void pump();
        else {
          setState("idle");
          release();
        }
        return;
      }
      failed.current = true;
      setState("error");
      release();
    }
  }, [client, me, sessionId, release, keepOwn]);

  const enqueue = useCallback(
    (batch: Batch) => {
      queue.current.push(seqRef.current === undefined ? batch : { ...batch, baseSeq: seqRef.current });
      setPending(queue.current.map((b) => b.ops));
      void pump();
    },
    [pump],
  );

  /** Salva una scrittura della sessione (in fila) e ne fa una voce di ⌘Z. */
  const save = (ops: ProductBlockOp[]) => {
    if (ops.length === 0) return;
    setSkipped(false);
    setDropped(false);
    setDroppedKept(false);
    let entry: UndoEntry | null = null;
    try {
      entry = undoEntryOf(current(), ops);
    } catch {
      entry = null;
    }
    if (entry) setStack(pushEntry(stackRef.current, entry));
    const own = entry;
    enqueue({
      ops,
      onDone: (rid) => {
        if (own) revisions.current.set(own, { ...revisions.current.get(own), done: rid });
      },
    });
  };

  const undo = () => {
    const { undo: list, redo } = stackRef.current;
    const entry = list.at(-1);
    setSkipped(false);
    if (!entry) return;
    if (!stillAsLeft(current(), entry.after) || !applies(current(), entry.backward)) {
      setStack({ undo: list.slice(0, -1), redo });
      setSkipped(true);
      return;
    }
    setStack({ undo: list.slice(0, -1), redo: [...redo, entry] });
    enqueue({
      ops: entry.backward,
      undoOf: () => revisions.current.get(entry)?.done ?? undefined,
      onDone: (rid) => revisions.current.set(entry, { ...revisions.current.get(entry), undone: rid }),
    });
  };

  const redo = () => {
    const { undo: list, redo: again } = stackRef.current;
    const entry = again.at(-1);
    setSkipped(false);
    if (!entry) return;
    if (!stillAsLeft(current(), entry.before) || !applies(current(), entry.forward)) {
      setStack({ undo: list, redo: again.slice(0, -1) });
      setSkipped(true);
      return;
    }
    setStack({ undo: [...list, entry], redo: again.slice(0, -1) });
    enqueue({
      ops: entry.forward,
      undoOf: () => revisions.current.get(entry)?.undone ?? undefined,
      onDone: (rid) => revisions.current.set(entry, { ...revisions.current.get(entry), done: rid }),
    });
  };

  /** Rimanda la scrittura che non è riuscita, la stessa. */
  const retry = useCallback(() => {
    if (!failed.current) return;
    failed.current = false;
    void pump();
  }, [pump]);

  /**
   * Il blocco col fuoco di chi guarda (`null` = nessuno): le scritture altrui
   * su di lui si vedono solo quando lo si lascia. Cambiare blocco rilascia il
   * precedente (torna quello vero) e tiene il nuovo da com'è adesso.
   */
  const hold = useCallback((id: string | null) => {
    if (heldRef.current === id) return;
    heldRef.current = id;
    setHeldBlock(id ? (baseRef.current.find((b) => b.id === id) ?? null) : null);
  }, []);

  /** Un tasto: «Saved» resta solo fino al tasto dopo, e così il passo saltato. */
  const touch = () => {
    setSkipped(false);
    setDropped(false);
    setDroppedKept(false);
    setState((s) => (s === "saved" ? "idle" : s));
  };

  // La pagina cambia identità solo rimontando: la sessione resta della sua pagina.
  useEffect(() => {
    pageRef.current = { id: page.id, code: page.code };
  }, [page.id, page.code]);

  return {
    sessionId,
    save,
    state,
    retry,
    undo,
    redo,
    canUndo: stack.undo.length > 0,
    canRedo: stack.redo.length > 0,
    skipped,
    dropped,
    droppedBy,
    droppedKept,
    /** Le versioni proprie non salvate (shape, «Mostra le due versioni»). */
    owns,
    /** Una bozza che non ha più dove andare (il blocco tolto da altri): resta da riprendere. */
    keepUnsaved: (versions: readonly OwnVersion[]) => {
      if (!keepOwn(versions)) return;
      setDropped("changed");
      setDroppedBy(null);
      setDroppedKept(true);
    },
    /** La versione propria ripresa o scartata. */
    resolveOwn: (blockId: string) => setOwns((old) => old.filter((o) => o.blockId !== blockId)),
    touch,
    /** La pagina con le scritture in fila: quella vera, su cui si ragiona. */
    blocks: view,
    /** La pagina da disegnare: come `blocks`, ma il blocco tenuto non cambia per mano d'altri ([PE 18]). */
    shown: shownView,
    hold,
    /** Si risolve quando la fila è vuota (o ferma su un errore): un gesto fuori dalla fila arriva dopo. */
    settled,
    /** Ci sono scritture non ancora confermate. */
    dirty: pending.length > 0,
    /**
     * Qualcosa non è salvato, adesso (product-editor.md §3.12, uscire dalla
     * pagina): una scrittura in fila o ferma su un errore, o una versione
     * propria che la pagina non ha già (come i riquadri dell'editor).
     */
    unsaved: () => {
      if (queue.current.length > 0) return true;
      const page = current();
      return ownsRef.current.some((o) => {
        const now = page.find((b) => b.id === o.blockId);
        return !now || JSON.stringify(now) !== JSON.stringify(o.own);
      });
    },
  };
}

export type EditorSession = ReturnType<typeof useEditorSession>;
