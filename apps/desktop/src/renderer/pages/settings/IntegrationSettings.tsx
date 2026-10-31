import { Link } from "@tanstack/react-router";
import { useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { maskedSecret } from "../../components/SecretField";
import { WhoCanLink } from "../../components/WhoCanLink";
import {
  useProjectIntegration,
  useProjectRepositories,
  useProjectSettingsAccess,
  useRegenerateIngestionKey,
  useRegenerateWebhookSecret,
  type IntegrationView,
  type RepositoryView,
} from "../../data/queries";
import type { Project } from "../../data/types";
import { useReauth } from "../../layout/useReauth";
import { formatDate } from "../../notifications/time";
import { copyText, downloadText } from "../../tasks-ui/exportFile";
import { Dialog } from "../../tasks-ui/Dialog";
import { RowsSkeleton, ReadError, rowButton, useFlash } from "../preferences/parts";
import { SecretOnce } from "../preferences/SecretOnce";
import { dangerSolidButton, secondaryButton } from "../tasks/controls";
import { SettingsFrame, useSettingsWrite } from "./SettingsFrame";
import { WebhookState } from "./repositories/WebhookRow";
import { ViewOnlyLine } from "./ViewOnly";

// Progetto → Settings → Integration (shape project-repositories.md
// «Integration»): come gli altri sistemi mandano al progetto errori ed
// eventi. La legge ogni membro. Un segreto ha una sola forma, «•••• 7c41»
// [RE 1]: DSN, snippet, autenticazione e guida arrivano dal livello dati con
// la chiave mascherata, e «Copy» copia quel testo e lo dice [RE 7]. La
// chiave e il secret di un webhook git si vedono interi una volta sola, in
// `SecretOnce` dentro il dialogo che li ha rigenerati (la mutazione vive lì:
// chiuso il dialogo, il valore non è più nel DOM né in cache). Chi può fare
// cosa lo dice la vista (`canRegenerateKey`, `gitWebhooks[].canRegenerate`)
// e `access` (la riga di sola lettura solo se non si può rigenerare niente,
// [PS 4]); i webhook git si leggono con i repository.

/** Il corpo d'esempio del webhook in arrivo, come sul web. */
const INBOUND_EXAMPLE = [
  "{",
  '  "title": "Checkout button unresponsive",',
  '  "body": "Steps to reproduce…",',
  '  "type": "bug",',
  '  "priority": "medium",',
  '  "reporterEmail": "user@example.com"',
  "}",
].join("\n");

type OpenDialog = { kind: "key" } | { kind: "secret"; repositoryId: string; name: string };

export function IntegrationSettings({ project }: { project: Project }) {
  const { t } = useTranslation();
  const access = useProjectSettingsAccess(project.id);
  const integration = useProjectIntegration(project.id);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const code = project.code;

  return (
    <SettingsFrame
      title={t("settings.sections.integration")}
      intro={t("settings.integration.intro", { code })}
    >
      {!access.integration.canEdit && access.integration.editAction && (
        <ViewOnlyLine action={access.integration.editAction} projectId={project.id} code={code} />
      )}
      {integration.isPending ? (
        <RowsSkeleton parts={4} />
      ) : integration.isError || !integration.data ? (
        <ReadError
          message={t("settings.integration.loadError", { code })}
          onRetry={() => void integration.refetch()}
        />
      ) : (
        <>
          <KeyPart
            project={project}
            view={integration.data}
            onRegenerate={() => setDialog({ kind: "key" })}
          />
          <InboundPart code={code} view={integration.data} />
          {access.repositories.visible && (
            <GitPart
              project={project}
              view={integration.data}
              onRegenerate={(repositoryId, name) =>
                setDialog({ kind: "secret", repositoryId, name })
              }
            />
          )}
          <GuidePart code={code} guide={integration.data.guide} />
        </>
      )}
      {dialog?.kind === "key" && (
        <RegenerateKeyDialog
          project={project}
          onReload={() => void integration.refetch()}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "secret" && (
        <RegenerateSecretDialog
          project={project}
          repositoryId={dialog.repositoryId}
          name={dialog.name}
          onReload={() => void integration.refetch()}
          onClose={() => setDialog(null)}
        />
      )}
    </SettingsFrame>
  );
}

/** Una parte della pagina: la testata `heading-group` e il contenuto. */
function Part({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="@container mt-10 first:mt-2">
      <h2 id={id} className="heading-group border-b border-rule pb-2">
        {title}
      </h2>
      <div className="flex flex-col gap-4 pt-4">{children}</div>
    </section>
  );
}

/**
 * Un bottone spento con la sua frase e «Who?» (lezione del 9b): la frase sta
 * sotto e il bottone la legge (`aria-describedby`).
 */
function GuardedButton({
  label,
  enabled,
  why,
  action,
  project,
  onClick,
}: {
  label: string;
  enabled: boolean;
  why: string;
  action: string;
  project: Project;
  onClick: () => void;
}) {
  const whyId = useId();
  return (
    <span className="flex shrink-0 flex-col items-end gap-1">
      <span className="flex items-center gap-2">
        {!enabled && (
          <WhoCanLink action={action} projectId={project.id} projectCode={project.code} />
        )}
        <button
          type="button"
          aria-disabled={!enabled || undefined}
          aria-describedby={enabled ? undefined : whyId}
          onClick={() => enabled && onClick()}
          className={`${secondaryButton} aria-disabled:cursor-not-allowed aria-disabled:opacity-40`}
        >
          {label}
        </button>
      </span>
      {!enabled && (
        <span id={whyId} className="max-w-[44ch] text-right text-xs text-pretty text-ink-muted">
          {why}
        </span>
      )}
    </span>
  );
}

/**
 * Un blocco di codice con «Copy» sopra a destra; il testo va a capo dentro il
 * blocco, mai uno scorrimento orizzontale della pagina. `onCopied` dice alla
 * parte di mostrare la sua frase.
 */
function CopyBlock({
  label,
  copyLabel,
  text,
  multiline = false,
  onCopied,
}: {
  label: string;
  copyLabel: string;
  text: string;
  multiline?: boolean;
  /**
   * Un testo con la chiave mascherata: la parte dice «Copied, with the key
   * hidden.» sotto i blocchi. Senza, il bottone stesso dice «Copied» per 2 s.
   */
  onCopied?: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLElement>(null);
  const [copied, flash] = useFlash();
  const labelId = useId();

  async function copy() {
    try {
      await copyText(text);
      if (onCopied) onCopied();
      else flash();
    } catch {
      // Senza appunti il testo si seleziona: si copia a mano.
      const el = ref.current;
      const selection = window.getSelection();
      if (!el || !selection) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-end justify-between gap-3">
        <span id={labelId} className="text-sm font-medium text-ink">
          {label}
        </span>
        <button
          type="button"
          aria-label={copied ? t("settings.integration.copiedPlain") : copyLabel}
          onClick={() => void copy()}
          className={`${rowButton} text-ink`}
        >
          {copied ? t("settings.integration.copiedPlain") : t("settings.integration.copy")}
        </button>
      </div>
      <pre
        aria-labelledby={labelId}
        className="min-w-0 rounded-md border border-rule bg-ink/4 px-3 py-2.5 text-ink"
      >
        <code
          ref={ref}
          className={`font-code block [font-size:13px] leading-5 ${
            multiline
              ? "whitespace-pre-wrap [overflow-wrap:anywhere]"
              : "break-all whitespace-pre-wrap"
          }`}
        >
          {text}
        </code>
      </pre>
    </div>
  );
}

/** «Copied, with the key hidden.» per 2 s, sotto la frase dei «Copy» mascherati, letta con garbo. */
function CopiedNote({ on }: { on: boolean }) {
  const { t } = useTranslation();
  return (
    <p role="status" className="min-h-4 text-xs text-ink">
      {on ? t("settings.integration.copied") : ""}
    </p>
  );
}

function KeyPart({
  project,
  view,
  onRegenerate,
}: {
  project: Project;
  view: IntegrationView;
  onRegenerate: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [copied, flash] = useFlash();
  const { ingestion } = view;
  const date = formatDate(ingestion.createdAt, i18n.language);
  return (
    <Part title={t("settings.integration.key.title")}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 pt-1.5 text-md text-ink">
          <span className="num font-code">{maskedSecret(ingestion.last4)}</span>
          <span aria-hidden="true" className="text-ink-faint">
            ·
          </span>
          <span className="num text-sm text-ink-muted">
            {ingestion.createdBy
              ? t("settings.integration.key.madeBy", { date, name: ingestion.createdBy.name })
              : t("settings.integration.key.made", { date })}
          </span>
        </p>
        <GuardedButton
          label={t("settings.integration.key.regenerate")}
          enabled={view.canRegenerateKey}
          why={t("settings.integration.key.readOnly", { code: project.code })}
          action="manageProjectSettings"
          project={project}
          onClick={onRegenerate}
        />
      </div>
      <CopyBlock
        label={t("settings.integration.key.dsn")}
        copyLabel={t("settings.integration.key.copyDsn")}
        text={ingestion.maskedDsn}
        onCopied={flash}
      />
      <CopyBlock
        label={t("settings.integration.key.snippet")}
        copyLabel={t("settings.integration.key.copySnippet")}
        text={ingestion.maskedSnippet}
        multiline
        onCopied={flash}
      />
      <div className="flex flex-col gap-1">
        <p className="max-w-[72ch] text-xs text-pretty text-ink-muted">
          {t("settings.integration.maskedNote")}
        </p>
        <CopiedNote on={copied} />
      </div>
    </Part>
  );
}

function InboundPart({ code, view }: { code: string; view: IntegrationView }) {
  const { t } = useTranslation();
  return (
    <Part title={t("settings.integration.inbound.title")}>
      <p className="max-w-[72ch] text-sm text-pretty text-ink-muted">
        {t("settings.integration.inbound.body", { code })}
      </p>
      <CopyBlock
        label={t("settings.integration.inbound.address")}
        copyLabel={t("settings.integration.inbound.copyAddress")}
        text={view.inbound.url}
      />
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-ink">
          {t("settings.integration.inbound.auth")}
        </span>
        <p className="text-md text-ink">
          <span className="num font-code">
            {t("settings.integration.inbound.authValue", { auth: view.inbound.auth })}
          </span>{" "}
          <span className="text-sm text-ink-muted">
            {t("settings.integration.inbound.authNote")}
          </span>
        </p>
      </div>
      <CopyBlock
        label={t("settings.integration.inbound.example")}
        copyLabel={t("settings.integration.inbound.copyExample")}
        text={INBOUND_EXAMPLE}
        multiline
      />
    </Part>
  );
}

function GitPart({
  project,
  view,
  onRegenerate,
}: {
  project: Project;
  view: IntegrationView;
  onRegenerate: (repositoryId: string, name: string) => void;
}) {
  const { t } = useTranslation();
  // Lo stato del webhook di ogni repository, letto dove lo legge Repositories.
  const states = new Map(
    (useProjectRepositories(project.id).data?.repositories ?? []).map((r) => [
      r.id,
      r.webhook.state,
    ]),
  );
  return (
    <Part title={t("settings.integration.git.title")}>
      <p className="max-w-[72ch] text-sm text-pretty text-ink-muted">
        {t("settings.integration.git.body")}
      </p>
      {view.gitWebhooks.length === 0 ? (
        <p className="text-sm text-ink-muted">
          {t("settings.integration.git.none", { code: project.code })}{" "}
          <Link
            to="/p/$code/settings/$section"
            params={{ code: project.code, section: "repositories" }}
            className="text-ink underline underline-offset-4"
          >
            {t("settings.integration.git.noneLink")}
          </Link>
        </p>
      ) : (
        <ul className="border-t border-rule">
          {view.gitWebhooks.map((w) => (
            <GitWebhookRow
              key={w.repositoryId}
              project={project}
              webhook={w}
              state={states.get(w.repositoryId) ?? null}
              onRegenerate={() => onRegenerate(w.repositoryId, w.name)}
            />
          ))}
        </ul>
      )}
    </Part>
  );
}

/**
 * Un repository (due righe): nome 600 · stato del webhook, a destra
 * «Regenerate secret…»; sotto l'indirizzo in codice con «Copy» e il secret
 * «•••• 9c0d» o «No secret yet».
 */
function GitWebhookRow({
  project,
  webhook: w,
  state,
  onRegenerate,
}: {
  project: Project;
  webhook: IntegrationView["gitWebhooks"][number];
  state: RepositoryView["webhook"]["state"] | null;
  onRegenerate: () => void;
}) {
  const { t } = useTranslation();
  const [copied, flash] = useFlash();
  return (
    <li aria-label={w.name} className="flex flex-col gap-1.5 border-b border-rule py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pt-1.5">
          <span className="truncate text-md font-semibold text-ink" title={w.name}>
            {w.name}
          </span>
          {state && <WebhookState state={state} />}
        </p>
        <GuardedButton
          label={t("settings.integration.git.regenerate")}
          enabled={w.canRegenerate}
          why={t("settings.integration.git.readOnly", { code: project.code })}
          action="manageRepos"
          project={project}
          onClick={onRegenerate}
        />
      </div>
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <code className="min-w-0 font-code text-ink [overflow-wrap:anywhere]">{w.url}</code>
        <button
          type="button"
          aria-label={
            copied
              ? t("settings.integration.copiedPlain")
              : t("settings.integration.git.copyAddress", { name: w.name })
          }
          onClick={() =>
            void copyText(w.url)
              .then(flash)
              .catch(() => undefined)
          }
          className={`${rowButton} text-ink`}
        >
          {copied ? t("settings.integration.copiedPlain") : t("settings.integration.copy")}
        </button>
        <span aria-hidden="true" className="text-ink-faint">
          ·
        </span>
        <span className="text-ink-muted">{t("settings.integration.git.secret")}</span>
        {w.secretLast4 ? (
          <span className="num font-code text-ink">{maskedSecret(w.secretLast4)}</span>
        ) : (
          <span className="text-ink-muted">{t("settings.integration.git.noSecret")}</span>
        )}
      </p>
    </li>
  );
}

function GuidePart({ code, guide }: { code: string; guide: string }) {
  const { t } = useTranslation();
  const [copied, flash] = useFlash();
  return (
    <Part title={t("settings.integration.guide.title")}>
      <p className="max-w-[72ch] text-sm text-pretty text-ink-muted">
        {t("settings.integration.guide.body", { code })}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={secondaryButton}
          onClick={() =>
            void copyText(guide)
              .then(flash)
              .catch(() => undefined)
          }
        >
          {t("settings.integration.guide.copy")}
        </button>
        <button
          type="button"
          className={secondaryButton}
          onClick={() => downloadText(`stubwise-sdk-${code.toLowerCase()}.md`, guide)}
        >
          {t("settings.integration.guide.save")}
        </button>
      </div>
      <div className="flex flex-col gap-1">
        <p className="max-w-[72ch] text-xs text-pretty text-ink-muted">
          {t("settings.integration.maskedNote")}
        </p>
        <CopiedNote on={copied} />
      </div>
    </Part>
  );
}

/** Le conseguenze dette prima, una per riga. */
function Consequences({ lines }: { lines: string[] }) {
  return (
    <ul className="flex flex-col gap-2 text-sm text-pretty text-ink">
      {lines.map((line) => (
        <li key={line} className="flex items-start gap-2">
          <span aria-hidden="true" className="mt-[7px] size-1 shrink-0 rounded-full bg-ink-muted" />
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );
}

function RegenerateKeyDialog({
  project,
  onReload,
  onClose,
}: {
  project: Project;
  onReload: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const reauth = useReauth();
  const regenerate = useRegenerateIngestionKey();
  const write = useSettingsWrite(project.code, onReload);
  const [busy, setBusy] = useState(false);
  // Il valore vive solo qui: «Done» chiude il dialogo e lo butta.
  const [secret, setSecret] = useState<{ key: string; dsn: string; snippet: string } | null>(null);
  const code = project.code;

  async function submit() {
    if (busy) return;
    setBusy(true);
    await write.run(
      () =>
        reauth(() => regenerate.mutateAsync(project.id), {
          action: t("settings.integration.regenerateKey.reauthAction", { code }),
        }),
      () => undefined,
      (r) => {
        if (r.ok) setSecret({ key: r.key, dsn: r.dsn, snippet: r.snippet });
      },
    );
    setBusy(false);
  }

  return (
    <Dialog
      title={t("settings.integration.regenerateKey.title", { code })}
      onClose={onClose}
      width={480}
      footer={
        secret ? undefined : (
          <>
            <button type="button" className={secondaryButton} onClick={onClose}>
              {t("settings.integration.regenerateKey.cancel")}
            </button>
            <button
              type="button"
              aria-disabled={busy || undefined}
              className={dangerSolidButton}
              onClick={() => void submit()}
            >
              {busy
                ? t("settings.integration.regenerateKey.regenerating")
                : t("settings.integration.regenerateKey.regenerate")}
            </button>
          </>
        )
      }
    >
      {secret ? (
        <SecretOnce
          title={t("settings.integration.regenerateKey.secretTitle")}
          label={t("settings.integration.regenerateKey.keyLabel")}
          value={secret.key}
          more={[
            { label: t("settings.integration.key.dsn"), value: secret.dsn },
            {
              label: t("settings.integration.key.snippet"),
              value: secret.snippet,
              layout: "code",
            },
          ]}
          onDone={onClose}
        />
      ) : (
        <>
          <Consequences
            lines={[
              t("settings.integration.regenerateKey.stops"),
              t("settings.integration.regenerateKey.everyApp", { code }),
              t("settings.integration.regenerateKey.once"),
            ]}
          />
          {write.message}
        </>
      )}
    </Dialog>
  );
}

function RegenerateSecretDialog({
  project,
  repositoryId,
  name,
  onReload,
  onClose,
}: {
  project: Project;
  repositoryId: string;
  name: string;
  onReload: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const reauth = useReauth();
  const regenerate = useRegenerateWebhookSecret();
  const write = useSettingsWrite(project.code, onReload);
  // La piattaforma del repository, per la frase («Bitbucket's pushes…»).
  const provider = useProjectRepositories(project.id).data?.repositories.find(
    (r) => r.id === repositoryId,
  )?.provider;
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    setBusy(true);
    await write.run(
      () =>
        reauth(() => regenerate.mutateAsync(repositoryId), {
          action: t("settings.integration.regenerateSecret.reauthAction", { name }),
        }),
      () => undefined,
      (r) => {
        if (r.ok) setSecret(r.secret);
      },
    );
    setBusy(false);
  }

  return (
    <Dialog
      title={t("settings.integration.regenerateSecret.title", { name })}
      onClose={onClose}
      width={480}
      footer={
        secret ? undefined : (
          <>
            <button type="button" className={secondaryButton} onClick={onClose}>
              {t("settings.integration.regenerateKey.cancel")}
            </button>
            <button
              type="button"
              aria-disabled={busy || undefined}
              className={dangerSolidButton}
              onClick={() => void submit()}
            >
              {busy
                ? t("settings.integration.regenerateKey.regenerating")
                : t("settings.integration.regenerateKey.regenerate")}
            </button>
          </>
        )
      }
    >
      {secret ? (
        <SecretOnce
          title={t("settings.integration.regenerateSecret.secretTitle")}
          label={t("settings.integration.regenerateSecret.secretLabel")}
          value={secret}
          onDone={onClose}
        />
      ) : (
        <>
          <p className="text-sm text-pretty text-ink">
            {t("settings.integration.regenerateSecret.body", {
              platform: provider
                ? t(`settings.repos.platforms.${provider}`)
                : t("settings.integration.regenerateSecret.platformFallback"),
            })}
          </p>
          {write.message}
        </>
      )}
    </Dialog>
  );
}
