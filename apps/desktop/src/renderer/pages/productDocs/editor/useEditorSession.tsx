import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSaveProductBlocks, useSessionPersonId } from "../../../data/queries";
import type { ProductBlock, ProductBlockOp, ProductPageView } from "../../../data/types";
import { applyBlockOps } from "../../../domain/productDocs/blocks";
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

/** Un rifiuto che riprovando non cambierebbe: l'input non vale per la pagina (`invalid: …`). */
const rejected = (error: unknown): boolean => error instanceof Error && error.message.startsWith("invalid:");

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

  // Il blocco tenuto ([PE 18]) e la pagina da disegnare.
  const heldRef = useRef<string | null>(null);
  const [shown, setShownState] = useState(page.blocks);
  const shownRef = useRef(shown);
  const setShown = (next: ProductBlock[]) => {
    shownRef.current = next;
    setShownState(next);
  };
  /** `incoming` con il blocco tenuto com'era disegnato (se c'è ancora in entrambe). */
  const keepHeld = (incoming: ProductBlock[]): ProductBlock[] => {
    const id = heldRef.current;
    const mine = id ? shownRef.current.find((b) => b.id === id) : undefined;
    if (!mine) return incoming;
    return incoming.map((b) => (b.id === id ? mine : b));
  };

  const [seen, setSeen] = useState(page.blocks);
  if (seen !== page.blocks) {
    setSeen(page.blocks);
    setBase(page.blocks);
    baseRef.current = page.blocks;
    setShown(keepHeld(page.blocks));
  }

  const queue = useRef<Batch[]>([]);
  const [pending, setPending] = useState<ProductBlockOp[][]>([]);
  const busy = useRef(false);
  const failed = useRef(false);
  const [state, setState] = useState<SaveState>("idle");
  const [skipped, setSkipped] = useState(false);
  /** L'ultima scrittura rifiutata dal livello dati e scartata. */
  const [dropped, setDropped] = useState(false);
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

  const pump = useCallback(async () => {
    if (busy.current || failed.current) return;
    const batch = queue.current[0];
    if (!batch) return;
    busy.current = true;
    setState("saving");
    try {
      const result = await writeRef.current({
        pageId: pageRef.current.id,
        ops: batch.ops,
        sessionId,
        undoOf: batch.undoOf?.(),
      });
      client.setQueryData(
        ["as", me, "productDocs", "page", pageRef.current.code],
        (old: ProductPageView | null | undefined) =>
          old ? { ...old, blocks: result.blocks, updatedAt: result.updatedAt, updatedById: result.updatedById } : old,
      );
      baseRef.current = result.blocks;
      setBase(result.blocks);
      // Una scrittura di questa sessione sul blocco tenuto si vede; le altre lo lasciano com'era.
      const held = heldRef.current;
      setShown(held && touches(batch.ops, held) ? result.blocks : keepHeld(result.blocks));
      queue.current.shift();
      setPending(queue.current.map((b) => b.ops));
      batch.onDone?.(result.revisionId);
      busy.current = false;
      if (queue.current.length > 0) void pump();
      else setState("saved");
    } catch (error) {
      busy.current = false;
      if (rejected(error)) {
        // Riprovare darebbe lo stesso rifiuto: la scrittura esce dalla fila.
        queue.current.shift();
        setPending(queue.current.map((b) => b.ops));
        setDropped(true);
        if (queue.current.length > 0) void pump();
        else setState("idle");
        return;
      }
      failed.current = true;
      setState("error");
    }
  }, [client, me, sessionId]);

  const enqueue = useCallback(
    (batch: Batch) => {
      queue.current.push(batch);
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
    shownRef.current = baseRef.current;
    setShownState(baseRef.current);
  }, []);

  /** Un tasto: «Saved» resta solo fino al tasto dopo, e così il passo saltato. */
  const touch = () => {
    setSkipped(false);
    setDropped(false);
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
    touch,
    /** La pagina con le scritture in fila: quella vera, su cui si ragiona. */
    blocks: view,
    /** La pagina da disegnare: come `blocks`, ma il blocco tenuto non cambia per mano d'altri ([PE 18]). */
    shown: shownView,
    hold,
    /** Ci sono scritture non ancora confermate. */
    dirty: pending.length > 0,
  };
}

export type EditorSession = ReturnType<typeof useEditorSession>;
