import { forwardRef } from "react";
import { useTranslation } from "react-i18next";
import type { SshAccessView } from "../../data/servers";
import { Glyph } from "../automations/glyphs";

// L'esito di una «Verify» (shape server-access.md §3, passo 3): una riga
// per accesso, glifo + frase, mai il solo colore. «Lettura che scrive» non
// è un esito fra gli altri: è il riquadro d'errore col filetto `critical`,
// l'unico della parte, e nessuna riga di successo per la lettura (anche se
// la chiave entra). L'esito si legge dalla vista (`verification`), non si
// ricostruisce.

type Verification = NonNullable<SshAccessView["verification"]>;

export const OkGlyph = () => (
  <Glyph className="mt-0.5 shrink-0 text-positive">
    <path d="m4 8.5 2.5 2.5L12 5.5" />
  </Glyph>
);

export const FailGlyph = () => (
  <Glyph className="mt-0.5 shrink-0 text-critical">
    <path d="m4.5 4.5 7 7m0-7-7 7" />
  </Glyph>
);

/** Un esito tutto `failed` è il server che non risponde (nessuno dei due provato). */
export const unreachable = (v: Verification) => v.read === "failed" && v.fix === "failed";

function Line({
  ok,
  access,
  children,
}: {
  ok: boolean;
  access: "read" | "fix" | "both";
  children: string;
}) {
  return (
    <p
      data-outcome={ok ? "ok" : "failed"}
      data-access={access}
      className="flex items-start gap-2 text-md text-ink"
    >
      {ok ? <OkGlyph /> : <FailGlyph />}
      <span>{children}</span>
    </p>
  );
}

/** Il riquadro «Read access can write»: un errore, spegne entrambi gli accessi. */
export function ReadWritesBox() {
  const { t } = useTranslation();
  return (
    <div role="alert" className="flex flex-col gap-1 border-l border-critical py-1 pl-3">
      <p className="flex items-start gap-2 text-md font-semibold text-ink">
        <FailGlyph />
        <span>{t("servers.ssh.outcome.readWrites")}</span>
      </p>
      <p className="pl-6 text-sm text-ink-muted">{t("servers.ssh.outcome.readWritesHint")}</p>
    </div>
  );
}

/**
 * Le righe dell'esito. `summary` (rigenerazione) è la frase che dice cosa
 * succede alle chiavi: le nuove in uso, o le attuali che restano.
 */
export const VerifyResult = forwardRef<
  HTMLDivElement,
  { code: string; verification: Verification; summary?: { ok: boolean; text: string } | null }
>(function VerifyResult({ code, verification: v, summary }, ref) {
  const { t } = useTranslation();
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="status"
      aria-live="polite"
      aria-label={t("servers.ssh.outcome.label")}
      className="flex flex-col gap-1.5 rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]"
    >
      {summary && (
        <Line ok={summary.ok} access="both">
          {summary.text}
        </Line>
      )}
      {v.read === "writes" ? (
        <ReadWritesBox />
      ) : unreachable(v) ? (
        <Line ok={false} access="both">
          {t("servers.ssh.outcome.unreachable", { code })}
        </Line>
      ) : (
        <>
          <Line ok={v.read === "ok"} access="read">
            {v.read === "ok"
              ? t("servers.ssh.outcome.readOk")
              : t("servers.ssh.outcome.readFailed", { code })}
          </Line>
          <Line ok={v.fix === "ok"} access="fix">
            {v.fix === "ok"
              ? t("servers.ssh.outcome.fixOk")
              : t("servers.ssh.outcome.fixFailed", { code })}
          </Line>
        </>
      )}
    </div>
  );
});
