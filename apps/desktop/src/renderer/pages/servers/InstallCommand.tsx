import { useState, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { useInstallCommand, useRemovalCommand } from "../../data/queries";
import type { SshAccessView } from "../../data/servers";
import { useToast } from "../../tasks-ui/Toast";
import { secondaryButton } from "../tasks/controls";
import { ghostButton, smallSecondary } from "../task/parts";
import { clockLocal, dayLocal } from "./format";
import { CopyGlyph, TroubleGlyph } from "./glyphs";

// Un comando da incollare sul server (shape server-access.md §3, passo 2 e
// Revoca): l'unico testo monospace della parte, nello stile del log delle
// Releases (filetto, fondo ink/4, 12px) senza la ricerca. Alto fino a
// `SHOWN_LINES` righe, poi «Show all N lines» lo apre in posto; le righe
// lunghe scorrono in orizzontale DENTRO il blocco, mai la pagina. Il testo
// arriva sempre dal livello dati: qui non si scrive nessuno script.

/** Le righe visibili prima di «Show all». */
const SHOWN_LINES = 12;

export function CommandBlock({ label, command }: { label: string; command: string }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [all, setAll] = useState(false);
  const lines = command.replace(/\n$/, "").split("\n");
  const long = lines.length > SHOWN_LINES;
  const shown = all || !long ? lines : lines.slice(0, SHOWN_LINES);

  const copy = () => {
    const clipboard = navigator.clipboard;
    if (!clipboard) return toast.error(t("servers.ssh.command.copyError"));
    void clipboard.writeText(command).then(
      () => toast.show(t("servers.ssh.command.copied")),
      () => toast.error(t("servers.ssh.command.copyError")),
    );
  };

  return (
    <section
      aria-label={label}
      data-command
      className="flex max-w-[760px] min-w-0 flex-col rounded-md border border-rule bg-ink/4"
    >
      <div className="flex items-center gap-1 border-b border-rule py-1 pr-1 pl-3">
        {/* Lungo, il conto lo dice già «Show all N lines». */}
        <span className="num mr-auto text-xs text-ink-muted">
          {long
            ? ""
            : t("servers.ssh.command.lines", {
                n: new Intl.NumberFormat(i18n.language).format(lines.length),
              })}
        </span>
        {long && (
          <button
            type="button"
            className={ghostButton}
            aria-expanded={all}
            onClick={() => setAll((v) => !v)}
          >
            {all
              ? t("servers.ssh.command.showLess")
              : t("servers.ssh.command.showAll", { n: lines.length })}
          </button>
        )}
        <button
          type="button"
          className={ghostButton}
          aria-label={t("servers.ssh.command.copyLabel")}
          onClick={copy}
        >
          <CopyGlyph />
          {t("servers.ssh.command.copy")}
        </button>
      </div>
      {/* Da tastiera si scorre in orizzontale: il blocco prende il fuoco. */}
      <pre
        tabIndex={0}
        className="font-code overflow-x-auto px-3 py-2 whitespace-pre text-ink selection:bg-ink/20 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-focus)]"
      >
        {shown.join("\n")}
        {!all && long && (
          <span aria-hidden="true" className="text-ink-faint">
            {"\n…"}
          </span>
        )}
      </pre>
    </section>
  );
}

// --- il passo 2: chi crea cosa, il comando, le impronte -----------------

type Access = SshAccessView;

/** «SHA256:3f9a01bc…c21e»: 8 + 4 caratteri, l'impronta intera nel `title`. */
function Fingerprint({ value }: { value: string }) {
  const hash = value.replace(/^SHA256:/, "");
  return (
    <span title={value} className="num">
      SHA256:{hash.slice(0, 8)}…{hash.slice(-4)}
    </span>
  );
}

/** I due utenti che il comando crea: cosa può fare ciascuno, PRIMA del comando. */
export function UsersTable({ notes }: { notes: boolean }) {
  const { t } = useTranslation();
  const row =
    "grid grid-cols-[minmax(0,1fr)] gap-x-4 gap-y-0.5 py-1.5 @[720px]:grid-cols-[120px_minmax(0,1fr)]";
  const name = "num text-left text-sm font-semibold text-ink";
  return (
    <div role="table" aria-label={t("servers.ssh.users.label")} className="flex flex-col">
      <div role="rowgroup" className="sr-only">
        <div role="row">
          <span role="columnheader">{t("servers.ssh.users.user")}</span>
          <span role="columnheader">{t("servers.ssh.users.does")}</span>
        </div>
      </div>
      <div role="rowgroup" className="flex flex-col">
        <div role="row" className={row}>
          <span role="rowheader" className={name}>
            stubwise-read
          </span>
          <span role="cell" className="flex flex-col gap-0.5">
            <span className="text-[13px] leading-[18px] text-ink">
              {t("servers.ssh.users.read")}
            </span>
            {notes && (
              <span className="text-xs text-ink-faint">{t("servers.ssh.users.readNote")}</span>
            )}
          </span>
        </div>
        <div role="row" className={row}>
          <span role="rowheader" className={name}>
            stubwise-fix
          </span>
          <span role="cell" className="flex flex-col gap-0.5">
            <span className="flex items-start gap-1.5 text-[13px] leading-[18px] text-ink">
              <TroubleGlyph />
              <span>
                <strong className="font-semibold">{t("servers.ssh.users.fix")}</strong>{" "}
                {t("servers.ssh.users.fixSudo")}
              </span>
            </span>
            {notes && (
              <span className="pl-[22px] text-xs text-ink-muted">
                {t("servers.ssh.users.fixNote")}
              </span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Il passo 2 aperto (o il comando rivisto dal «⋯»): solo con `servers.ssh.manage`. */
export function InstallStep({ code, access }: { code: string; access: Access }) {
  const { t } = useTranslation();
  const q = useInstallCommand(code, access.canManage);
  const keys =
    access.pending ?? (access.read && access.fix ? { read: access.read, fix: access.fix } : null);
  return (
    <>
      <p className="text-sm text-ink-muted">{t("servers.ssh.step2.creates")}</p>
      <UsersTable notes />
      {q.isError ? (
        <div role="alert" className="flex items-center gap-3">
          <p className="text-sm text-ink">{t("servers.ssh.command.loadError")}</p>
          <button type="button" className={smallSecondary} onClick={() => void q.refetch()}>
            {t("taskUi.states.retry")}
          </button>
        </div>
      ) : q.data ? (
        <CommandBlock label={t("servers.ssh.command.label", { code })} command={q.data.command} />
      ) : (
        <span
          aria-hidden="true"
          className="skeleton-breathe h-40 max-w-[760px] rounded-md bg-ink/6"
        />
      )}
      <div className="flex flex-col gap-1">
        <p className="text-sm text-ink">{t("servers.ssh.step2.runAs", { code })}</p>
        {keys && (
          <p className="text-xs text-ink-muted">
            {t("servers.ssh.step2.fpRead")} <Fingerprint value={keys.read.fingerprint} />
            <span aria-hidden="true" className="px-1.5 text-ink-faint">
              ·
            </span>
            {t("servers.ssh.step2.fpFix")} <Fingerprint value={keys.fix.fingerprint} />
          </p>
        )}
        <p className="text-xs text-ink-faint">{t("servers.ssh.step2.prototype")}</p>
      </div>
    </>
  );
}

/**
 * Dopo una revoca (o dal «⋯»): il comando che toglie i due utenti, letto
 * dal livello dati (`getRemovalCommand`, la stessa fonte del risultato
 * della revoca), fino a «Done». Il titolo prende il fuoco.
 */
export function RemovalStep({
  code,
  revokedAt,
  titleRef,
  onDone,
}: {
  code: string;
  revokedAt: string;
  titleRef: Ref<HTMLHeadingElement>;
  onDone: () => void;
}) {
  const { t, i18n } = useTranslation();
  const q = useRemovalCommand(code, true);
  return (
    <div className="ssh-step-open flex flex-col gap-3">
      <h3
        ref={titleRef}
        tabIndex={-1}
        className="max-w-[760px] rounded-sm text-md font-semibold text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]"
      >
        {t("servers.ssh.removal.title", {
          date: dayLocal(revokedAt, i18n.language),
          time: clockLocal(revokedAt, i18n.language),
          code,
        })}
      </h3>
      {q.isError ? (
        <div role="alert" className="flex items-center gap-3">
          <p className="text-sm text-ink">{t("servers.ssh.command.loadError")}</p>
          <button type="button" className={smallSecondary} onClick={() => void q.refetch()}>
            {t("taskUi.states.retry")}
          </button>
        </div>
      ) : q.data ? (
        <CommandBlock
          label={t("servers.ssh.command.removalLabel", { code })}
          command={q.data.command}
        />
      ) : (
        <span
          aria-hidden="true"
          className="skeleton-breathe h-48 max-w-[760px] rounded-md bg-ink/6"
        />
      )}
      <span>
        <button type="button" className={secondaryButton} onClick={onDone}>
          {t("servers.ssh.removal.done")}
        </button>
      </span>
    </div>
  );
}
