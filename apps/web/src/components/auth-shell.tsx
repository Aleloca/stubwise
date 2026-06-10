import type { ReactNode } from "react";
import { Wordmark } from "./wordmark";

interface AuthShellProps {
  title: string;
  subtitle: string;
  children: ReactNode;
}

/**
 * Cornice delle pagine non autenticate (login, setup): card centrata su
 * griglia blueprint con alone ambra. È la prima impressione del prodotto.
 */
export function AuthShell({ title, subtitle, children }: AuthShellProps) {
  return (
    <div className="bg-grid relative flex min-h-screen items-center justify-center overflow-hidden p-6">
      {/* Alone ambra dietro la card, come la spia di uno strumento. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-1/2 size-[42rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-signal/[0.05] blur-3xl"
      />
      {/* Sfumatura verticale che fa "affondare" la griglia ai bordi. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-ink-950 via-transparent to-ink-950"
      />

      <main className="relative w-full max-w-sm">
        <div className="border border-line bg-ink-900/90 shadow-[0_24px_60px_-24px_rgba(0,0,0,0.8)] backdrop-blur-sm">
          {/* Barra superiore: wordmark a sinistra, stato a destra. */}
          <div className="flex items-baseline justify-between border-b border-line px-6 py-4">
            <Wordmark className="text-lg" />
            <span className="font-mono text-[10px] tracking-[0.2em] text-fg-faint uppercase">
              self-hosted
            </span>
          </div>

          <div className="px-6 pt-6 pb-7">
            <h1 className="text-xl font-semibold text-fg">{title}</h1>
            <p className="mt-1 mb-6 text-sm text-fg-muted">{subtitle}</p>
            {children}
          </div>
        </div>

        <p className="mt-4 text-center font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase">
          issue tracking · ai pipeline
        </p>
      </main>
    </div>
  );
}
