import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FormError, SubmitButton } from "../../components/field";
import { createPat, type PatWithToken } from "../../lib/api";
import { patsQueryOptions } from "../../lib/queries";
import { translateApiError } from "../../lib/translate-api-error";
import { useCopyWithFallback } from "../../lib/use-copy-with-fallback";

/** Nome del token che la pagina crea: lo si riconosce poi nell'elenco dei token. */
const TOKEN_NAME = "Claude Code";

/**
 * Il comando unico che installa il plugin dal marketplace del repo e configura
 * il server MCP (`setup` scrive url e token in un file di configurazione).
 * Pura: l'URL è quello da cui si serve la SPA, il token è quello appena creato.
 *
 * L'ORDINE conta: `setup` gira per ultimo perché accende l'aggiornamento
 * automatico sulla voce `stubwise` che `marketplace add` scrive nelle
 * impostazioni di Claude Code — e un `marketplace add` rilanciato riscrive
 * quella voce togliendo `autoUpdate` (provato col CLI 2.1.304). Rilanciare
 * l'intero comando è sicuro: con il marketplace e il plugin già presenti
 * `marketplace add` e `plugin install` escono con 0, quindi la catena con
 * `&&` (bash, zsh e PowerShell 7) arriva comunque a `setup`.
 *
 * `setup` gira come `@stubwise/mcp@latest`, non senza tag e non con un numero
 * esatto. Senza tag `npx` può riusare una copia in cache (per esempio una
 * 0.9.0, che non accende l'aggiornamento automatico); un numero esatto non va
 * bene perché la SPA può essere deployata prima che quella versione sia
 * pubblicata su npm. Il pin esatto vive solo in `plugins/stubwise/.mcp.json`.
 */
export function buildInstallCommand(url: string, token: string): string {
  return `claude plugin marketplace add Aleloca/stubwise --sparse .claude-plugin plugins && claude plugin install stubwise@stubwise && npx -y @stubwise/mcp@latest setup --url ${url} --token ${token}`;
}

const PROMPT_KEYS = ["how", "problem", "wish", "requests"] as const;

/**
 * Sotto-pagina "Claude Code" (visibile a ogni utente): crea un PAT e mostra,
 * una volta sola, il comando da incollare nel terminale. Il token vive solo
 * nello stato del componente, come nella pagina dei token di accesso.
 */
export function SettingsClaudeCodePage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [created, setCreated] = useState<PatWithToken | null>(null);

  const mutation = useMutation({
    mutationFn: () => createPat(TOKEN_NAME, null),
    onSuccess: async (pat) => {
      await queryClient.invalidateQueries({ queryKey: patsQueryOptions.queryKey });
      setCreated(pat);
    },
  });

  return (
    <div className="space-y-6">
      <section className="rounded-sm border border-line bg-ink-900">
        <header className="border-b border-line px-4 py-3">
          <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
            {t("settings:claudeCode.title")}
          </h2>
        </header>
        <div className="space-y-4 px-4 py-4">
          <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-fg-muted">
            <li>{t("settings:claudeCode.needClaude")}</li>
            <li>
              {t("settings:claudeCode.needNode")}{" "}
              <a
                href="https://nodejs.org"
                target="_blank"
                rel="noreferrer"
                className="text-signal underline"
              >
                nodejs.org
              </a>
            </li>
            <li>{t("settings:claudeCode.shell")}</li>
            <li>{t("settings:claudeCode.onlyOnce")}</li>
          </ul>
          {created ? (
            <CommandPanel pat={created} onDone={() => setCreated(null)} />
          ) : (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                mutation.mutate();
              }}
            >
              <FormError message={mutation.error ? translateApiError(mutation.error, t) : null} />
              <SubmitButton pending={mutation.isPending}>
                {mutation.isPending
                  ? t("settings:claudeCode.creating")
                  : t("settings:claudeCode.create")}
              </SubmitButton>
            </form>
          )}
        </div>
      </section>

      <section className="rounded-sm border border-line bg-ink-900">
        <header className="border-b border-line px-4 py-3">
          <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
            {t("settings:claudeCode.askTitle")}
          </h2>
        </header>
        <ul className="space-y-2 px-4 py-4 font-mono text-[13px] text-fg">
          {PROMPT_KEYS.map((key) => (
            <li key={key}>{t(`settings:claudeCode.prompts.${key}`)}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** Il comando in chiaro (una volta sola) col pulsante copia. */
function CommandPanel({ pat, onDone }: { pat: PatWithToken; onDone: () => void }) {
  const { t } = useTranslation();
  const command = buildInstallCommand(window.location.origin, pat.token);
  const { copied, manualHint, copy, targetRef } = useCopyWithFallback(command);

  return (
    <div className="space-y-3">
      <pre
        ref={targetRef}
        className="overflow-x-auto rounded-sm border border-line-strong bg-ink-950/70 px-3 py-3 font-mono text-[13px] leading-relaxed break-all whitespace-pre-wrap text-fg"
      >
        {command}
      </pre>
      <p role="alert" className="font-mono text-[12px] text-signal">
        {t("settings:claudeCode.warning")}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={copy}
          className="rounded-sm bg-signal px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim"
        >
          {copied ? t("common:copied") : t("common:copy")}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-sm border border-line-strong px-3 py-2 font-mono text-[12px] font-medium tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg"
        >
          {t("settings:accessTokens.done")}
        </button>
      </div>
      {manualHint && (
        <p role="status" className="font-mono text-[12px] text-fg-muted">
          {t("settings:claudeCode.copyManualHint")}
        </p>
      )}
    </div>
  );
}
