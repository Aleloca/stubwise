import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "../../tasks-ui/Dialog";
import { useToast } from "../../tasks-ui/Toast";
import { primaryButton, secondaryButton } from "../tasks/controls";
import { CopyGlyph } from "./glyphs";

// Il pannello della chiave dell'agente (shape servers.md, «New server e
// chiave dell'agente»): la chiave `sk_…` si vede UNA volta sola, alla
// creazione o alla rigenerazione. Vive solo nello stato di questo
// componente: chiuso il pannello non resta da nessuna parte (il livello
// dati non la conserva). Chiudere senza averla copiata chiede conferma.

/** L'indirizzo dell'istanza nel prototipo non è noto: un segnaposto che lo dice. */
const INSTANCE_URL = "https://stubwise.example";

/** Il comando che installa l'agente sul server (come il web, `dockerRunCommand`). */
export function agentCommand(key: string): string {
  return [
    "docker run -d --name stubwise-agent --restart unless-stopped --user 0 \\",
    '  --group-add "$(stat -c %g /var/run/docker.sock)" \\',
    "  -v /proc:/host/proc:ro -v /sys:/host/sys:ro -v /:/host/root:ro \\",
    "  -v /var/run/docker.sock:/var/run/docker.sock:ro \\",
    `  -e STUBWISE_URL=${INSTANCE_URL} -e STUBWISE_SERVER_KEY=${key} \\`,
    "  alelocadev/stubwise-agent",
  ].join("\n");
}

const copyButton =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-rule-strong px-3 text-sm font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 active:bg-ink/10";

export function AgentKeyDialog({
  title,
  code,
  agentKey,
  onDone,
}: {
  title: string;
  code: string;
  agentKey: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const keyId = useId();
  const [copied, setCopied] = useState<"key" | "command" | null>(null);
  const [asking, setAsking] = useState(false);
  const command = agentCommand(agentKey);

  const copy = (what: "key" | "command", text: string) => {
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      toast.error(t("servers.key.copyError"));
      return;
    }
    void clipboard.writeText(text).then(
      () => setCopied(what),
      () => toast.error(t("servers.key.copyError")),
    );
  };
  const done = () => (copied ? onDone() : setAsking(true));
  const discard = {
    message: t("servers.key.closeWithout"),
    keep: t("servers.key.keepOpen"),
    discard: t("servers.key.closeAnyway"),
  };

  return (
    <Dialog
      title={title}
      width={560}
      onClose={onDone}
      confirmDiscard={copied ? undefined : discard}
      footer={
        asking ? (
          <div
            role="group"
            aria-label={discard.message}
            className="flex w-full flex-wrap items-center gap-2"
          >
            <p className="min-w-0 flex-1 basis-56 text-sm text-ink">{discard.message}</p>
            {/* La domanda prende il fuoco, come quella del dialogo. */}
            <button
              type="button"
              autoFocus
              className={secondaryButton}
              onClick={() => setAsking(false)}
            >
              {discard.keep}
            </button>
            <button type="button" className={primaryButton} onClick={onDone}>
              {discard.discard}
            </button>
          </div>
        ) : (
          <button type="button" data-key-done className={primaryButton} onClick={done}>
            {t("servers.key.done")}
          </button>
        )
      }
    >
      <p className="text-md font-semibold text-ink">{t("servers.key.shownOnce")}</p>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={keyId} className="text-sm font-medium text-ink">
          {t("servers.key.label")}
        </label>
        <div className="flex items-center gap-2">
          <input
            id={keyId}
            readOnly
            value={agentKey}
            data-agent-key
            onFocus={(e) => e.currentTarget.select()}
            className="num h-8 w-full min-w-0 rounded-md border border-rule-strong bg-ink/4 px-2.5 font-mono text-sm text-ink"
          />
          <button
            type="button"
            data-autofocus
            className={copyButton}
            aria-label={t("servers.key.copyKey")}
            onClick={() => copy("key", agentKey)}
          >
            <CopyGlyph />
            {copied === "key" ? t("servers.key.copied") : t("servers.key.copy")}
          </button>
        </div>
        <p className="text-xs text-ink-faint">{t("servers.key.prototype")}</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-end gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm font-medium text-ink">{t("servers.key.command")}</span>
            <span className="text-xs text-ink-muted">{t("servers.key.commandHint", { code })}</span>
          </div>
          <button
            type="button"
            className={copyButton}
            aria-label={t("servers.key.copyCommand")}
            onClick={() => copy("command", command)}
          >
            <CopyGlyph />
            {copied === "command" ? t("servers.key.copied") : t("servers.key.copy")}
          </button>
        </div>
        <pre className="max-h-48 overflow-auto rounded-md border border-rule bg-ink/4 px-3 py-2 font-mono text-xs leading-5 whitespace-pre text-ink">
          {command}
        </pre>
      </div>
    </Dialog>
  );
}
