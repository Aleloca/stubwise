import { useEffect, useRef, useState } from "react";
import {
  saveMailDraftNow,
  useLoadMailDraft,
  useSaveMailDraft,
  useSessionPersonId,
} from "../../data/queries";
import { getSessionPersonId, onBeforePersonaChange } from "../../data/session";
import type { MailAddress, MailDraft, MailDraftAttachment } from "../../data/types";
import { registerComposer } from "./composeRequest";

// La vita della bozza di una casella di scrittura (shape mail-compose §5):
// letta all'apertura, salvata da sé 800 ms dopo l'ultima modifica, chiudendo,
// cambiando conversazione e PRIMA di cambiare persona (a nome di chi
// scriveva: dopo il cambio non salva più nulla). Aprire senza scrivere non
// crea una bozza. Passare a un'altra modalità salva il corpo e rifà
// destinatari e oggetto [A 1].

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
});

export function useComposerDraft({
  threadId,
  mode,
  onClose,
  onLoaded,
  onEdit,
}: {
  threadId: string | null;
  mode: Mode;
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
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");

  const fieldsRef = useRef<ComposerFields | null>(null);
  const modeRef = useRef(mode);
  const dirty = useRef(false);
  const timer = useRef<number | null>(null);
  const gone = useRef(false);
  /** Salvataggi partiti e non ancora finiti. */
  const inFlight = useRef(0);
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
  });

  const clearTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  /** Salva ora, se c'è qualcosa da salvare. */
  const saveNow = async () => {
    clearTimer();
    const f = fieldsRef.current;
    if (!f || !dirty.current || gone.current) return;
    dirty.current = false;
    setStatus("saving");
    inFlight.current += 1;
    try {
      await saveMutation.mutateAsync(inputOf(f, modeRef.current));
      inFlight.current -= 1;
      // «Salvato» solo se nel frattempo non si è scritto altro (il timer già
      // programmato salva il testo nuovo) e nessun altro salvataggio è in
      // volo: i salvataggi si possono sovrapporre, e quello più vecchio
      // vedrebbe `dirty` già azzerato da quello più nuovo.
      if (inFlight.current === 0) setStatus(dirty.current ? "idle" : "saved");
    } catch {
      inFlight.current -= 1;
      dirty.current = true;
      setStatus("failed");
    }
  };
  const saveRef = useRef(saveNow);
  saveRef.current = saveNow;

  /** Chiude salvando; la promessa si risolve a bozza salvata. */
  const closeNow = () => {
    const saved = saveRef.current();
    gone.current = true;
    callbacks.current.onClose();
    return saved;
  };
  const closeRef = useRef(closeNow);
  closeRef.current = closeNow;
  // Chi rimette una bozza («Undo», «Edit») chiude prima questa casella.
  useEffect(() => registerComposer(threadId, () => closeRef.current()), [threadId]);

  const setFields = (patch: Partial<ComposerFields>) => {
    const next = { ...fieldsRef.current!, ...patch };
    fieldsRef.current = next;
    setFieldsState(next);
    callbacks.current.onEdit();
    dirty.current = true;
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
    let live = true;
    load(threadId, modeRef.current).then(
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
        if (f && dirty.current && !gone.current) void saveMailDraftNow(inputOf(f, modeRef.current));
        gone.current = true;
      }),
    [],
  );
  // Chiusa o un'altra conversazione: salva, se la persona è ancora quella.
  useEffect(
    () => () => {
      clearTimer();
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
  };
}
