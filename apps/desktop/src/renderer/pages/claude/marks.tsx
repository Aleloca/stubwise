import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { ConversationRow } from "../../data/types";
import { WorkingRing } from "./conversation/parts";

// I segni comuni della destinazione «Claude»: lo stato di una conversazione
// (segno + parola, mai il solo colore) e la riga che dice cosa sta facendo
// Claude adesso. Li usano l'elenco, la colonna e la testata della pagina.

/** Lo stato in cui una riga va letta: prima chi aspetta me, poi il lavoro, poi l'esito. */
export type RowState =
  | "waitingOnYou"
  /** Area 9b: nata ma ferma per la coda in pausa (o il budget): Claude non lavora ancora. */
  | "waiting"
  | "working"
  | "awaiting_answer"
  | "awaiting_approval"
  | "paused"
  | "ok"
  | "failed"
  | "timed_out"
  | "stopped"
  | "public"
  | "archived"
  | null;

export function rowStateOf(row: ConversationRow): RowState {
  if (row.waitsOnViewer) return "waitingOnYou";
  if (row.state === "finished") return row.outcome ?? "ok";
  if (row.waiting) return "waiting";
  if (row.state === "working") return "working";
  if (row.state === "awaiting_answer" || row.state === "awaiting_approval") return row.state;
  if (row.state === "paused") return "paused";
  if (row.kind === "free" && row.archived) return "archived";
  if (row.kind === "free" && row.visibility === "public") return "public";
  return null;
}

export function rowStateLabel(state: Exclude<RowState, null>, t: TFunction): string {
  if (state === "ok" || state === "failed" || state === "timed_out" || state === "stopped") {
    return t(`claude.destination.outcomes.${state}`);
  }
  return t(`claude.destination.status.${state}`);
}

const TONE: Partial<Record<Exclude<RowState, null>, string>> = {
  failed: "text-critical",
  timed_out: "text-warning",
  ok: "text-ink-muted",
};

/**
 * Il segno dello stato: anello tratteggiato che pulsa per «al lavoro»
 * (inchiostro, come sul binario), punto pieno per «aspetta te», punto vuoto
 * per le altre attese, segni disegnati per gli esiti. Rosso e ambra solo per
 * fallita e tempo scaduto; la parola c'è sempre accanto o nel `title`.
 */
export function StateSign({ state }: { state: RowState }) {
  if (state === null) return <span aria-hidden="true" className="size-3 shrink-0" />;
  if (state === "working") return <WorkingRing />;
  const box = "grid size-3 shrink-0 place-items-center";
  if (state === "waitingOnYou") {
    return (
      <span aria-hidden="true" className={box}>
        <span className="size-2 rounded-full bg-ink" />
      </span>
    );
  }
  if (
    state === "awaiting_answer" ||
    state === "awaiting_approval" ||
    state === "paused" ||
    state === "waiting"
  ) {
    return (
      <span aria-hidden="true" className={box}>
        <span
          className={`size-2 rounded-full border-[1.5px] border-ink-muted ${state === "paused" || state === "waiting" ? "border-dotted" : ""}`}
        />
      </span>
    );
  }
  return (
    <svg
      viewBox="0 0 12 12"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${TONE[state] ?? "text-ink-faint"}`}
    >
      {state === "ok" && <path d="m2.5 6.5 2.2 2.2L9.5 3.5" />}
      {state === "failed" && <path d="m3 3 6 6m0-6-6 6" />}
      {state === "timed_out" && (
        <>
          <circle cx="6" cy="6" r="4.5" />
          <path d="M6 3.5V6l1.6 1.2" />
        </>
      )}
      {state === "stopped" && <rect x="3" y="3" width="6" height="6" rx="1" />}
      {state === "public" && (
        <>
          <circle cx="6" cy="6" r="4.5" />
          <path d="M1.5 6h9M6 1.5c1.4 1.4 1.4 7.6 0 9M6 1.5c-1.4 1.4-1.4 7.6 0 9" />
        </>
      )}
      {state === "archived" && (
        <>
          <rect x="1.5" y="2.5" width="9" height="2.5" rx="0.5" />
          <path d="M2.5 5v4.5h7V5M5 7h2" />
        </>
      )}
    </svg>
  );
}

/** La frase di ciò che Claude sta facendo adesso, o `null` se non sta facendo nulla. */
export function activityText(row: ConversationRow, t: TFunction): string | null {
  if (row.privateTail) return t("claude.destination.activity.privateTail");
  const a = row.activity;
  if (!a) return null;
  if (a.kind === "action") return a.label;
  return t(`claude.destination.activity.${a.kind}`);
}

/** Il tipo in parola («Task run», «Refine»…): mai il solo colore a distinguere. */
export function useKindWord() {
  const { t } = useTranslation();
  return (kind: ConversationRow["kind"]) => t(`claude.destination.kinds.${kind}`);
}
