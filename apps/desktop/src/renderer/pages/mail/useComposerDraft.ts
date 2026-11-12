import { useEffect, useRef, useState } from "react";
import {
  saveMailDraftNow,
  useLoadMailDraft,
  useSaveMailDraft,
  useSessionPersonId,
} from "../../data/queries";
import { getSessionPersonId, onBeforePersonaChange } from "../../data/session";
import type { MailAddress, MailDraft, MailDraftAttachment } from "../../data/types";
import {
  holdUnsavedDraft,
  registerComposer,
  takeUnsavedDraft,
  type UnsavedDraft,
} from "./composeRequest";

// La vita della bozza di una casella di scrittura (shape mail-compose §5):
// letta all'apertura, salvata da sé 800 ms dopo l'ultima modifica, chiudendo,
// cambiando conversazione e PRIMA di cambiare persona (a nome di chi
// scriveva: dopo il cambio non salva più nulla). Aprire senza scrivere non
// crea una bozza. Passare a un'altra modalità salva il corpo e rifà
// destinatari e oggetto [A 1].
//
// Build app: la bozza di un invio annullato può tornare NON salvata (nello
// stesso slot c'è già un'altra bozza). Allora la casella la mostra ma non la
// salva da sé — né scrivendo, né chiudendo, né cambiando persona: salvarla
// sostituirebbe l'altra. Decide chi scrive, «Save» (sopra l'altra) o
// «Discard»; nel frattempo la copia resta fra le bozze di Gmail.

/** Quanto si aspetta dopo l'ultima modifica per salvare la bozza. */
export const DRAFT_SAVE_MS = 800;

type Mode = MailDraft["mode"];

export interface ComposerFields {
  id: string;
  replyToMessageId: string | null;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  body: string;
  attachments: MailDraftAttachment[];
  quote: boolean;
  /** Build app: la firma di Gmail (sola lettura: la aggiunge il server all'invio, non si salva). */
  signature?: string | null;
  signatureStatus?: MailDraft["signatureStatus"];
}

const fieldsOf = (d: MailDraft): ComposerFields => ({
  id: d.id,
  replyToMessageId: d.replyToMessageId,
  to: d.to,
  cc: d.cc,
  subject: d.subject,
  body: d.body,
  attachments: d.attachments,
  quote: d.quote !== false,
  signature: d.signature ?? null,
  ...(d.signatureStatus ? { signatureStatus: d.signatureStatus } : {}),
});

export function useComposerDraft({
  threadId,
  mode,
  slot,
  onClose,
  onLoaded,
  onEdit,
}: {
  threadId: string | null;
  mode: Mode;
  /** Un'email nuova nel suo slot (la bozza di «Scrivigli anche per email», R-K14). */
  slot?: string;
  /** Chiusa (Esc, «Close», `closeComposer` da fuori): la bozza è in salvataggio. */
  onClose: () => void;
  /** La bozza letta (all'apertura o con un'altra modalità). */
  onLoaded: (fields: ComposerFields) => void;
  /** Una modifica di chi scrive. */
  onEdit: () => void;
}) {
  const owner = useSessionPersonId();
  const load = useLoadMailDraft();
  const saveMutation = useSaveMailDraft();
  const [fields, setFieldsState] = useState<ComposerFields | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // `conflict`: la bozza è cambiata su Gmail nel frattempo (build app): non vince l'ultimo.
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed" | "conflict">("idle");
  /** La bozza tornata non salvata, finché chi scrive non la salva o la scarta. */
  const [unsaved, setUnsaved] = useState<UnsavedDraft | null>(null);
  const unsavedRef = useRef<UnsavedDraft | null>(null);

  const fieldsRef = useRef<ComposerFields | null>(null);
  const modeRef = useRef(mode);
  const dirty = useRef(false);
  const timer = useRef<number | null>(null);
  const gone = useRef(false);
  /** Salvataggi partiti e non ancora finiti. */
  const inFlight = useRef(0);
  /** L'ultimo salvataggio partito, e se è fallito (decide lui lo stato). */
  const issued = useRef(0);
  const newestFailed = useRef(false);
  const callbacks = useRef({ onClose, onLoaded, onEdit });
  callbacks.current = { onClose, onLoaded, onEdit };

  const inputOf = (f: ComposerFields, m: Mode) => ({
    threadId,
    mode: m,
    replyToMessageId: f.replyToMessageId,
    to: f.to,
    cc: f.cc,
    subject: f.subject,
    body: f.body,
    attachments: f.attachments,
    ...(f.quote ? {} : { quote: false }),
    ...(slot ? { slot } : {}),
  });

  const clearTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  /** Salva ora, se c'è qualcosa da salvare. */
  const saveNow = async () => {
    clearTimer();
    const f = fieldsRef.current;
    if (!f || !dirty.current || gone.current || unsavedRef.current) return;
    dirty.current = false;
    setStatus("saving");
    inFlight.current += 1;
    const mine = ++issued.current;
    newestFailed.current = false;
    // «Salvato» solo se nel frattempo non si è scritto altro (il timer già
    // programmato salva il testo nuovo), nessun altro salvataggio è in volo
    // (si possono sovrapporre, e quello più vecchio vedrebbe `dirty` già
    // azzerato da quello più nuovo) e il più recente non è fallito.
    const settle = () => {
      if (inFlight.current === 0 && !newestFailed.current) setStatus(dirty.current ? "idle" : "saved");
    };
    try {
      await saveMutation.mutateAsync(inputOf(f, modeRef.current));
      inFlight.current -= 1;
      settle();
    } catch (error) {
      inFlight.current -= 1;
      // Un salvataggio più vecchio che fallisce non conta: uno più nuovo ha
      // portato (o sta portando) il testo più recente, e decide lui.
      if (mine !== issued.current) return settle();
      newestFailed.current = true;
      dirty.current = true;
      // Cambiata su Gmail: non si risalva da soli (darebbe di nuovo lo stesso
      // errore); decide chi scrive, «Tieni la mia» o «Apri su Gmail».
      if (error instanceof Error && error.message === "draft_changed") {
        clearTimer();
        setStatus("conflict");
        return;
      }
      setStatus("failed");
    }
  };
  const saveRef = useRef(saveNow);
  saveRef.current = saveNow;

  /**
   * Una bozza non salvata lasciata senza decidere torna in attesa coi campi
   * di adesso, a nome di chi la scriveva (`owner`): la ritrova riaprendo.
   */
  const stashUnsaved = (personId: string = owner) => {
    const held = unsavedRef.current;
    const f = fieldsRef.current;
    if (!held || !f || gone.current) return;
    holdUnsavedDraft(
      {
        draft: {
          ...held.draft,
          mode: modeRef.current,
          replyToMessageId: f.replyToMessageId,
          to: f.to,
          cc: f.cc,
          subject: f.subject,
          body: f.body,
          attachments: f.attachments,
          ...(f.quote ? {} : { quote: false }),
        },
        leftInGmail: held.leftInGmail,
      },
      personId,
    );
  };
  const stashRef = useRef(stashUnsaved);
  stashRef.current = stashUnsaved;

  /** Chiude salvando; la promessa si risolve a bozza salvata. */
  const closeNow = () => {
    stashRef.current();
    const saved = saveRef.current();
    gone.current = true;
    callbacks.current.onClose();
    return saved;
  };
  const closeRef = useRef(closeNow);
  closeRef.current = closeNow;
  // Chi rimette una bozza («Undo», «Edit») chiude prima questa casella.
  useEffect(() => registerComposer(threadId, () => closeRef.current(), slot), [threadId, slot]);

  /**
   * `byClaude`: il testo l'ha messo Claude (bozza dal pulsante o dal
   * riquadro). Resta una PROPOSTA *(O, review F3)*: non rende la bozza da
   * salvare finché la persona non lo tocca o non preme «Send».
   */
  const setFields = (patch: Partial<ComposerFields>, { byClaude = false }: { byClaude?: boolean } = {}) => {
    const next = { ...fieldsRef.current!, ...patch };
    fieldsRef.current = next;
    setFieldsState(next);
    callbacks.current.onEdit();
    if (byClaude) {
      clearTimer();
      setStatus("idle");
      return;
    }
    dirty.current = true;
    if (unsavedRef.current) return;
    // Nessuna etichetta finché la modifica non è salvata (scelta del
    // costruttore, area 8): «Salvato» sopra un testo nuovo mentirebbe.
    setStatus("idle");
    clearTimer();
    timer.current = window.setTimeout(() => void saveRef.current(), DRAFT_SAVE_MS);
  };

  const loaded = (f: ComposerFields) => {
    fieldsRef.current = f;
    setFieldsState(f);
    callbacks.current.onLoaded(f);
  };

  // All'apertura: la bozza salvata (o una nuova, già indirizzata). Una volta
  // per casella: la modalità cambia sotto (effetto qui sotto).
  useEffect(() => {
    // Presa una volta (il ref regge il doppio effetto di StrictMode).
    if (unsavedRef.current) return;
    const held = takeUnsavedDraft(owner, threadId, slot);
    if (held) {
      unsavedRef.current = held;
      setUnsaved(held);
      dirty.current = true;
      loaded(fieldsOf(held.draft));
      return;
    }
    let live = true;
    load(threadId, modeRef.current, slot).then(
      (draft) => live && loaded(fieldsOf(draft)),
      () => live && setLoadFailed(true),
    );
    return () => {
      live = false;
    };
  }, []);

  // Un'altra modalità [A 1]: si salva il corpo, poi destinatari e oggetto rifatti.
  useEffect(() => {
    if (modeRef.current === mode || !fieldsRef.current) {
      modeRef.current = mode;
      return;
    }
    const previous = modeRef.current;
    let live = true;
    void (async () => {
      const f = fieldsRef.current!;
      const hasContent = f.body.trim() !== "" || f.attachments.length > 0;
      if (dirty.current || hasContent) {
        dirty.current = true;
        modeRef.current = previous;
        await saveRef.current();
      }
      modeRef.current = mode;
      try {
        const draft = await load(threadId, mode);
        if (!live) return;
        loaded({ ...fieldsOf(draft), body: fieldsRef.current!.body });
        if (hasContent) {
          dirty.current = true;
          void saveRef.current();
        }
      } catch {
        if (live) setLoadFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [mode, threadId, load]);

  // Cambio di persona: la bozza si salva ORA, a nome di chi la scriveva
  // (`saveMailDraftNow` legge la sessione subito); poi più nulla (la pagina
  // si rimonta per la persona nuova).
  useEffect(
    () =>
      onBeforePersonaChange(() => {
        clearTimer();
        const f = fieldsRef.current;
        if (f && dirty.current && !gone.current && !unsavedRef.current) void saveMailDraftNow(inputOf(f, modeRef.current));
        stashRef.current();
        gone.current = true;
      }),
    [],
  );
  // Chiusa o un'altra conversazione: salva, se la persona è ancora quella.
  useEffect(
    () => () => {
      clearTimer();
      // Smontata senza decidere (un'altra conversazione): la non salvata torna in attesa.
      stashRef.current();
      if (gone.current || getSessionPersonId() !== owner) return;
      void saveRef.current();
    },
    [owner],
  );

  return {
    owner,
    fields,
    loadFailed,
    status,
    unsaved,
    setFields,
    /** I campi più recenti (anche fra due render). */
    current: () => fieldsRef.current,
    mode: () => modeRef.current,
    saveNow: () => saveRef.current(),
    closeNow,
    /** Per «Send»: salva i campi così come sono e restituisce la bozza salvata. */
    saveForSend: async () => {
      clearTimer();
      const saved = await saveMutation.mutateAsync(inputOf(fieldsRef.current!, modeRef.current));
      dirty.current = false;
      return saved;
    },
    /** Inviata: la casella non salva più nulla. */
    markSent: () => {
      gone.current = true;
    },
    /** «Discard»: la casella non salva più nulla; la bozza com'era, per l'«Undo». */
    discarded: (): MailDraft => {
      clearTimer();
      dirty.current = false;
      gone.current = true;
      const f = fieldsRef.current!;
      return { ...inputOf(f, modeRef.current), id: f.id, personId: owner, updatedAt: "" };
    },
    retrySave: () => {
      dirty.current = true;
      void saveRef.current();
    },
    /** «Save» della bozza tornata non salvata: la scrive sopra quella dello slot. */
    saveUnsaved: async () => {
      const f = fieldsRef.current;
      if (!f || gone.current || !unsavedRef.current) return;
      setStatus("saving");
      try {
        await saveMutation.mutateAsync({ ...inputOf(f, modeRef.current), overwrite: true });
        unsavedRef.current = null;
        setUnsaved(null);
        dirty.current = false;
        setStatus("saved");
      } catch {
        setStatus("failed");
      }
    },
    /** «Discard» della bozza tornata non salvata: si chiude, senza toccare l'altra. */
    discardUnsaved: () => {
      clearTimer();
      unsavedRef.current = null;
      dirty.current = false;
      gone.current = true;
      callbacks.current.onClose();
    },
    /** «Tieni la mia»: salva sopra la versione cambiata su Gmail. */
    keepMine: async () => {
      const f = fieldsRef.current;
      if (!f || gone.current) return;
      clearTimer();
      setStatus("saving");
      try {
        await saveMutation.mutateAsync({ ...inputOf(f, modeRef.current), overwrite: true });
        dirty.current = false;
        newestFailed.current = false;
        setStatus("saved");
      } catch {
        setStatus("failed");
      }
    },
  };
}
