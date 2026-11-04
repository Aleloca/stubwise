import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { placeDraft } from "../../domain/claude/intents/mailDraft";
import { useClaudeMailDraft } from "../../data/queries";
import type { Project } from "../../data/types";
import { shortcutLabel } from "../../platform/platform";
import { ClaudeDraftMark, useClaudeDraftMark } from "../../tasks-ui/ClaudeDraftMark";
import { MenuGroup, RadioItem, Chevron } from "../../tasks-ui/Menu";
import { MenuButton } from "../tasks/controls";
import {
  primaryButton,
  quietButton,
  secondaryButton,
  StopGlyph,
} from "../claude/conversation/parts";
import { AlertGlyph } from "./glyphs";

// «Ask Claude» nella casella di scrittura (shape mail-compose §5): la riga
// dell'indicazione sopra la barra (facoltativa in una risposta,
// obbligatoria in un'email nuova, con «About: <progetto>»), la domanda
// «Replace» / «Add below» quando il corpo ha già testo [A 10], lo streaming
// NEL corpo (che resta in sola lettura, con Stop al posto del bottone) e,
// finita, il segno unico «Claude's draft» con le task citate, «Undo» e «Try
// again» [A 11, DR 7]. La bozza è un testo nel campo: niente qui salva o
// invia — l'invio resta un clic su «Send» di chi scrive. Area 10b (Task 10):
// lo stesso segno per la bozza messa dal riquadro di Claude (`fromPanel`),
// che sparisce alla prima modifica — «Edited from Claude's draft» non c'è più.

/** Il segno di Claude, 16 px: le iniziali nell'anello tratteggiato. */
export function ClaudeMark() {
  return (
    <span
      aria-hidden="true"
      className="grid size-4 shrink-0 place-items-center rounded-full border border-dashed border-claude text-[8px] leading-none font-semibold text-ink"
    >
      CL
    </span>
  );
}

type Stage = "closed" | "hint" | "ask";

/**
 * Lo stato di «Ask Claude» per una casella: il corpo prima di Claude (per
 * «Undo»), il segno della bozza (`useClaudeDraftMark`) e, mentre scrive, il
 * corpo da mostrare.
 */
export function useClaudeDraft({
  threadId,
  body,
  setBody,
  hintRef,
}: {
  threadId: string | null;
  body: string;
  /** Mette nel corpo il testo di Claude (o quello di prima, con «Undo»). */
  setBody: (text: string) => void;
  hintRef: RefObject<HTMLInputElement | null>;
}) {
  const claude = useClaudeMailDraft();
  const [stage, setStage] = useState<Stage>("closed");
  const [hint, setHint] = useState("");
  const [about, setAbout] = useState<string | null>(null);
  const mark = useClaudeDraftMark(body);
  /** Le task citate da una bozza del riquadro (i codici dell'evento). */
  const [panelSources, setPanelSources] = useState<readonly string[]>([]);
  const [announce, setAnnounce] = useState(false);
  const before = useRef<{ body: string; how: "replace" | "below" }>({ body: "", how: "replace" });
  const setBodyRef = useRef(setBody);
  setBodyRef.current = setBody;
  const state = claude.state;

  // Finita (o fermata): il testo entra nel corpo, una volta.
  const settled = state.status === "done" || state.status === "stopped" ? state.outcome : null;
  useEffect(() => {
    if (!settled) return;
    const text = placeDraft(before.current.body, settled.text, before.current.how);
    setBodyRef.current(text);
    mark.place(text);
    setAnnounce(true);
  }, [settled]);

  const writing = state.status === "writing";
  const newEmail = threadId === null;

  const openHint = () => {
    if (writing) return;
    setStage("hint");
    requestAnimationFrame(() => hintRef.current?.focus());
  };
  const start = (how: "replace" | "below") => {
    before.current = { body, how };
    setStage("closed");
    mark.clear();
    setAnnounce(false);
    claude.start({ threadId, hint: hint.trim(), ...(newEmail ? { projectId: about } : {}) });
  };
  const submit = () => {
    if (newEmail && !hint.trim()) return;
    if (body.trim()) setStage("ask");
    else start("replace");
  };
  const undo = () => {
    setBody(before.current.body);
    mark.clear();
    claude.reset();
  };

  return {
    stage,
    hint,
    setHint,
    about,
    setAbout,
    writing,
    /** Il corpo mentre Claude scrive: quello di prima con il testo fin lì. */
    streamingBody: writing ? placeDraft(before.current.body, state.text, before.current.how) : null,
    outcome: settled,
    failed: state.status === "failed",
    /** Il segno «Claude's draft»: il corpo è ancora il testo di Claude. */
    marked: mark.shown,
    panelSources,
    announce,
    newEmail,
    openHint,
    closeHint: () => setStage("closed"),
    submit,
    start,
    stop: claude.stop,
    undo,
    tryAgain: () => {
      mark.clear();
      claude.reset();
      openHint();
    },
    /** Una bozza del riquadro (il testo intero, già al suo posto): il segno, niente «Undo» qui [DR 7]. */
    fromPanel: (text: string, sources: readonly string[]) => {
      claude.reset();
      setStage("closed");
      setAnnounce(false);
      setPanelSources(sources);
      setBodyRef.current(text);
      mark.place(text);
    },
    clearMark: mark.clear,
    /** Il corpo è ancora la bozza di Claude, non inviata (I1). */
    isMarked: mark.isMarked,
  };
}

export type ClaudeDraftFlow = ReturnType<typeof useClaudeDraft>;

/** «Ask Claude» nella barra; mentre scrive, Stop (⌘.). */
export function ClaudeDraftButton({ flow }: { flow: ClaudeDraftFlow }) {
  const { t } = useTranslation();
  if (flow.writing) {
    return (
      // Un altro elemento, non lo stesso bottone rietichettato: fermato, il fuoco
      // non resta su «Ask Claude» ma torna nel corpo (Composer).
      <button
        key="stop"
        data-claude-stop
        type="button"
        onClick={flow.stop}
        title={`${t("mail.compose.stop")} (${shortcutLabel(["mod", "."])})`}
        className={secondaryButton}
      >
        <StopGlyph />
        {t("mail.compose.stop")}
      </button>
    );
  }
  return (
    <button
      key="ask"
      type="button"
      onClick={flow.openHint}
      aria-expanded={flow.stage !== "closed"}
      className={`${quietButton} text-ink`}
    >
      <ClaudeMark />
      {t("mail.compose.ask")}
    </button>
  );
}

/** Sopra la barra: l'indicazione, o la domanda «Replace» / «Add below». */
export function ClaudeHintRow({
  flow,
  hintRef,
  projects,
}: {
  flow: ClaudeDraftFlow;
  hintRef: RefObject<HTMLInputElement | null>;
  /** I progetti che vedo, per «About» in un'email nuova. */
  projects: readonly Project[];
}) {
  const { t } = useTranslation();
  if (flow.stage === "ask") {
    return (
      <div
        role="group"
        aria-label={t("mail.compose.replaceAsk")}
        className="flex flex-wrap items-center gap-2 border-t border-rule px-3 py-2 text-sm text-ink"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            flow.closeHint();
          }
        }}
      >
        <p className="min-w-0 flex-1">{t("mail.compose.replaceAsk")}</p>
        <button
          type="button"
          className={secondaryButton}
          onClick={() => flow.start("below")}
          autoFocus
        >
          {t("mail.compose.addBelow")}
        </button>
        <button type="button" className={primaryButton} onClick={() => flow.start("replace")}>
          {t("mail.compose.replace")}
        </button>
      </div>
    );
  }
  if (flow.stage !== "hint") return null;
  const label = flow.newEmail ? t("mail.compose.hintRequired") : t("mail.compose.hintLabel");
  const aboutProject = projects.find((p) => p.id === flow.about);
  return (
    <div className="flex flex-col gap-1.5 border-t border-rule px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-rule-strong px-2.5 focus-within:border-ink/60">
          <ClaudeMark />
          <input
            ref={hintRef}
            aria-label={label}
            placeholder={t("mail.compose.hintPlaceholder")}
            value={flow.hint}
            onChange={(e) => flow.setHint(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                flow.submit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                flow.closeHint();
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-md text-ink outline-none placeholder:text-ink-faint"
          />
        </label>
        {flow.newEmail && (
          <MenuButton
            menuLabel={t("mail.compose.about")}
            placement="above"
            align="right"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-rule-strong px-2.5 text-sm text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 aria-expanded:bg-ink/10"
            label={
              <>
                <span className="text-ink-muted">{t("mail.compose.about")}:</span>
                <span className="num font-semibold">
                  {aboutProject?.code ?? t("mail.compose.aboutNone")}
                </span>
                <Chevron />
              </>
            }
          >
            {(close) => (
              <MenuGroup label={t("mail.compose.about")}>
                <RadioItem
                  checked={flow.about === null}
                  onSelect={() => (flow.setAbout(null), close())}
                >
                  {t("mail.compose.aboutNone")}
                </RadioItem>
                {projects.map((p) => (
                  <RadioItem
                    key={p.id}
                    checked={flow.about === p.id}
                    onSelect={() => (flow.setAbout(p.id), close())}
                  >
                    <span className="num w-9 shrink-0 text-xs font-semibold">{p.code}</span>
                    <span className="min-w-0 truncate">{p.name}</span>
                  </RadioItem>
                ))}
              </MenuGroup>
            )}
          </MenuButton>
        )}
        <button
          type="button"
          className={primaryButton}
          disabled={flow.newEmail && !flow.hint.trim()}
          onClick={flow.submit}
        >
          {t("mail.compose.write")}
        </button>
      </div>
    </div>
  );
}

/** Sotto il corpo: il segno «Claude's draft» (con le task citate), o l'errore. */
export function ClaudeDraftNote({ flow, id }: { flow: ClaudeDraftFlow; id: string }) {
  const { t } = useTranslation();
  if (flow.failed) {
    return (
      <p
        role="alert"
        className="flex flex-wrap items-center gap-1.5 px-3 pb-2 text-xs text-critical"
      >
        <AlertGlyph size={12} />
        {t("mail.compose.claudeFailed")}
        <button
          type="button"
          onClick={flow.tryAgain}
          className="rounded-sm font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
        >
          {t("mail.compose.tryAgain")}
        </button>
      </p>
    );
  }
  // Alla prima modifica (o all'invio) la riga sparisce intera.
  if (!flow.marked) return null;
  const outcome = flow.outcome;
  const link =
    "rounded-sm font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink";
  const sources = outcome
    ? outcome.used.map((u) => ({
        code: u.code,
        title: u.late ? `${u.title} (${t("mail.compose.late")})` : u.title,
      }))
    : flow.panelSources.map((code) => ({ code }));
  return (
    <div className="flex flex-col px-3 pb-2">
      {outcome && flow.announce && (
        <span role="status" className="sr-only">
          {t("mail.compose.ready")}
        </span>
      )}
      <ClaudeDraftMark
        id={id}
        action="send"
        sources={sources}
        trailing={
          // «Undo» e «Try again» solo per «Ask Claude»: il gesto è partito da qui [DR 7].
          outcome ? (
            <>
              <button type="button" onClick={flow.undo} className={link}>
                {t("mail.compose.undo")}
              </button>
              <span aria-hidden="true">·</span>
              <button type="button" onClick={flow.tryAgain} className={link}>
                {t("mail.compose.tryAgain")}
              </button>
            </>
          ) : undefined
        }
      />
    </div>
  );
}
