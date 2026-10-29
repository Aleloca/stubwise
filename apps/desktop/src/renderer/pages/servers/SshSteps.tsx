import type { ReactNode, Ref } from "react";
import { useTranslation } from "react-i18next";
import { Glyph } from "../automations/glyphs";

// I passi numerati della procedura dell'accesso SSH (shape server-access.md
// §3): il passo corrente aperto (200ms in altezza, niente con movimento
// ridotto), quelli fatti ridotti a una riga con ✓, quelli dopo in tono
// minore. Il titolo prende il fuoco quando il passo si apre.

type StepState = "done" | "current" | "todo";

/** Il segno del passo: ✓ fatto, numero pieno corrente, numero vuoto dopo; lo stato anche a parole. */
function Marker({ n, state }: { n: number; state: StepState }) {
  const { t } = useTranslation();
  return (
    <span className="flex">
      <span
        aria-hidden="true"
        className={`num grid size-5 shrink-0 place-items-center rounded-full text-xs font-semibold ${
          state === "current"
            ? "bg-ink text-ground"
            : `border border-rule-strong ${state === "done" ? "text-ink-muted" : "text-ink-faint"}`
        }`}
      >
        {state === "done" ? (
          <Glyph size={12}>
            <path d="m4 8.5 2.5 2.5L12 5.5" />
          </Glyph>
        ) : (
          n
        )}
      </span>
      <span className="sr-only">{t(`servers.ssh.steps.${state === "todo" ? "next" : state}`)}</span>
    </span>
  );
}

export function Step({
  n,
  state,
  title,
  titleRef,
  aside,
  children,
}: {
  n: number;
  state: StepState;
  title: string;
  titleRef?: Ref<HTMLHeadingElement>;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li
      aria-current={state === "current" ? "step" : undefined}
      className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-3 border-b border-rule py-3 last:border-b-0"
    >
      <Marker n={n} state={state} />
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex min-h-5 flex-wrap items-baseline gap-x-2">
          <h3
            ref={titleRef}
            tabIndex={-1}
            className={`rounded-sm text-md outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)] ${
              state === "todo" ? "text-ink-muted" : "font-semibold text-ink"
            }`}
          >
            {title}
          </h3>
          {aside}
        </div>
        {children && <div className="ssh-step-open flex flex-col gap-3">{children}</div>}
      </div>
    </li>
  );
}
