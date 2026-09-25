import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { mockReply } from "../../lib/wisey-mock";
import { WISEY_STAGE_MS, WISEY_WORD_MS, wiseyPhase, type WiseyPhase, type WiseyStage } from "../../lib/wisey-phase";

export interface WiseyMessage {
  role: "user" | "wisey";
  text: string;
}

export interface WiseyStore {
  messages: WiseyMessage[];
  stage: WiseyStage;
  draft: string;
  inputFocused: boolean;
  doneUnseen: boolean;
  /** La fase del gufo, UNA per la pagina e per la barra: `wiseyPhase` dello stato. */
  phase: WiseyPhase;
  /** Una risposta è in corso: un secondo invio è bloccato. */
  busy: boolean;
  canSend: boolean;
  /** Il testo di un messaggio COME SI VEDE ORA: l'ultima risposta compare parola per parola. */
  visibleText: (index: number) => string;
  setDraft: (text: string) => void;
  setInputFocused: (focused: boolean) => void;
  /** La tab Wisey è a fuoco: la schermata lo dice qui, e decide se «fatto» è stato visto. */
  setTabFocused: (focused: boolean) => void;
  send: (question: string) => void;
}

const WiseyContext = createContext<WiseyStore | null>(null);

/**
 * LO STATO DI WISEY, sopra il navigator (25 set 2026, design §10).
 *
 * Stava nella schermata; ne è uscito perché ora lo leggono DUE posti — la
 * pagina e l'icona della barra, che si anima sulla stessa fase — e perché
 * una risposta deve proseguire e finire anche fuori dalla tab: per questo i
 * timer della risposta finta vivono qui e non nella schermata.
 *
 * «FATTO» RESTA FINCHÉ NON L'HAI VISTO: se una risposta finisce mentre la tab
 * Wisey non è a fuoco, lo stage torna a riposo ma `doneUnseen` tiene il gufo
 * su «fatto» (`wiseyPhase`), nella barra e nella pagina. Quando la tab va a
 * fuoco, «fatto» fa un giro e poi si torna a riposo; se la risposta finisce
 * mentre si è già sulla tab, il giro parte subito, come prima.
 *
 * Montato dentro l'area autenticata: un logout lo smonta, e con lui la
 * conversazione e i timer — che è anche ciò che deve succedere.
 */
export function WiseyProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<WiseyMessage[]>([]);
  const [stage, setStage] = useState<WiseyStage>("idle");
  const [draft, setDraft] = useState("");
  const [inputFocused, setInputFocused] = useState(false);
  const [shownWords, setShownWords] = useState(0);
  const [doneUnseen, setDoneUnseen] = useState(false);
  // Letti dentro i timer: un ref, non lo stato catturato alla loro creazione.
  const tabFocused = useRef(false);
  const doneUnseenRef = useRef(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(
    () => () => {
      for (const timer of timers.current) clearTimeout(timer);
    },
    [],
  );

  const later = useCallback((ms: number, run: () => void) => {
    timers.current.push(setTimeout(run, ms));
  }, []);

  /** «Fatto» per un giro, poi riposo. */
  const playDone = useCallback(() => {
    setStage("done");
    later(WISEY_STAGE_MS.done, () => setStage("idle"));
  }, [later]);

  const finish = useCallback(() => {
    if (tabFocused.current) {
      playDone();
    } else {
      doneUnseenRef.current = true;
      setDoneUnseen(true);
      setStage("idle");
    }
  }, [playDone]);

  const answer = useCallback(
    (text: string) => {
      const words = text.split(" ");
      setMessages((current) => [...current, { role: "wisey", text }]);
      setShownWords(1);
      setStage("answering");
      // A scatti, a tempo col becco: una parola per fotogramma di «ti risponde».
      for (let index = 2; index <= words.length; index += 1) {
        later(WISEY_WORD_MS * (index - 1), () => setShownWords(index));
      }
      later(WISEY_WORD_MS * words.length, finish);
    },
    [finish, later],
  );

  const busy = stage !== "idle";

  const send = useCallback(
    (question: string) => {
      const text = question.trim();
      if (text.length === 0 || busy) return;
      setMessages((current) => [...current, { role: "user", text }]);
      setDraft("");
      setStage("thinking");
      const reply = mockReply(text);
      const replyText = t(reply.textKey);
      later(WISEY_STAGE_MS.thinking, () => {
        if (reply.kind === "action") {
          setStage("working");
          later(WISEY_STAGE_MS.working, () => answer(replyText));
        } else {
          answer(replyText);
        }
      });
    },
    [answer, busy, later, t],
  );

  const setTabFocused = useCallback(
    (focused: boolean) => {
      tabFocused.current = focused;
      if (focused && doneUnseenRef.current) {
        doneUnseenRef.current = false;
        setDoneUnseen(false);
        playDone();
      }
    },
    [playDone],
  );

  const lastIndex = messages.length - 1;
  const visibleText = useCallback(
    (index: number) => {
      const message = messages[index];
      if (!message) return "";
      if (message.role === "wisey" && index === lastIndex && stage === "answering") {
        return message.text.split(" ").slice(0, shownWords).join(" ");
      }
      return message.text;
    },
    [lastIndex, messages, shownWords, stage],
  );

  const store = useMemo<WiseyStore>(
    () => ({
      messages,
      stage,
      draft,
      inputFocused,
      doneUnseen,
      phase: wiseyPhase({ stage, inputFocused, hasText: draft.length > 0, doneUnseen }),
      busy,
      canSend: draft.trim().length > 0 && !busy,
      visibleText,
      setDraft,
      setInputFocused,
      setTabFocused,
      send,
    }),
    [busy, doneUnseen, draft, inputFocused, messages, send, setTabFocused, stage, visibleText],
  );

  return <WiseyContext.Provider value={store}>{children}</WiseyContext.Provider>;
}

export function useWisey(): WiseyStore {
  const store = useContext(WiseyContext);
  if (!store) throw new Error("useWisey va usato dentro WiseyProvider");
  return store;
}
