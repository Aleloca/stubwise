import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useCreateClaudeCodeCommand } from "../../data/queries";
import { useReauth } from "../../layout/useReauth";
import { shortcutLabel } from "../../platform/platform";
import { copyText } from "../../tasks-ui/exportFile";
import { useToast } from "../../tasks-ui/Toast";
import { BusyLabel } from "../entry/parts";
import { primaryButton, secondaryButton } from "../tasks/controls";
import { OpenCircleGlyph } from "./glyphs";
import { Part, PrefsPage, WriteError, refusalOf, rowButton } from "./parts";
import { SecretOnce } from "./SecretOnce";
import { SectionLink } from "./TokensSection";

// Preferenze → Claude Code (shape preferences-account.md): i requisiti, il
// comando d'installazione (crea un token: riconferma [PR 4]) mostrato UNA
// volta, e le quattro domande da fare a Claude, ognuna copiabile. Rifarlo
// crea un comando nuovo con un token nuovo; quello di prima vale finché non
// se ne revoca il token.

const PROMPTS = ["how", "problem", "wish", "requests"] as const;

/** Il comando in più righe, ai `&&`: si legge meglio e si incolla uguale. */
const multiline = (command: string) => command.replaceAll(" && ", " &&\n  ");

export function ClaudeCodeSection() {
  const { t } = useTranslation();
  const toast = useToast();
  const reauth = useReauth();
  const create = useCreateClaudeCodeCommand();
  const [made, setMade] = useState<{ command: string; tokenName: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const [madeBefore, setMadeBefore] = useState(false);

  async function run() {
    setFailed(false);
    try {
      const r = await reauth(() => create.mutateAsync(undefined), {
        action: t("prefs.reauth.createCommand"),
      });
      const refusal = refusalOf(r);
      if (!refusal) {
        const ok = r as { command: string; tokenName: string };
        return setMade({ command: ok.command, tokenName: ok.tokenName });
      }
      if (refusal.error !== "reauth_cancelled") setFailed(true);
    } catch {
      setFailed(true);
    }
  }

  async function copyPrompt(prompt: string) {
    try {
      await copyText(prompt);
      toast.show(t("prefs.secret.copied"));
    } catch {
      toast.error(t("prefs.secret.manual", { keys: shortcutLabel(["mod", "C"]) }));
    }
  }

  return (
    <PrefsPage title={t("prefs.sections.claude-code")} intro={t("prefs.claudeCode.intro")}>
      <Part title={t("prefs.claudeCode.before")}>
        <ul className="flex flex-col">
          <li className="flex min-h-9 items-center gap-2.5 text-md text-ink">
            <span className="text-ink-faint">
              <OpenCircleGlyph />
            </span>
            {t("prefs.claudeCode.needClaude")}
          </li>
          <li className="flex min-h-9 items-center gap-2.5 text-md text-ink">
            <span className="text-ink-faint">
              <OpenCircleGlyph />
            </span>
            {t("prefs.claudeCode.needNode")}
            <span className="text-ink-faint" aria-hidden="true">
              ·
            </span>
            {/* Nell'app vera si apre nel browser di sistema. */}
            <a
              href="https://nodejs.org"
              target="_blank"
              rel="noreferrer"
              className="text-sm text-ink underline decoration-rule-strong underline-offset-2 hover:decoration-ink"
            >
              {t("prefs.claudeCode.nodeSite")}
            </a>
          </li>
        </ul>
      </Part>

      <Part title={t("prefs.claudeCode.commandTitle")}>
        <div className="flex flex-col items-start gap-3">
          {made ? (
            <div className="w-full">
              <SecretOnce
                title={t("prefs.claudeCode.created")}
                value={multiline(made.command)}
                layout="command"
                onDone={() => {
                  setMade(null);
                  setMadeBefore(true);
                }}
              >
                <p>{t("prefs.claudeCode.shell")}</p>
                <p>
                  <Trans
                    i18nKey="prefs.claudeCode.token"
                    values={{ name: made.tokenName }}
                    components={{ link: <SectionLink section="tokens" /> }}
                  />
                </p>
              </SecretOnce>
            </div>
          ) : (
            <button
              type="button"
              className={madeBefore ? secondaryButton : primaryButton}
              aria-busy={create.isPending}
              onClick={() => void run()}
            >
              <BusyLabel
                busy={create.isPending}
                idle={madeBefore ? t("prefs.claudeCode.again") : t("prefs.claudeCode.create")}
                pending={t("prefs.claudeCode.creating")}
              />
            </button>
          )}
          {failed && (
            <WriteError message={t("prefs.claudeCode.failed")} onRetry={() => void run()} />
          )}
          {madeBefore && (
            <p className="text-sm text-ink-muted">{t("prefs.claudeCode.againNote")}</p>
          )}
        </div>
      </Part>

      <Part title={t("prefs.claudeCode.ask")}>
        <ul>
          {PROMPTS.map((p) => {
            const prompt = t(`prefs.claudeCode.prompts.${p}`);
            return (
              <li
                key={p}
                className="group flex min-h-10 items-center gap-3 border-b border-rule last:border-b-0"
              >
                <span className="min-w-0 flex-1 text-md text-ink">{prompt}</span>
                {/* «Copy» al passaggio o col fuoco; resta raggiungibile da tastiera. */}
                <button
                  type="button"
                  aria-label={t("prefs.claudeCode.copyPromptFor", { prompt })}
                  className={`${rowButton} opacity-0 group-hover:opacity-100 focus-visible:opacity-100`}
                  onClick={() => void copyPrompt(prompt)}
                >
                  {t("prefs.claudeCode.copyPrompt")}
                </button>
              </li>
            );
          })}
        </ul>
      </Part>
    </PrefsPage>
  );
}
