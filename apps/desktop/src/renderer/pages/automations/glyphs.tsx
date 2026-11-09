import type { ReactNode } from "react";
import type { Automation, RunStatus, Step } from "../../data/types";

// I glifi delle Automations: lo stato di un'automazione e di un'esecuzione
// (sempre accanto alla parola, mai da soli), il tipo di un passo (lineare,
// `ink-muted`: i passi si distinguono per forma, non per colore — shape
// automations.md §4) e le sorgenti (monocromi, niente marchi). Stesso tratto
// delle icone del binario, griglia 16, `currentColor`.

export function Glyph({
  size = 16,
  className = "",
  children,
}: {
  size?: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      {children}
    </svg>
  );
}

/** Lo stato di un'automazione: punto pieno (attiva), due barre (in pausa), cerchio vuoto (bozza). */
export function AutomationStatusGlyph({ status }: { status: Automation["status"] }) {
  if (status === "active") {
    return (
      <span aria-hidden="true" className="grid size-4 shrink-0 place-items-center">
        <span className="size-2 rounded-full bg-positive" />
      </span>
    );
  }
  if (status === "paused") {
    return (
      <Glyph className="text-ink-muted">
        <path d="M6 4.5v7M10 4.5v7" />
      </Glyph>
    );
  }
  return (
    <Glyph className="text-ink-faint">
      <circle cx="8" cy="8" r="3.5" />
    </Glyph>
  );
}

/**
 * Lo stato di un'esecuzione. In attesa di una decisione: punto pieno se
 * aspetta chi guarda, cerchio vuoto se aspetta altri (shape §5).
 */
export function RunStatusGlyph({ status, mine = false }: { status: RunStatus; mine?: boolean }) {
  switch (status) {
    case "running":
      return (
        <Glyph className="text-ink">
          <path d="M6 4.5 11 8l-5 3.5z" fill="currentColor" />
        </Glyph>
      );
    case "waiting_approval":
    case "waiting_project":
      return mine ? (
        <span aria-hidden="true" className="grid size-4 shrink-0 place-items-center">
          <span className="size-2 rounded-full bg-ink" />
        </span>
      ) : (
        <Glyph className="text-ink">
          <circle cx="8" cy="8" r="3.5" />
        </Glyph>
      );
    case "waiting_event":
      return (
        <Glyph className="text-ink-muted">
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 5v3.25l2 1.25" />
        </Glyph>
      );
    case "suspended":
      return (
        <Glyph className="text-ink-muted">
          <path d="M6 4.5v7M10 4.5v7" />
        </Glyph>
      );
    case "done":
      return (
        <Glyph className="text-positive">
          <path d="m4 8.25 2.5 2.5L12 5.25" />
        </Glyph>
      );
    case "failed":
      return <CriticalGlyph />;
    case "cancelled":
      return (
        <Glyph className="text-ink-faint">
          <path d="m5 11 6-6" />
        </Glyph>
      );
  }
}

export function CriticalGlyph({ className = "text-critical" }: { className?: string }) {
  return (
    <Glyph className={className}>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.75v3.75M8 11h.01" />
    </Glyph>
  );
}

export function WarningGlyph({ className = "text-warning" }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M8 2.25 14.25 13H1.75z" />
      <path d="M8 6.5v3M8 11.25h.01" />
    </Glyph>
  );
}

/** La mano dell'approvazione. */
export function ApprovalGlyph() {
  return (
    <Glyph className="text-ink-muted">
      <path d="M5.5 8V3.75a1 1 0 0 1 2 0V7.5M7.5 7V2.75a1 1 0 0 1 2 0V7.5M9.5 7.25V4a1 1 0 0 1 2 0v5.5a4.25 4.25 0 0 1-4.25 4.25h-.5A3.5 3.5 0 0 1 3.9 12.1L2.6 9.9a1 1 0 0 1 1.65-1.1L5.5 10.25" />
    </Glyph>
  );
}

const STEP_MARKS: Record<Step["kind"] | "trigger", ReactNode> = {
  trigger: <path d="M3 8h7M7.5 4.5 11 8l-3.5 3.5M13 3.5v9" />,
  createTask: (
    <>
      <rect x="2.75" y="2.75" width="10.5" height="10.5" rx="2" />
      <path d="m5.5 8.25 1.75 1.75L10.75 6.5" />
    </>
  ),
  createMilestone: <path d="M4 14V2.5M4 3h8l-2 2.75L12 8.5H4" />,
  createRequest: <path d="M2.75 3.75h10.5v7h-6l-3 2.5v-2.5h-1.5zM5.5 6.5h5M5.5 8.5h3" />,
  sendEmail: <path d="M2.25 4h11.5v8H2.25zM2.5 4.25 8 8.75l5.5-4.5" />,
  notify: <path d="M4 11V7.25a4 4 0 0 1 8 0V11l1.25 1.5H2.75zM6.75 14h2.5" />,
  startAutomation: <path d="M2.75 8h4.5M5.5 5.5 8 8l-2.5 2.5M9.5 4.5h3.75v7H9.5" />,
  wait: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3.25l2 1.25" />
    </>
  ),
  claude: (
    <>
      <circle cx="8" cy="8" r="5.5" strokeDasharray="2 1.6" />
      <path d="M6 8h4M8 6v4" />
    </>
  ),
  condition: <path d="M8 2.5v4M8 6.5 4 10.5v3M8 6.5l4 4v3" />,
  forEach: (
    <path d="M12.5 6A4.75 4.75 0 0 0 3.5 6.5M3.5 10A4.75 4.75 0 0 0 12.5 9.5M3 3.5v3h3M13 12.5v-3h-3" />
  ),
  repeatUntil: <path d="M4 5.5h7.5L9.5 3.5M12 10.5H4.5l2 2" />,
};

/** Il tipo di un passo (o l'inizio): un glifo lineare, mai un colore. */
export function StepGlyph({ kind }: { kind: Step["kind"] | "trigger" }) {
  return <Glyph className="text-ink-muted">{STEP_MARKS[kind]}</Glyph>;
}

/** Una sorgente: rombo per un CRM, freccia d'ingresso per un webhook (shape sources [A 1]). */
export function SourceGlyph({ kind }: { kind: "audin" | "hubspot" | "webhook" }) {
  return (
    <Glyph className="text-ink-muted">
      {kind === "webhook" ? (
        <path d="M2 8h7.5M6.5 5l3 3-3 3M12.5 2.75v10.5" />
      ) : (
        <path d="M8 2 14 8l-6 6-6-6z" />
      )}
    </Glyph>
  );
}

/** «⋯»: il menu in riga. */
export function MoreGlyph() {
  return (
    <Glyph>
      <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth={2.2} />
    </Glyph>
  );
}

/** Freccia del gruppo che si apre e chiude (ruota di 90°). */
export function Disclosure({ open }: { open: boolean }) {
  return (
    <Glyph
      size={12}
      className={`text-ink-faint transition-transform duration-[var(--duration-fast)] ease-out ${open ? "rotate-90" : ""}`}
    >
      <path d="m6 4 4 4-4 4" />
    </Glyph>
  );
}
