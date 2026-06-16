import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { putInstanceSettings, type InstanceSettingsPatch } from "../lib/api";
import { instanceSettingsQueryOptions } from "../lib/queries";
import { FormError, SubmitButton, TextField } from "./field";

/**
 * Sezione "Storage (S3)" delle impostazioni (solo admin): configura il bucket
 * S3-compatibile usato per gli allegati. I campi non-secret (endpoint, region,
 * bucket, access key) sono prepopolati dallo stato salvato; la secret è
 * write-only — il server non la restituisce mai, quindi mostriamo solo se è
 * impostata e il campo resta vuoto.
 *
 * UX azzeramento secret: lasciare il campo secret VUOTO significa "non
 * modificare" (la secret esistente resta). Per RIMUOVERE la secret salvata si
 * spunta esplicitamente "Remove stored secret": coerente con la semantica del
 * server (s3SecretKey "" → azzera; assente → invariata).
 */
export function StorageSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: instance } = useSuspenseQuery(instanceSettingsQueryOptions);

  const [endpoint, setEndpoint] = useState(instance.s3Endpoint ?? "");
  const [region, setRegion] = useState(instance.s3Region ?? "");
  const [bucket, setBucket] = useState(instance.s3Bucket ?? "");
  const [accessKey, setAccessKey] = useState(instance.s3AccessKey ?? "");
  const [secret, setSecret] = useState("");
  const [removeSecret, setRemoveSecret] = useState(false);

  // Riallinea il form quando arriva uno stato nuovo (dopo un salvataggio o un
  // refetch). La secret resta sempre vuota: non torna mai dal server.
  useEffect(() => {
    setEndpoint(instance.s3Endpoint ?? "");
    setRegion(instance.s3Region ?? "");
    setBucket(instance.s3Bucket ?? "");
    setAccessKey(instance.s3AccessKey ?? "");
    setSecret("");
    setRemoveSecret(false);
  }, [instance]);

  const mutation = useMutation({
    mutationFn: (patch: InstanceSettingsPatch) => putInstanceSettings(patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(instanceSettingsQueryOptions.queryKey, updated);
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    // contentLanguage e monthlyBudgetUsd: il PUT del server li riscrive, quindi
    // si rinviano invariati per non azzerarli.
    const patch: InstanceSettingsPatch = {
      contentLanguage: instance.contentLanguage,
      monthlyBudgetUsd: instance.monthlyBudgetUsd,
      s3Endpoint: endpoint,
      s3Region: region,
      s3Bucket: bucket,
      s3AccessKey: accessKey,
    };
    // Secret: "rimuovi" esplicito → ""; valore digitato → aggiorna; vuoto senza
    // rimozione → campo OMESSO (la secret esistente resta intatta).
    if (removeSecret) {
      patch.s3SecretKey = "";
    } else if (secret !== "") {
      patch.s3SecretKey = secret;
    }
    mutation.mutate(patch);
  }

  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <header className="border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
            {t("settings:storage.title")}
          </h2>
          <span
            className={`rounded-sm border px-2 py-0.5 font-mono text-[11px] tracking-[0.08em] uppercase ${
              instance.attachmentsEnabled
                ? "border-ok/40 text-ok"
                : "border-line-strong text-fg-faint"
            }`}
          >
            {instance.attachmentsEnabled
              ? t("settings:storage.enabledBadge")
              : t("settings:storage.disabledBadge")}
          </span>
        </div>
        <p className="mt-1 font-mono text-[11px] text-fg-faint">{t("settings:storage.subtitle")}</p>
      </header>

      <form onSubmit={handleSubmit} className="space-y-4 px-4 py-4" noValidate>
        <TextField
          id="s3-endpoint"
          label={t("settings:storage.endpoint")}
          placeholder="https://s3.eu-central-1.example.com"
          value={endpoint}
          disabled={mutation.isPending}
          onChange={(event) => setEndpoint(event.target.value)}
        />
        <TextField
          id="s3-region"
          label={t("settings:storage.region")}
          placeholder="auto"
          value={region}
          disabled={mutation.isPending}
          onChange={(event) => setRegion(event.target.value)}
        />
        <TextField
          id="s3-bucket"
          label={t("settings:storage.bucket")}
          placeholder="stubwise-attachments"
          value={bucket}
          disabled={mutation.isPending}
          onChange={(event) => setBucket(event.target.value)}
        />
        <TextField
          id="s3-access-key"
          label={t("settings:storage.accessKey")}
          value={accessKey}
          disabled={mutation.isPending}
          onChange={(event) => setAccessKey(event.target.value)}
        />
        <div className="flex flex-col gap-1.5">
          <TextField
            id="s3-secret-key"
            type="password"
            label={t("settings:storage.secretKey")}
            placeholder={
              instance.s3SecretKeySet
                ? t("settings:storage.secretSetPlaceholder")
                : t("settings:storage.secretPlaceholder")
            }
            value={secret}
            disabled={mutation.isPending || removeSecret}
            onChange={(event) => setSecret(event.target.value)}
          />
          {instance.s3SecretKeySet && (
            <label className="flex items-center gap-2 font-mono text-[11px] text-fg-muted">
              <input
                type="checkbox"
                checked={removeSecret}
                disabled={mutation.isPending}
                onChange={(event) => setRemoveSecret(event.target.checked)}
                className="size-4 accent-signal"
              />
              {t("settings:storage.removeSecret")}
            </label>
          )}
          <p className="font-mono text-[11px] text-fg-faint">
            {t("settings:storage.secretHint")}
          </p>
        </div>

        <FormError message={mutation.error instanceof Error ? mutation.error.message : null} />
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton pending={mutation.isPending}>
            {mutation.isPending ? t("settings:storage.saving") : t("settings:storage.save")}
          </SubmitButton>
          {mutation.isSuccess && (
            <span role="status" className="font-mono text-[12px] text-ok">
              {t("settings:storage.saved")}
            </span>
          )}
        </div>
      </form>
    </section>
  );
}
