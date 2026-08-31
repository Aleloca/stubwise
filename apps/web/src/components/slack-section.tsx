import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { putInstanceSettings, type InstanceSettingsPatch } from "../lib/api";
import { instanceSettingsQueryOptions } from "../lib/queries";
import { FormError, SubmitButton, TextField } from "./field";

/**
 * Sezione "Slack" delle impostazioni (solo admin): configura le credenziali
 * usate per l'ingestion via slash command e messaggi interattivi. Entrambi i
 * segreti (signing secret + bot token) sono write-only — il server non li
 * restituisce mai, quindi mostriamo solo se sono impostati e i campi restano
 * vuoti.
 *
 * UX azzeramento: lasciare un campo VUOTO significa "non modificare" (il
 * segreto esistente resta). Per RIMUOVERE un segreto salvato si spunta la
 * relativa casella "Remove": coerente con la semantica del server (campo "" →
 * azzera; assente → invariato).
 */
export function SlackSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: instance } = useSuspenseQuery(instanceSettingsQueryOptions);

  const [signingSecret, setSigningSecret] = useState("");
  const [removeSigningSecret, setRemoveSigningSecret] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [removeBotToken, setRemoveBotToken] = useState(false);

  // Riallinea il form quando arriva uno stato nuovo (dopo un salvataggio o un
  // refetch). I segreti restano sempre vuoti: non tornano mai dal server.
  useEffect(() => {
    setSigningSecret("");
    setRemoveSigningSecret(false);
    setBotToken("");
    setRemoveBotToken(false);
  }, [instance]);

  const mutation = useMutation({
    mutationFn: (patch: InstanceSettingsPatch) => putInstanceSettings(patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(instanceSettingsQueryOptions.queryKey, updated);
    },
  });

  // URL delle request da inserire nella config della Slack app: origin corrente
  // (in prod = host pubblico) + i path degli endpoint Slack.
  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://stubwise.example.com";
  const commandsUrl = `${origin}/api/slack/commands`;
  const interactionsUrl = `${origin}/api/slack/interactions`;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    // contentLanguage e monthlyBudgetUsd: il PUT del server li riscrive, quindi
    // si rinviano invariati per non azzerarli.
    const patch: InstanceSettingsPatch = {
      contentLanguage: instance.contentLanguage,
      monthlyBudgetUsd: instance.monthlyBudgetUsd,
    };
    // Per ciascun segreto: "rimuovi" esplicito → ""; valore digitato → aggiorna;
    // vuoto senza rimozione → campo OMESSO (il segreto esistente resta intatto).
    if (removeSigningSecret) {
      patch.slackSigningSecret = "";
    } else if (signingSecret !== "") {
      patch.slackSigningSecret = signingSecret;
    }
    if (removeBotToken) {
      patch.slackBotToken = "";
    } else if (botToken !== "") {
      patch.slackBotToken = botToken;
    }
    mutation.mutate(patch);
  }

  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <header className="border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
            {t("settings:slack.title")}
          </h2>
          <span
            className={`rounded-sm border px-2 py-0.5 font-mono text-[11px] tracking-[0.08em] uppercase ${
              instance.slackEnabled ? "border-ok/40 text-ok" : "border-line-strong text-fg-faint"
            }`}
          >
            {instance.slackEnabled
              ? t("settings:slack.enabledBadge")
              : t("settings:slack.disabledBadge")}
          </span>
        </div>
        <p className="mt-1 font-mono text-[11px] text-fg-faint">{t("settings:slack.subtitle")}</p>
      </header>

      <form onSubmit={handleSubmit} className="space-y-4 px-4 py-4" noValidate>
        <div className="flex flex-col gap-1.5">
          <TextField
            id="slack-signing-secret"
            type="password"
            label={t("settings:slack.signingSecret")}
            placeholder={
              instance.slackSigningSecretSet
                ? t("settings:slack.secretSetPlaceholder")
                : t("settings:slack.secretPlaceholder")
            }
            value={signingSecret}
            disabled={mutation.isPending || removeSigningSecret}
            onChange={(event) => setSigningSecret(event.target.value)}
          />
          {instance.slackSigningSecretSet && (
            <label className="flex items-center gap-2 font-mono text-[11px] text-fg-muted">
              <input
                type="checkbox"
                checked={removeSigningSecret}
                disabled={mutation.isPending}
                onChange={(event) => setRemoveSigningSecret(event.target.checked)}
                className="size-4 accent-signal"
              />
              {t("settings:slack.removeSigningSecret")}
            </label>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <TextField
            id="slack-bot-token"
            type="password"
            label={t("settings:slack.botToken")}
            placeholder={
              instance.slackBotTokenSet
                ? t("settings:slack.secretSetPlaceholder")
                : t("settings:slack.secretPlaceholder")
            }
            value={botToken}
            disabled={mutation.isPending || removeBotToken}
            onChange={(event) => setBotToken(event.target.value)}
          />
          {instance.slackBotTokenSet && (
            <label className="flex items-center gap-2 font-mono text-[11px] text-fg-muted">
              <input
                type="checkbox"
                checked={removeBotToken}
                disabled={mutation.isPending}
                onChange={(event) => setRemoveBotToken(event.target.checked)}
                className="size-4 accent-signal"
              />
              {t("settings:slack.removeBotToken")}
            </label>
          )}
          <p className="font-mono text-[11px] text-fg-faint">{t("settings:slack.secretHint")}</p>
        </div>

        <p className="font-mono text-[11px] leading-relaxed text-fg-faint">
          {t("settings:slack.setupHint", { commandsUrl, interactionsUrl })}
        </p>

        {/* Gli scope chat:write/im:write servono SOLO alle notifiche in DM: la
            riga spiega a cosa li si aggiunge e ricorda che su un'app esistente
            la reinstallazione cambia il bot token (va risalvato qui sopra). */}
        <p className="font-mono text-[11px] leading-relaxed text-fg-faint">
          {t("settings:slack.dmHint")}
        </p>

        <FormError message={mutation.error instanceof Error ? mutation.error.message : null} />
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton pending={mutation.isPending}>
            {mutation.isPending ? t("settings:slack.saving") : t("settings:slack.save")}
          </SubmitButton>
          {mutation.isSuccess && (
            <span role="status" className="font-mono text-[12px] text-ok">
              {t("settings:slack.saved")}
            </span>
          )}
        </div>
      </form>
    </section>
  );
}
