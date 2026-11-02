import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { WhoCanLink } from "../../../components/WhoCanLink";
import { useUndoClaudeActions } from "../../../data/queries";
import type { ClaudeBusyReason, UndoView } from "../../../data/types";
import { useReauth } from "../../../layout/useReauth";
import type { T } from "../../../domain/claude/context";
import { UndoneGlyph } from "./parts";

// «Undo» di un gruppo di azioni di Claude (area 10a, Task 9; shape
// `claude-actions.md`). Non decide niente: lo stato arriva calcolato per chi
// guarda (`ConversationDetail.undo[groupId]`), il rifiuto al clic dal
// livello dati. Il clic passa dalla riconferma (`useReauth`) e ha la forma
// di `useSettingsWrite`: una scrittura alla volta, e il Retry rifà la stessa
// col suo seguito. Dopo il clic il fuoco resta sulla riga, sul testo nuovo.

/** Dove si apre un codice: task e richieste nel loro elenco, un progetto nella Panoramica. */
export function routeOfObject(code: string): string {
  const project = code.split("-")[0];
  if (!code.includes("-")) return `#/p/${code}/overview`;
  return /-R\d+$/.test(code) ? `#/p/${project}/requests` : `#/p/${project}/tasks?task=${code}`;
}

/** Perché un gruppo è occupato, in parole («Claude is working on MKX-31 and …»). */
export function busyWords(t: T, reasons: readonly ClaudeBusyReason[], code: string | null): string {
  const words = reasons.map((r) => {
    switch (r.kind) {
      case "claude_session":
        return r.code
          ? t("claude.conversation.busy.claudeSession", { code: r.code })
          : t("claude.conversation.busy.claudeSessionHidden");
      case "open_pr": {
        const on = code ? "On" : "";
        return r.number !== null
          ? t(`claude.conversation.busy.openPr${on}`, { number: r.number, code })
          : t(`claude.conversation.busy.openPrNoNumber${on}`, { code });
      }
      case "server_fix":
        return t("claude.conversation.busy.serverFix", { code: r.serverCode });
      case "release_fix":
        return t("claude.conversation.busy.release", { code: r.releaseCode });
      case "release":
        return t("claude.conversation.busy.release", { code: r.code });
    }
  });
  return words.join(t("claude.conversation.busy.and"));
}

/** Cosa dice la riga dopo un clic rifiutato (niente è cambiato). */
type Refusal =
  | {
      kind: "forbidden";
      whoAction: string | null;
      projectId: string | null;
      projectCode: string | null;
    }
  | { kind: "busy"; reasons: ClaudeBusyReason[] }
  | { kind: "changed_after"; byName: string | null; code: string | null }
  | { kind: "already_undone" }
  | { kind: "not_found" }
  | { kind: "not_undoable" }
  | { kind: "failed"; retry: () => void };

const linkClass =
  "font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink";

export function UndoControl({
  conversationId,
  groupId,
  view,
  count,
  masculine = false,
  code,
  viewerName,
}: {
  conversationId: string;
  groupId: string;
  /** Lo stato calcolato per chi guarda; assente o `not_yours`: niente. */
  view: UndoView | undefined;
  /** Quante azioni nel gruppo: «Undo», «Undo both», «Undo all 3». */
  count: number;
  /** L'oggetto è al maschile (progetto, traguardo): «Annullato», «l'ha modificato». */
  masculine?: boolean;
  /** Il codice dell'oggetto, per le frasi che lo nominano («Can't find MKX-31»). */
  code: string | null;
  /** Il nome di chi guarda: «Undone by …» solo se è un altro. */
  viewerName: string;
}) {
  const { t } = useTranslation();
  const undo = useUndoClaudeActions();
  const reauth = useReauth();
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  // Una scrittura alla volta: un doppio clic (anche su Retry) non ne lancia due.
  const inflight = useRef(false);
  const statusRef = useRef<HTMLSpanElement>(null);
  const [focusTick, setFocusTick] = useState(0);
  const context = masculine ? { context: "m" } : {};

  useLayoutEffect(() => {
    if (focusTick > 0) statusRef.current?.focus();
  }, [focusTick]);

  if (!view || view.state === "not_yours") return null;

  async function attempt(retrying: boolean) {
    if (inflight.current) return;
    if (!retrying) setRefusal(null);
    inflight.current = true;
    const retry = () => void attempt(true);
    let result:
      | Awaited<ReturnType<typeof undo.mutateAsync>>
      | { ok: false; error: "reauth_cancelled" }
      | undefined;
    try {
      result = await reauth(() => undo.mutateAsync({ id: conversationId, groupId }), {
        action: t("claude.conversation.undo.reauthAction"),
      });
    } catch {
      result = undefined;
    } finally {
      inflight.current = false;
    }
    if (result === undefined) {
      setRefusal({ kind: "failed", retry });
      setFocusTick((n) => n + 1);
      return;
    }
    // Chiuso il dialogo: niente è cambiato (il toast lo dice), Undo di nuovo premibile.
    if (!result.ok && result.error === "reauth_cancelled") {
      setRefusal(null);
      return;
    }
    if (result.ok) setRefusal(null);
    else {
      switch (result.error) {
        case "forbidden":
          setRefusal({
            kind: "forbidden",
            whoAction: result.whoAction,
            projectId: result.projectId,
            projectCode: result.projectCode ?? null,
          });
          break;
        case "busy":
          setRefusal({ kind: "busy", reasons: result.reasons });
          break;
        case "changed_after":
          setRefusal({ kind: "changed_after", byName: result.byName, code: result.code });
          break;
        case "already_undone":
        case "not_found":
        case "not_undoable":
          setRefusal({ kind: result.error });
          break;
        default:
          setRefusal({ kind: "failed", retry });
      }
    }
    setFocusTick((n) => n + 1);
  }

  const label =
    count === 2
      ? t("claude.conversation.undo.undoBoth")
      : count > 2
        ? t("claude.conversation.undo.undoAll", { count })
        : t("claude.conversation.undo.undo");
  const undoButton = (
    <button
      type="button"
      onClick={() => void attempt(false)}
      className="inline-flex h-7 shrink-0 items-center rounded-md px-2 text-sm font-semibold text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 active:bg-ink/10"
      data-undo-button
    >
      {label}
    </button>
  );

  const changedAfter = (byName: string | null, objectCode: string | null): ReactNode => (
    <>
      {byName
        ? t("claude.conversation.undo.changedAfter", { name: byName, ...context })
        : t("claude.conversation.undo.changedAfterAnon", context)}
      {objectCode && (
        <>
          {" · "}
          <a href={routeOfObject(objectCode)} className={linkClass}>
            {t("claude.conversation.undo.open", { code: objectCode })}
          </a>
        </>
      )}
    </>
  );

  const body = ((): ReactNode => {
    if (refusal) {
      switch (refusal.kind) {
        case "forbidden":
          return (
            <span className="text-ink-muted">
              {refusal.projectCode
                ? t("claude.conversation.undo.forbidden", { code: refusal.projectCode })
                : t("claude.conversation.undo.forbiddenNoProject")}
              {refusal.whoAction && (
                <>
                  {" · "}
                  <WhoCanLink
                    action={refusal.whoAction}
                    projectId={refusal.projectId}
                    projectCode={refusal.projectCode}
                  />
                </>
              )}
            </span>
          );
        case "busy":
          return (
            <span className="flex flex-wrap items-baseline justify-end gap-x-1 text-ink-muted">
              <span>
                {t("claude.conversation.undo.busy", {
                  reasons: busyWords(t, refusal.reasons, code),
                })}{" "}
                {t("claude.conversation.undo.busyAfter")}
              </span>
              {undoButton}
            </span>
          );
        case "changed_after":
          return (
            <span className="text-ink-muted">{changedAfter(refusal.byName, refusal.code)}</span>
          );
        case "already_undone":
          return (
            <span className="text-ink-muted">
              {t("claude.conversation.undo.alreadyUndone", context)}
            </span>
          );
        case "not_found":
          return (
            <span className="text-ink-muted">
              {code
                ? t("claude.conversation.undo.notFound", { code })
                : t("claude.conversation.undo.notFoundNoCode")}
            </span>
          );
        case "not_undoable":
          return (
            <span className="text-ink-muted">{t("claude.conversation.undo.notUndoable")}</span>
          );
        case "failed":
          return (
            <span className="text-critical">
              {t("claude.conversation.undo.failed")}{" "}
              <button
                type="button"
                onClick={refusal.retry}
                className="font-semibold text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
              >
                {t("claude.conversation.undo.retry")}
              </button>
            </span>
          );
      }
    }
    switch (view.state) {
      case "available":
        return (
          <span className="flex items-baseline gap-1.5">
            {view.needsReauth && (
              <span className="text-xs text-ink-faint">
                {t("claude.conversation.undo.needsCode")}
              </span>
            )}
            {undoButton}
          </span>
        );
      case "undone":
        return (
          <span className="inline-flex items-center gap-1 text-ink-muted">
            <UndoneGlyph size={14} />
            {view.byName && view.byName !== viewerName
              ? t("claude.conversation.undo.undoneBy", { name: view.byName, ...context })
              : t("claude.conversation.undo.undone", context)}
          </span>
        );
      case "changed_after":
        return <span className="text-ink-muted">{changedAfter(view.byName, view.code)}</span>;
      case "not_undoable":
        return <span className="text-ink-muted">{t("claude.conversation.undo.notUndoable")}</span>;
    }
  })();

  return (
    <span
      ref={statusRef}
      tabIndex={-1}
      aria-live="polite"
      data-undo={view.state}
      className="ml-auto inline-flex min-h-8 min-w-0 max-w-full items-center justify-end rounded-sm text-sm outline-offset-2 transition-opacity duration-[var(--duration-fast)] ease-out focus-visible:outline-2 focus-visible:outline-focus"
    >
      {body}
    </span>
  );
}
