import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { placeDraft } from "../../domain/claude/intents/mailDraft";
import { useClaudeMailDraft } from "../../data/queries";
import type { Project } from "../../data/types";
import { shortcutLabel } from "../../platform/platform";
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
// finita, la riga che dice da cosa l'ha scritta Claude, con le task citate,
// «Undo» e «Try again» [A 11]. La bozza è un testo nel campo: niente qui
// salva o invia — l'invio resta un clic su «Send» di chi scrive.

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
 * «Undo»), il testo messo da Claude (per «Edited from Claude's draft») e,
 * mentre scrive, il corpo da mostrare.
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
  const [placed, setPlaced] = useState<string | null>(null);
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
    setPlaced(text);
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
    setPlaced(null);
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
    setPlaced(null);
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
    edited: placed !== null && body !== placed,
    placed: placed !== null,
    announce,
    newEmail,
    openHint,
    closeHint: () => setStage("closed"),
    submit,
    start,
    stop: claude.stop,
    undo,
    tryAgain: () => {
      setPlaced(null);
      claude.reset();
      openHint();
    },
  };
}

export type ClaudeDraftFlow = ReturnType<typeof useClaudeDraft>;

/** «Ask Claude» nella barra; mentre scrive, Stop (⌘.). */
export function ClaudeDraftButton({ flow }: { flow: ClaudeDraftFlow }) {
  const { t } = useTranslation();
  if (flow.writing) {
    return (
      <button
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
      type="button"
      onClick={flow.openHint}
      aria-expanded={flow.stage !== "closed"}
      title={`${t("mail.compose.ask")} (${shortcutLabel(["mod", "J"])})`}
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

/** Sotto il corpo: da cosa l'ha scritta Claude, o l'errore. */
export function ClaudeDraftNote({
  flow,
  projects,
}: {
  flow: ClaudeDraftFlow;
  projects: readonly Pick<Project, "id" | "code">[];
}) {
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
  const outcome = flow.outcome;
  if (!outcome || !flow.placed) return null;
  if (flow.edited) {
    return (
      <p className="flex items-center gap-1.5 px-3 pb-2 text-xs text-ink-muted">
        <ClaudeMark />
        {t("mail.compose.edited")}
      </p>
    );
  }
  const code = projects.find((p) => p.id === outcome.projectId)?.code;
  const by = flow.newEmail
    ? code
      ? t("mail.compose.byProject", { code })
      : t("mail.compose.byHint")
    : code
      ? t("mail.compose.byThreadAndProject", { code })
      : t("mail.compose.byThread");
  const link =
    "rounded-sm font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink";
  return (
    <div className="flex flex-col gap-0.5 px-3 pb-2 text-xs text-ink-muted">
      {flow.announce && (
        <span role="status" className="sr-only">
          {t("mail.compose.ready")}
        </span>
      )}
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <ClaudeMark />
        <span>
          {by} · {t("mail.compose.editBefore")}
        </span>
        <span aria-hidden="true">·</span>
        <button type="button" onClick={flow.undo} className={link}>
          {t("mail.compose.undo")}
        </button>
        <span aria-hidden="true">·</span>
        <button type="button" onClick={flow.tryAgain} className={link}>
          {t("mail.compose.tryAgain")}
        </button>
      </p>
      {outcome.used.length > 0 && (
        <p className="pl-[22px]">
          {t("mail.compose.used")}{" "}
          {outcome.used.map((u, i) => (
            <span key={u.taskId}>
              {i > 0 && ", "}
              <span className="num font-semibold text-ink">{u.code}</span> {u.title}
              {u.late && ` (${t("mail.compose.late")})`}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
