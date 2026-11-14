import { forwardRef } from "react";
import { useTranslation } from "react-i18next";
import type { SshAccessView } from "../../data/servers";
import { JOURNAL_GROUPS } from "../../domain/servers/sshAccess";
import { Glyph } from "../automations/glyphs";

// L'esito di una «Verify» dell'accesso di sola lettura (shape
// server-access.md §3, passo 3; area 8, F4b): che cosa l'utente
// `stubwise-read` può fare sul server — il login, `sudo` (deve essere NO),
// il gruppo `docker` (NO), il journal (`systemd-journal` o `adm`, F4b-3) —
// una riga per controllo, glifo + frase, mai il solo colore. Un utente con
// più della lettura non è un esito fra gli altri: è il riquadro d'errore col
// filetto `critical`, l'unico della parte. L'esito si legge dalla vista
// (`verification`), non si ricostruisce.

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

/** Un controllo che non è un errore ma dice un limite (il journal che non si legge). */
const NoteGlyph = () => (
  <Glyph className="mt-0.5 shrink-0 text-ink-faint">
    <circle cx="8" cy="8" r="5" />
  </Glyph>
);

/** Entrato con più della lettura: `sudo` o il gruppo `docker`. */
export const privileged = (v: Verification) => v.login === "ok" && (v.sudo || v.docker);

function Line({
  outcome,
  check,
  children,
}: {
  outcome: "ok" | "failed" | "note";
  check: "login" | "sudo" | "docker" | "journal";
  children: string;
}) {
  return (
    <p
      data-outcome={outcome}
      data-check={check}
      className="flex items-start gap-2 text-md text-ink"
    >
      {outcome === "ok" ? <OkGlyph /> : outcome === "failed" ? <FailGlyph /> : <NoteGlyph />}
      <span>{children}</span>
    </p>
  );
}

/** Il riquadro «stubwise-read può fare più che leggere»: un errore, spegne l'accesso. */
export function PrivilegedBox() {
  const { t } = useTranslation();
  return (
    <div role="alert" className="flex flex-col gap-1 border-l border-critical py-1 pl-3">
      <p className="flex items-start gap-2 text-md font-semibold text-ink">
        <FailGlyph />
        <span>{t("servers.ssh.outcome.privileged")}</span>
      </p>
      <p className="pl-6 text-sm text-ink-muted">{t("servers.ssh.outcome.privilegedHint")}</p>
    </div>
  );
}

/**
 * L'esito quando l'accesso è `privileged` ma l'ultima verifica non lo dice:
 * l'utente con più della lettura era quello della chiave VECCHIA durante
 * una rigenerazione (`keyVerification`, che la vista non porta). Si dice
 * solo l'errore, senza inventare righe.
 */
export const PrivilegedResult = forwardRef<HTMLDivElement>(function PrivilegedResult(_, ref) {
  const { t } = useTranslation();
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="status"
      aria-live="polite"
      aria-label={t("servers.ssh.outcome.label")}
      className="rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]"
    >
      <PrivilegedBox />
    </div>
  );
});

/** Il gruppo con cui l'utente legge il journal (il primo dei due che ha). */
const journalGroupOf = (v: Verification) =>
  v.groups.find((g) => JOURNAL_GROUPS.includes(g)) ?? JOURNAL_GROUPS[0]!;

/**
 * Le righe dell'esito. `summary` (rigenerazione) è la frase che dice cosa
 * succede alle chiavi: la nuova in uso, o l'attuale che resta.
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
        <Line outcome={summary.ok ? "ok" : "failed"} check="login">
          {summary.text}
        </Line>
      )}
      {v.login === "unreachable" ? (
        <Line outcome="failed" check="login">
          {t("servers.ssh.outcome.unreachable", { code })}
        </Line>
      ) : v.login === "denied" ? (
        <Line outcome="failed" check="login">
          {t("servers.ssh.outcome.denied", { code })}
        </Line>
      ) : (
        <>
          {privileged(v) && <PrivilegedBox />}
          <Line outcome="ok" check="login">
            {t("servers.ssh.outcome.login")}
          </Line>
          <Line outcome={v.sudo ? "failed" : "ok"} check="sudo">
            {t(v.sudo ? "servers.ssh.outcome.sudo" : "servers.ssh.outcome.noSudo")}
          </Line>
          <Line outcome={v.docker ? "failed" : "ok"} check="docker">
            {t(v.docker ? "servers.ssh.outcome.docker" : "servers.ssh.outcome.noDocker")}
          </Line>
          <Line outcome={v.journal ? "ok" : "note"} check="journal">
            {v.journal
              ? t("servers.ssh.outcome.journal", { group: journalGroupOf(v) })
              : t("servers.ssh.outcome.noJournal")}
          </Line>
          {v.groups.length > 0 && (
            <p className="pl-6 text-sm text-ink-muted">
              {t("servers.ssh.outcome.groups", { groups: v.groups.join(", ") })}
            </p>
          )}
        </>
      )}
    </div>
  );
});
