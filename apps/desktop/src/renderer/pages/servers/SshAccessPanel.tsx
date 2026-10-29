import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { now } from "../../data/dates";
import {
  useLinkSshAccess,
  useRegenerateSshAccess,
  useRevokeSshAccess,
  useSimulateSshVerifyOutcome,
  useVerifySshAccess,
} from "../../data/queries";
import type { ServerDetail } from "../../data/servers";
import type { VerifyOutcome } from "../../domain/servers/sshAccess";
import { itemClass, Menu } from "../../tasks-ui/Menu";
import { useToast } from "../../tasks-ui/Toast";
import { MoreGlyph } from "../automations/glyphs";
import { Spinner } from "../drive/glyphs";
import { smallPrimary } from "../task/parts";
import { primaryButton, secondaryButton } from "../tasks/controls";
import { clockLocal, dayLocal } from "./format";
import { InstallStep, RemovalStep, UsersTable } from "./InstallCommand";
import { Part } from "./Part";
import { AccessRows } from "./SshAccessRows";
import { RegenerateDialog, RevokeDialog, SshSimulateBox } from "./SshAccessDialogs";
import { Step } from "./SshSteps";
import { ReadWritesResult, VerifyResult } from "./VerifyResult";

// La parte «SSH access» del dettaglio di un server (shape server-access.md):
// finché i due accessi non sono verificati è una procedura in tre passi
// (1 Link · 2 Run the command · 3 Verify) col passo corrente aperto; a
// verifica riuscita si chiude in due righe di stato, una per accesso, con
// l'ultimo uso. Rigenera riapre la procedura per le chiavi NUOVE sopra le
// righe in uso; Revoca mostra il comando di rimozione fino a «Done».
//
// Tutto si legge dalla vista del livello dati (`server.access`): lo stato
// (`AccessState`), se un accesso funziona (`usable`, mai lo stato grezzo:
// in rigenerazione dipende dall'esito delle vecchie chiavi, R-L8), l'esito
// dell'ultima verifica e il permesso (`canManage`, `servers.ssh.manage`).
// Chi non lo ha vede le sole righe di stato: nessun comando, nessuna
// impronta, nessuna azione. Le chiavi private non arrivano mai qui.

// --- la parte ---------------------------------------------------------------

export function SshAccessPanel({ server }: { server: ServerDetail }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const code = server.code;
  const a = server.access;
  const manage = a.canManage;
  const link = useLinkSshAccess();
  const verifyM = useVerifySshAccess();
  const regen = useRegenerateSshAccess();
  const revoke = useRevokeSshAccess();
  const simulate = useSimulateSshVerifyOutcome();

  const [relinking, setRelinking] = useState(false);
  const [removal, setRemoval] = useState(false);
  const [showCommand, setShowCommand] = useState(false);
  const [justVerified, setJustVerified] = useState<{ regen: boolean } | null>(null);
  const [confirm, setConfirm] = useState<"regenerate" | "revoke" | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [next, setNext] = useState<VerifyOutcome>("ok");
  const [focus, setFocus] = useState<"step2" | "result" | "removal" | null>(null);
  const step2Ref = useRef<HTMLHeadingElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const removalRef = useRef<HTMLHeadingElement>(null);

  // Il fuoco va dove la parte è cambiata, appena la vista nuova è arrivata.
  useEffect(() => {
    if (!focus) return;
    // Il passo 2 si apre solo con la vista nuova: prima c'è ancora il passo «dopo».
    if (focus === "step2" && a.state !== "awaiting_command" && a.state !== "regenerating") return;
    const el = { step2: step2Ref, result: resultRef, removal: removalRef }[focus].current;
    if (el) {
      el.focus();
      setFocus(null);
    }
  });

  const hasKeys = a.read !== null;
  const v = a.verification;
  const regenerating = hasKeys && a.pending !== null;
  // Quali chiavi attuali restano valide mentre si rigenera (R-L8): solo
  // quelle che funzionavano già, accesso per accesso, mai «tutte».
  const kept: "both" | "read" | "fix" | "none" =
    a.usable.read && a.usable.fix ? "both" : a.usable.read ? "read" : a.usable.fix ? "fix" : "none";
  const keptText = (both: string, read: string, fix: string, none: string) =>
    t(`servers.ssh.${{ both, read, fix, none }[kept]}`);

  const doLink = () =>
    link.mutate(code, {
      onSuccess: () => {
        setRelinking(false);
        setJustVerified(null);
        setFocus("step2");
      },
      onError: () => toast.error(t("servers.ssh.errors.link")),
    });
  const doVerify = () => {
    const wasRegen = regenerating;
    verifyM.mutate(code, {
      onSuccess: (view) => {
        setNext("ok");
        setShowCommand(false);
        setJustVerified(view.state === "verified" ? { regen: wasRegen } : null);
        setFocus("result");
      },
      onError: () =>
        toast.error(t("servers.ssh.errors.verify"), {
          action: { label: t("taskUi.states.retry"), run: doVerify },
        }),
    });
  };
  const doRegenerate = () =>
    regen.mutate(code, {
      onSuccess: () => {
        setConfirm(null);
        setJustVerified(null);
        setShowCommand(false);
        setFocus("step2");
      },
      onError: () => toast.error(t("servers.ssh.errors.regenerate")),
    });
  const doRevoke = () =>
    revoke.mutate(code, {
      onSuccess: () => {
        setConfirm(null);
        setJustVerified(null);
        setShowCommand(false);
        setRemoval(true);
        setFocus("removal");
      },
      onError: () => toast.error(t("servers.ssh.errors.revoke")),
    });

  const verifyButton = (again: boolean) => (
    <button
      type="button"
      className={`${smallPrimary} gap-1.5`}
      disabled={verifyM.isPending}
      onClick={doVerify}
    >
      {verifyM.isPending && <Spinner />}
      {verifyM.isPending
        ? t("servers.ssh.step3.verifying")
        : again
          ? t("servers.ssh.step3.again")
          : t("servers.ssh.step3.action")}
    </button>
  );

  /** L'esito delle chiavi che la procedura sta verificando, con la frase sulle chiavi se si rigenera. */
  const result = (forNew: boolean) => {
    if (a.state === "read_writes") return <ReadWritesResult ref={resultRef} />;
    if (!v || (forNew && !v.ofPending)) return null;
    const summary =
      forNew && regenerating
        ? {
            ok: false,
            text: keptText(
              "outcome.newFailedKept",
              "outcome.newFailedKeptRead",
              "outcome.newFailedKeptFix",
              "outcome.newFailedNone",
            ),
          }
        : null;
    return <VerifyResult ref={resultRef} code={code} verification={v} summary={summary} />;
  };

  /** La procedura in tre passi: per il primo collegamento o per le chiavi nuove. */
  const procedure = (current: 1 | 2 | 3) => {
    const forNew = current > 1 && (a.pending !== null || !hasKeys);
    const created = a.pending?.read.createdAt ?? a.read?.createdAt ?? null;
    const failedHere = current === 3;
    const commandOpen = current === 2 || showCommand;
    return (
      <div className="flex flex-col gap-1">
        {regenerating && (
          <div className="flex flex-col gap-0.5 pb-1">
            <h3 className="text-md font-semibold text-ink">
              {t("servers.ssh.regenerating.title")}
            </h3>
            <p className="text-sm text-ink-muted">
              {keptText(
                "regenerating.keep",
                "regenerating.keepRead",
                "regenerating.keepFix",
                "regenerating.keepNone",
              )}
            </p>
          </div>
        )}
        <ol aria-label={t("servers.ssh.steps.label", { code })} className="flex flex-col">
          <Step
            n={1}
            state={current === 1 ? "current" : "done"}
            title={t("servers.ssh.step1.title")}
            aside={
              current > 1 && created ? (
                <span className="num text-xs text-ink-muted">
                  {t("servers.ssh.step1.done", {
                    date: dayLocal(created, i18n.language),
                    time: clockLocal(created, i18n.language),
                  })}
                </span>
              ) : undefined
            }
          >
            {current === 1 && (
              <>
                <UsersTable notes={false} />
                <p className="text-sm text-ink-muted">{t("servers.ssh.step1.body")}</p>
                <span>
                  <button
                    type="button"
                    className={`${primaryButton} disabled:opacity-40`}
                    disabled={link.isPending}
                    onClick={doLink}
                  >
                    {link.isPending && <Spinner />}
                    {link.isPending
                      ? t("servers.ssh.step1.linking")
                      : t("servers.ssh.step1.action")}
                  </button>
                </span>
              </>
            )}
          </Step>
          <Step
            n={2}
            state={current === 2 ? "current" : current > 2 ? "done" : "todo"}
            title={t("servers.ssh.step2.title", { code })}
            titleRef={step2Ref}
            aside={
              failedHere ? (
                <button
                  type="button"
                  className="rounded-sm text-sm text-ink-muted underline-offset-4 hover:text-ink hover:underline"
                  aria-expanded={showCommand}
                  onClick={() => setShowCommand((s) => !s)}
                >
                  {showCommand
                    ? t("servers.ssh.menu.hideCommand")
                    : t("servers.ssh.menu.showCommand")}
                </button>
              ) : undefined
            }
          >
            {current > 1 && commandOpen && (
              <>
                {regenerating && (
                  <p className="text-sm text-ink-muted">{t("servers.ssh.regenerating.command")}</p>
                )}
                <InstallStep code={code} access={a} />
              </>
            )}
          </Step>
          <Step
            n={3}
            state={current === 3 ? "current" : "todo"}
            title={t("servers.ssh.step3.title")}
          >
            {current > 1 && (
              <>
                <p className="text-sm text-ink-muted">{t("servers.ssh.step3.hint")}</p>
                {forNew && result(true)}
                <span>{verifyButton(failedHere)}</span>
              </>
            )}
          </Step>
        </ol>
      </div>
    );
  };

  // Le voci del «⋯»: solo ciò che lo stato ammette.
  const items: { key: string; label: string; danger?: boolean; run: () => void }[] = [];
  if (manage) {
    const st = a.state;
    if (
      ["verified", "read_writes"].includes(st) ||
      (st === "verify_failed" && hasKeys && !regenerating)
    )
      items.push({
        key: "command",
        label: showCommand ? t("servers.ssh.menu.hideCommand") : t("servers.ssh.menu.showCommand"),
        run: () => setShowCommand((s) => !s),
      });
    if (st === "verified")
      items.push({ key: "verify", label: t("servers.ssh.menu.verifyAgain"), run: doVerify });
    if (["verified", "verify_failed", "read_writes"].includes(st) && !regenerating)
      items.push({
        key: "regen",
        label: t("servers.ssh.menu.regenerate"),
        run: () => setConfirm("regenerate"),
      });
    if (st !== "not_linked" && st !== "revoked")
      items.push({
        key: "revoke",
        label: t("servers.ssh.menu.revoke"),
        danger: true,
        run: () => setConfirm("revoke"),
      });
    if (st === "revoked" && !removal)
      items.push({
        key: "removal",
        label: t("servers.ssh.menu.removal"),
        run: () => {
          setRemoval(true);
          setFocus("removal");
        },
      });
  }

  const menu = items.length > 0 && (
    <span className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={t("servers.ssh.more", { code })}
        onClick={() => setMenuOpen((o) => !o)}
        className="grid size-8 place-items-center rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
      >
        <MoreGlyph />
      </button>
      {menuOpen && (
        <Menu
          label={t("servers.ssh.more", { code })}
          align="right"
          onClose={() => setMenuOpen(false)}
        >
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={`${itemClass} ${it.danger ? "text-critical" : ""}`}
              onClick={() => {
                setMenuOpen(false);
                it.run();
              }}
            >
              {it.label}
            </button>
          ))}
        </Menu>
      )}
    </span>
  );

  let body: ReactNode;
  if (!manage) {
    body =
      a.state === "not_linked" ? (
        <div className="flex flex-col gap-0.5">
          <p className="text-md text-ink">{t("servers.ssh.notLinked.title")}</p>
          <p className="text-xs text-ink-muted">{t("servers.ssh.notLinked.hint")}</p>
        </div>
      ) : (
        <>
          <AccessRows access={a} code={code} />
          {a.pending !== null && hasKeys && (
            <p className="text-sm text-ink-muted">{t("servers.ssh.rows.newKeys")}</p>
          )}
        </>
      );
  } else if (removal && a.state === "revoked") {
    body = (
      <RemovalStep
        code={code}
        revokedAt={a.revokedAt ?? now()}
        titleRef={removalRef}
        onDone={() => setRemoval(false)}
      />
    );
  } else if (a.state === "not_linked" || (a.state === "revoked" && relinking)) {
    body = procedure(1);
  } else if (a.state === "revoked") {
    body = (
      <>
        <AccessRows access={a} code={code} />
        <span>
          <button type="button" className={secondaryButton} onClick={() => setRelinking(true)}>
            {t("servers.ssh.linkAgain")}
          </button>
        </span>
      </>
    );
  } else if (a.state === "awaiting_command" || a.state === "regenerating") {
    body = (
      <>
        {hasKeys && <AccessRows access={a} code={code} />}
        {procedure(2)}
      </>
    );
  } else if (a.state === "verify_failed" && (!hasKeys || regenerating)) {
    body = (
      <>
        {hasKeys && <AccessRows access={a} code={code} />}
        {procedure(3)}
      </>
    );
  } else {
    // verified, read_writes, o una verifica non riuscita delle chiavi in uso.
    const success =
      a.state === "verified" && justVerified && v ? (
        <VerifyResult
          ref={resultRef}
          code={code}
          verification={v}
          summary={
            justVerified.regen ? { ok: true, text: t("servers.ssh.outcome.newInUse") } : null
          }
        />
      ) : null;
    body = (
      <>
        <AccessRows access={a} code={code} />
        {success}
        {a.state !== "verified" && (
          <div className="flex flex-col gap-3">
            {result(false)}
            <span>{verifyButton(true)}</span>
          </div>
        )}
        {showCommand && (
          <div className="ssh-step-open flex flex-col gap-3">
            <InstallStep code={code} access={a} />
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <Part id="access" title={t("servers.index.access")} action={menu || undefined}>
        <div className="flex flex-col gap-4 border-t border-rule pt-3 pl-3">
          <p className="text-md text-ink-muted">{t("servers.ssh.intro", { code })}</p>
          {body}
          {/* Le chiavi pubbliche contano solo dove c'è (o ci sarà) un comando
              d'installazione: non dopo una revoca, né sotto il comando di rimozione. */}
          {manage && a.state !== "revoked" && (
            <p className="max-w-[760px] text-xs text-ink-muted">
              {t("servers.ssh.command.publicOnly")}
            </p>
          )}
        </div>
        {confirm === "regenerate" && (
          <RegenerateDialog
            code={code}
            body={keptText(
              "regenerate.body",
              "regenerate.bodyRead",
              "regenerate.bodyFix",
              "regenerate.bodyNone",
            )}
            pending={regen.isPending}
            onConfirm={doRegenerate}
            onClose={() => setConfirm(null)}
          />
        )}
        {confirm === "revoke" && (
          <RevokeDialog
            code={code}
            pending={revoke.isPending}
            onConfirm={doRevoke}
            onClose={() => setConfirm(null)}
          />
        )}
      </Part>
      {/* Revocato non c'è niente da verificare finché non si ricollega. */}
      {manage && (a.state !== "revoked" || relinking) && (
        <SshSimulateBox
          value={next}
          onChange={(outcome) => {
            setNext(outcome);
            simulate.mutate(
              { code, outcome },
              { onError: () => toast.error(t("servers.ssh.simulate.error")) },
            );
          }}
        />
      )}
    </>
  );
}
