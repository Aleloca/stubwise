import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useRegisterPlugin, useUpdatePluginRef, type PluginView } from "../../../data/queries";
import { useReauth } from "../../../layout/useReauth";
import { Dialog } from "../../../tasks-ui/Dialog";
import { useToast } from "../../../tasks-ui/Toast";
import { ErrorLine } from "../../entry/parts";
import { refusalOf } from "../../preferences/parts";
import { primaryButton, secondaryButton } from "../../tasks/controls";
import { TextField, TrustBox, WarningBox, useRefusalWords } from "./parts";

// Registrare un plugin e aggiornarlo a un ref (shape admin-integrations.md
// [IN 2]): l'uno e l'altro ESEGUONO il codice del plugin (il worker lo
// installa e fa lo smoke test con tutto acceso), quindi il dialogo lo dice
// in parole PRIMA dei campi, e il bottone resta spento finché la casella «I
// trust this repository and this commit» non è spuntata (confermata dal
// maintainer il 30 ott 2026); poi la riconferma. Le regole sull'indirizzo
// (https, credenziali, slug, doppioni) sono del livello dati: il dialogo
// dice in parole il suo rifiuto, sotto il campo che lo riguarda.

type Field = "url" | "ref" | "subdir" | "form";

/** Il footer dei due dialoghi: Annulla, la frase finché manca la casella, il bottone. */
function TrustFooter({
  trusted,
  submit,
  busy,
  onCancel,
  onSubmit,
}: {
  trusted: boolean;
  submit: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {!trusted && (
        <span className="mr-auto min-w-0 text-xs text-pretty text-ink-muted">
          {t("admin.plugins.trustNeeded")}
        </span>
      )}
      <button type="button" className={secondaryButton} onClick={onCancel}>
        {t("admin.integrations.cancel")}
      </button>
      <button
        type="button"
        disabled={!trusted || busy}
        className={`${primaryButton} disabled:cursor-not-allowed disabled:opacity-40`}
        onClick={onSubmit}
      >
        {submit}
      </button>
    </>
  );
}

/** Le parole di un rifiuto di registrazione o aggiornamento, col campo a cui stanno sotto. */
function useRegisterRefusal() {
  const { t } = useTranslation();
  const refusalWords = useRefusalWords();
  return (refusal: { error: string; reason?: string; name?: string }): Partial<Record<Field, string>> => {
    const e = (key: string, params?: Record<string, string>) =>
      t(`admin.plugins.registerDialog.errors.${key}`, params);
    if (refusal.error === "conflict") return { url: e("conflict") };
    if (refusal.error === "invalid") {
      switch (refusal.reason) {
        case "https":
        case "credentials":
        case "git_ssh":
          return { url: e(refusal.reason) };
        case "slug":
          return { url: refusal.name ? e("slug", { name: refusal.name }) : e("slugEmpty") };
        case "duplicate":
          return { url: e("duplicate", { name: refusal.name ?? "" }) };
        case "ref":
          return { ref: e("ref") };
        case "subdir":
          return { subdir: e("subdir") };
        case "not_trusted":
          return { form: t("admin.plugins.trustNeeded") };
      }
    }
    const form = refusalWords(refusal.error);
    return form ? { form } : {};
  };
}

/** «Register plugin» (560 px): l'avviso, indirizzo, ref, sottocartella, la casella. */
export function RegisterPluginDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const register = useRegisterPlugin();
  const reauth = useReauth();
  const toast = useToast();
  const wordsOf = useRegisterRefusal();
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [subdir, setSubdir] = useState("");
  const [trusted, setTrusted] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!trusted) return;
    setErrors({});
    setBusy(true);
    const result = await reauth(
      () => register.mutateAsync({ url, ref, subdir: subdir.trim() || null, trusted: true }),
      { action: t("admin.plugins.registerDialog.action", { url: url.trim() }) },
    ).catch(() => null);
    setBusy(false);
    if (result === null) return setErrors({ form: t("admin.integrations.saveFailed") });
    const refusal = refusalOf(result);
    if (refusal) return setErrors(wordsOf(refusal as Parameters<typeof wordsOf>[0]));
    toast.show(t("admin.plugins.registerDialog.done", { name: (result as { name: string }).name }));
    onClose();
  }

  return (
    <Dialog
      title={t("admin.plugins.registerDialog.title")}
      onClose={onClose}
      width={560}
      footer={
        <TrustFooter
          trusted={trusted}
          submit={t("admin.plugins.registerDialog.submit")}
          busy={busy}
          onCancel={onClose}
          onSubmit={() => void submit()}
        />
      }
    >
      <WarningBox title={t("admin.plugins.registerDialog.warningTitle")}>
        {t("admin.plugins.registerDialog.warning")}
      </WarningBox>
      <TextField
        label={t("admin.plugins.registerDialog.url")}
        value={url}
        onChange={setUrl}
        placeholder={t("admin.plugins.registerDialog.urlPlaceholder")}
        error={errors.url}
        autoFocus
        mono
      />
      <TextField
        label={t("admin.plugins.registerDialog.ref")}
        value={ref}
        onChange={setRef}
        hint={t("admin.plugins.registerDialog.refHint")}
        error={errors.ref}
        mono
      />
      <TextField
        label={`${t("admin.plugins.registerDialog.subdir")} (${t("admin.integrations.optional")})`}
        value={subdir}
        onChange={setSubdir}
        error={errors.subdir}
        mono
      />
      <p className="text-xs text-pretty text-ink-muted">{t("admin.plugins.registerDialog.nameNote")}</p>
      <TrustBox checked={trusted} label={t("admin.plugins.trust")} onChange={setTrusted} />
      {errors.form && <ErrorLine>{errors.form}</ErrorLine>}
    </Dialog>
  );
}

/** «Update to ref…» (480 px): la frase in breve, il ref, la stessa casella, la riconferma. */
export function UpdateRefDialog({ plugin: p, onClose }: { plugin: PluginView; onClose: () => void }) {
  const { t } = useTranslation();
  const update = useUpdatePluginRef();
  const reauth = useReauth();
  const toast = useToast();
  const wordsOf = useRegisterRefusal();
  const [ref, setRef] = useState("");
  const [trusted, setTrusted] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!trusted) return;
    setErrors({});
    setBusy(true);
    const next = ref.trim();
    const result = await reauth(() => update.mutateAsync([p.id, { ref, trusted: true }]), {
      action: t("admin.plugins.updateDialog.action", { name: p.name, ref: next }),
    }).catch(() => null);
    setBusy(false);
    if (result === null) return setErrors({ form: t("admin.integrations.saveFailed") });
    const refusal = refusalOf(result);
    if (refusal)
      return setErrors(
        refusal.error === "conflict"
          ? { form: t("admin.plugins.page.busy") }
          : wordsOf(refusal as Parameters<typeof wordsOf>[0]),
      );
    toast.show(t("admin.plugins.updateDialog.done", { name: p.name, ref: next }));
    onClose();
  }

  return (
    <Dialog
      title={t("admin.plugins.updateDialog.title", { name: p.name })}
      onClose={onClose}
      width={480}
      footer={
        <TrustFooter
          trusted={trusted}
          submit={t("admin.plugins.updateDialog.submit")}
          busy={busy}
          onCancel={onClose}
          onSubmit={() => void submit()}
        />
      }
    >
      <WarningBox>{t("admin.plugins.updateDialog.warning")}</WarningBox>
      <TextField
        label={t("admin.plugins.registerDialog.ref")}
        value={ref}
        onChange={setRef}
        hint={`${t("admin.plugins.registerDialog.refHint")}. ${t("admin.plugins.updateDialog.current", { ref: p.ref })}`}
        error={errors.ref}
        autoFocus
        mono
      />
      <TrustBox checked={trusted} label={t("admin.plugins.trust")} onChange={setTrusted} />
      {errors.form && <ErrorLine>{errors.form}</ErrorLine>}
    </Dialog>
  );
}
