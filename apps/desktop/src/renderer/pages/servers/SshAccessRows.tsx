import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { now } from "../../data/dates";
import type { SshAccessView, SshUseView } from "../../data/servers";
import { Glyph } from "../automations/glyphs";
import { ago, dayLocal } from "./format";
import { TroubleGlyph } from "./glyphs";
import { FailGlyph, OkGlyph, unreachable } from "./VerifyResult";

// Le due righe di stato della parte «SSH access» (shape server-access.md
// §3, «A riposo»): una per accesso, con lo stato in parola e glifo e
// l'ultimo uso a destra; sotto la riga della correzione, sempre, «Can do
// anything on the server». Le vedono tutti i membri del progetto. Se un
// accesso funziona lo dice `usable` della vista, mai lo stato grezzo
// (in rigenerazione dipende dall'esito delle vecchie chiavi, R-L8); un
// oggetto che chi guarda non vede non si nomina.

type Access = SshAccessView;
type Kind = "read" | "fix";
const KINDS: readonly Kind[] = ["read", "fix"];

const NeutralGlyph = () => (
  <Glyph className="mt-0.5 shrink-0 text-ink-faint">
    <circle cx="8" cy="8" r="5" />
  </Glyph>
);

/** «2h ago», «yesterday», «on Oct 12»: l'ultimo uso dentro una frase. */
function usedWhen(iso: string, t: TFunction, language: string): string {
  const minutes = Math.floor((Date.parse(now()) - Date.parse(iso)) / 60_000);
  if (minutes < 1) return t("servers.ssh.when.now");
  const days = Math.floor(minutes / (24 * 60));
  if (days === 1) return t("servers.ssh.when.yesterday");
  if (days >= 7) return t("servers.ssh.when.on", { date: dayLocal(iso, language) });
  return ago(iso, t, language);
}

// --- le righe di stato ------------------------------------------------------

/** Lo stato di un accesso in parole, dalla vista (stato, `usable`, ultima verifica). */
function rowState(a: Access, kind: Kind, t: TFunction, lang: string) {
  const v = a.verification;
  const why = (x: NonNullable<Access["verification"]>) =>
    t(`servers.ssh.rows.why.${unreachable(x) ? "unreachable" : "refused"}`);
  const neutral = (text: string) => ({ glyph: <NeutralGlyph />, text });
  switch (a.state) {
    case "not_linked":
      return neutral(t("servers.ssh.rows.state.notLinked"));
    case "revoked":
      return neutral(
        t("servers.ssh.rows.state.revoked", { date: dayLocal(a.revokedAt ?? now(), lang) }),
      );
    case "awaiting_command":
      return neutral(t("servers.ssh.rows.state.waiting"));
    case "read_writes":
      return { glyph: <FailGlyph />, text: t("servers.ssh.rows.state.off") };
  }
  if (a.read === null) {
    // Prima verifica non riuscita: le chiavi non sono ancora in uso.
    return v && v[kind] === "failed"
      ? { glyph: <FailGlyph />, text: t("servers.ssh.rows.state.failed", { why: why(v) }) }
      : neutral(t("servers.ssh.rows.state.passed"));
  }
  if (!a.usable[kind]) {
    return v && !v.ofPending && v[kind] === "failed"
      ? { glyph: <FailGlyph />, text: t("servers.ssh.rows.state.failed", { why: why(v) }) }
      : { glyph: <FailGlyph />, text: t("servers.ssh.rows.state.failedPlain") };
  }
  const inUse = a.pending !== null || !v || v.ofPending;
  return {
    glyph: <OkGlyph />,
    text: inUse
      ? t("servers.ssh.rows.state.inUse")
      : t("servers.ssh.rows.state.verified", { date: dayLocal(v.at, lang) }),
  };
}

const linkClass = "rounded-sm text-ink underline underline-offset-4 hover:decoration-2";

function LastUse({ use, code }: { use: SshUseView | null; code: string }) {
  const { t, i18n } = useTranslation();
  if (!use) return <span className="text-ink-faint">{t("servers.ssh.rows.used.never")}</span>;
  const when = usedWhen(use.at, t, i18n.language);
  if (use.label.kind === "analysis")
    return (
      <span>
        {t("servers.ssh.rows.used.analysis", { when, code })}
        {use.sessionId && (
          <>
            <span aria-hidden="true" className="px-1.5 text-ink-faint">
              ·
            </span>
            <Link to="/claude/$id" params={{ id: use.sessionId }} className={linkClass}>
              {t("servers.ssh.rows.openSession")}
            </Link>
          </>
        )}
      </span>
    );
  if (!use.label.code) return <span>{t("servers.ssh.rows.used.hiddenTask", { when })}</span>;
  return (
    <span>
      {t("servers.ssh.rows.used.task", { when })}{" "}
      <Link
        to="."
        search={((prev: Record<string, unknown>) => ({ ...prev, task: use.label.code })) as never}
        className={`${linkClass} num font-semibold`}
      >
        {use.label.code}
      </Link>
    </span>
  );
}

export function AccessRows({ access, code }: { access: Access; code: string }) {
  const { t, i18n } = useTranslation();
  return (
    <ul aria-label={t("servers.ssh.rows.label", { code })} className="flex flex-col">
      {KINDS.map((kind) => {
        const s = rowState(access, kind, t, i18n.language);
        return (
          <li
            key={kind}
            className="grid grid-cols-[minmax(0,1fr)] gap-x-6 gap-y-1 border-b border-rule py-2.5 last:border-b-0 @[600px]:grid-cols-[minmax(0,180px)_minmax(0,200px)_minmax(0,1fr)]"
          >
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-md font-medium text-ink">{t(`servers.ssh.rows.${kind}`)}</span>
              <span className="num text-xs text-ink-muted">stubwise-{kind}</span>
            </span>
            <span className="flex items-start gap-1.5 text-md text-ink">
              {s.glyph}
              <span>{s.text}</span>
            </span>
            <span className="text-sm text-ink-muted @[600px]:text-right">
              <LastUse use={access.lastUse[kind]} code={code} />
            </span>
            {kind === "fix" && (
              <span className="col-span-full flex items-center gap-1.5 text-xs text-ink-muted">
                <TroubleGlyph />
                {t("servers.ssh.rows.fixWarning")}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
