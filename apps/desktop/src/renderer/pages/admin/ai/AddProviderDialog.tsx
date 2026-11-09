import { useId, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { SecretInput } from "../../../components/SecretField";
import { useCreateProvider, type ProviderView } from "../../../data/queries";
import { useReauth } from "../../../layout/useReauth";
import { Dialog, inputClass } from "../../../tasks-ui/Dialog";
import { RadioDot } from "../../../tasks-ui/Menu";
import { useToast } from "../../../tasks-ui/Toast";
import { ErrorLine } from "../../entry/parts";
import { refusalOf } from "../../preferences/parts";
import { primaryButton, secondaryButton } from "../../tasks/controls";
import { useAiRefusalWords } from "./parts";

// «Add an AI account» (shape admin-ai.md): il tipo con la sua frase, il
// nome e la chiave (`SecretInput`: il valore vive solo nello stato del
// dialogo). Add → riconferma → l'account va in fondo alla catena, acceso.
// Gli errori stanno sotto il campo; la riconferma chiusa lascia il dialogo
// aperto coi valori (il dialogo di riconferma dice già «Nothing was changed.»).

type Kind = ProviderView["kind"];

export function AddProviderDialog({
  count,
  onClose,
  onAdded,
}: {
  /** Quanti account ci sono adesso: il nuovo va in fondo, alla posizione dopo. */
  count: number;
  onClose: () => void;
  /** L'account aggiunto: la pagina lo evidenzia per 2 s. */
  onAdded: (providerId: string) => void;
}) {
  const { t } = useTranslation();
  const create = useCreateProvider();
  const reauth = useReauth();
  const toast = useToast();
  const refusalWords = useAiRefusalWords();
  const nameId = useId();
  const [kind, setKind] = useState<Kind>("subscription");
  const [name, setName] = useState("");
  const [credential, setCredential] = useState("");
  const [errors, setErrors] = useState<{ name?: string; credential?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const isToken = kind === "subscription";

  async function add() {
    const trimmed = name.trim();
    const missing = {
      ...(trimmed ? {} : { name: t("admin.ai.providers.addDialog.errors.name") }),
      ...(credential.trim()
        ? {}
        : { credential: t(`admin.ai.providers.addDialog.errors.${isToken ? "token" : "key"}`) }),
    };
    setErrors(missing);
    if (missing.name || missing.credential) return;
    setBusy(true);
    const result = await reauth(() => create.mutateAsync({ name: trimmed, kind, credential }), {
      action: t("admin.ai.providers.addDialog.action", { name: trimmed }),
    }).catch(() => null);
    setBusy(false);
    if (result === null) return setErrors({ form: t("admin.ai.saveFailed") });
    const refusal = refusalOf(result);
    if (refusal) {
      if (refusal.error === "conflict")
        return setErrors({
          name: t("admin.ai.providers.addDialog.errors.taken", { name: trimmed }),
        });
      if (refusal.error === "invalid" && refusal.reason === "name")
        return setErrors({ name: t("admin.ai.providers.addDialog.errors.name") });
      if (refusal.error === "invalid" && refusal.reason === "credential")
        return setErrors({
          credential: t(`admin.ai.providers.addDialog.errors.${isToken ? "token" : "key"}`),
        });
      const words = refusalWords(refusal.error);
      return setErrors(words ? { form: words } : {});
    }
    const { providerId } = result as { providerId: string };
    toast.show(
      t(`admin.ai.providers.addDialog.${isToken ? "addedToken" : "addedKey"}`, {
        name: trimmed,
        position: count + 1,
      }),
    );
    onAdded(providerId);
    onClose();
  }

  return (
    <Dialog
      title={t("admin.ai.providers.addDialog.title")}
      onClose={onClose}
      width={480}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("admin.ai.cancel")}
          </button>
          <button
            type="button"
            disabled={busy}
            className={`${primaryButton} disabled:opacity-40`}
            onClick={() => void add()}
          >
            {t("admin.ai.providers.addDialog.submit")}
          </button>
        </>
      }
    >
      <div
        role="radiogroup"
        aria-label={t("admin.ai.providers.addDialog.type")}
        className="flex flex-col gap-2"
      >
        <span aria-hidden="true" className="text-sm font-medium text-ink">
          {t("admin.ai.providers.addDialog.type")}
        </span>
        <TypeOption
          checked={kind === "subscription"}
          label={t("admin.ai.providers.addDialog.subscription")}
          onSelect={() => setKind("subscription")}
        >
          <Trans
            i18nKey="admin.ai.providers.addDialog.subscriptionHint"
            components={{ code: <code className="font-mono text-ink" /> }}
          />
        </TypeOption>
        <TypeOption
          checked={kind === "api_key"}
          label={t("admin.ai.providers.addDialog.apiKey")}
          onSelect={() => setKind("api_key")}
        >
          {t("admin.ai.providers.addDialog.apiKeyHint")}
        </TypeOption>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor={nameId} className="text-sm font-medium text-ink">
          {t("admin.ai.providers.addDialog.name")}
        </label>
        <input
          id={nameId}
          data-autofocus
          value={name}
          maxLength={60}
          placeholder={t("admin.ai.providers.addDialog.namePlaceholder")}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={errors.name ? `${nameId}-error` : undefined}
          onChange={(e) => setName(e.target.value)}
          className={inputClass}
        />
        {errors.name && <ErrorLine id={`${nameId}-error`}>{errors.name}</ErrorLine>}
      </div>
      <SecretInput
        label={t(`admin.ai.providers.addDialog.${isToken ? "token" : "key"}`)}
        value={credential}
        onChange={setCredential}
        error={errors.credential}
      />
      <p className="text-xs text-ink-muted">{t("admin.ai.providers.addDialog.bottom")}</p>
      {errors.form && <ErrorLine>{errors.form}</ErrorLine>}
    </Dialog>
  );
}

/** Una delle due righe del tipo: il pallino, il nome e la frase che dice da dove viene la chiave. */
function TypeOption({
  checked,
  label,
  onSelect,
  children,
}: {
  checked: boolean;
  label: string;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={`flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-left transition-colors duration-[var(--duration-fast)] ease-out ${
        checked ? "border-rule-strong bg-ink/4" : "border-rule hover:border-rule-strong"
      }`}
    >
      <span className="pt-0.5">
        <RadioDot checked={checked} />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-md font-medium text-ink">{label}</span>
        <span className="text-sm text-pretty text-ink-muted">{children}</span>
      </span>
    </button>
  );
}
