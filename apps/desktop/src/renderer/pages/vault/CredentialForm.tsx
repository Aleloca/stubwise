import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCreateCredential, useUpdateCredential, useVaultStatus } from "../../data/queries";
import type { CredentialView } from "../../data/vault/types";
import { inputClass } from "../../tasks-ui/Dialog";
import { useToast } from "../../tasks-ui/Toast";
import { primaryButton, quietButton } from "../tasks/controls";
import { useOpenVault } from "./VaultBar";

// Nuova e modifica di una credenziale (shape `vault.md` §3 «Nuova e
// modifica»): il modulo nel pannello di destra. Service · Label · URL ·
// Username · Password · Notes, niente «Generate» (VA-Q6, maintainer).
// Creare non chiede la cassaforte aperta; in modifica una password nuova sì
// (le copie per i lettori le fa il livello dati con la chiave): a cassaforte
// chiusa il salvataggio apre prima col Touch ID. La password scritta vive
// solo nello stato del modulo, e se ne va con lui.

type Mode = { kind: "new"; projectId: string } | { kind: "edit"; view: CredentialView };

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | string[];
  children: (id: string) => React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm text-ink-muted">
        {label}
      </label>
      {children(id)}
      {[hint ?? []].flat().map((h) => (
        <span key={h} className="text-xs text-ink-faint">
          {h}
        </span>
      ))}
    </div>
  );
}

export function CredentialForm({
  mode,
  onSaved,
  onCancel,
}: {
  mode: Mode;
  /** L'id della credenziale salvata (nuova o modificata). */
  onSaved: (id: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const status = useVaultStatus().data;
  const { open } = useOpenVault();
  const create = useCreateCredential();
  const update = useUpdateCredential();
  const editing = mode.kind === "edit" ? mode.view : null;
  const [service, setService] = useState(editing?.service ?? "");
  const [label, setLabel] = useState(editing?.label ?? "");
  const [url, setUrl] = useState(editing?.url ?? "");
  const [username, setUsername] = useState(editing?.username ?? "");
  const [password, setPassword] = useState("");
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [saving, setSaving] = useState(false);

  const orNull = (s: string) => (s.trim() === "" ? null : s.trim());
  const valid = service.trim() !== "" && (editing !== null || password !== "");

  const save = async () => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      const plain = {
        service: service.trim(),
        label: orNull(label),
        url: orNull(url),
        username: orNull(username),
        notes: orNull(notes),
      };
      if (mode.kind === "new") {
        const out = await create
          .mutateAsync({ projectId: mode.projectId, input: { ...plain, password } })
          .catch(() => null);
        if (!out?.ok) return void toast.error(t("vault.form.failed"));
        toast.show(t("vault.form.created"));
        onSaved(out.id);
        return;
      }
      // Una password nuova vuole la cassaforte aperta: a chiusa, prima il Touch ID.
      if (password !== "" && status?.state !== "open" && !(await open())) {
        return void toast.error(t("vault.form.locked"));
      }
      const out = await update
        .mutateAsync({
          id: mode.view.id,
          input: password !== "" ? { ...plain, password } : plain,
        })
        .catch(() => null);
      if (!out?.ok) return void toast.error(t("vault.form.failed"));
      toast.show(t("vault.form.saved"));
      onSaved(mode.view.id);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2 className="text-lg font-semibold text-ink">
        {editing ? t("vault.form.editTitle", { name: editing.service }) : t("vault.form.newTitle")}
      </h2>
      <Field label={t("vault.form.service")}>
        {(id) => (
          <input
            id={id}
            className={inputClass}
            value={service}
            onChange={(e) => setService(e.target.value)}
            autoComplete="off"
          />
        )}
      </Field>
      <Field label={t("vault.form.label")}>
        {(id) => (
          <input
            id={id}
            className={inputClass}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            autoComplete="off"
          />
        )}
      </Field>
      <Field label={t("vault.form.url")}>
        {(id) => (
          <input
            id={id}
            type="url"
            className={inputClass}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoComplete="off"
          />
        )}
      </Field>
      <Field label={t("vault.form.username")}>
        {(id) => (
          <input
            id={id}
            className={inputClass}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
          />
        )}
      </Field>
      <Field
        label={t("vault.form.password")}
        hint={
          editing
            ? [t("vault.form.keepPassword"), t("vault.form.passwordHint")]
            : t("vault.form.passwordHint")
        }
      >
        {(id) => (
          <input
            id={id}
            type="password"
            className={`${inputClass} font-mono`}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            spellCheck={false}
          />
        )}
      </Field>
      <Field label={t("vault.form.notes")} hint={t("vault.form.notesHint")}>
        {(id) => (
          <textarea
            id={id}
            rows={3}
            className={`${inputClass} h-auto py-2`}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        )}
      </Field>
      <div className="flex items-center gap-2">
        <button type="submit" className={primaryButton} disabled={!valid || saving}>
          {saving ? t("vault.form.saving") : t("vault.form.save")}
        </button>
        <button type="button" className={quietButton} onClick={onCancel}>
          {t("vault.form.cancel")}
        </button>
      </div>
    </form>
  );
}
