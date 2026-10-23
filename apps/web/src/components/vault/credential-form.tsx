import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  getCredentialRecipients,
  getNewCredentialRecipients,
  patchCredential,
  postCredential,
  putCredentialPassword,
  type CredentialItem,
} from "../../lib/api";
import { translateApiError } from "../../lib/translate-api-error";
import { newCredentialId, writeEncrypted } from "../../lib/vault/credentials";
import { FormError, TextField } from "../field";

const textareaClass =
  "rounded-sm border border-line-strong bg-ink-950/70 px-3 py-2 text-[15px] text-fg placeholder:text-fg-faint transition-colors hover:border-ink-700 focus-visible:border-signal-dim";
const labelClass = "font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase";
const hintClass = "font-mono text-[11px] text-fg-faint";

/** Il nome di una credenziale nelle etichette: servizio, più l'etichetta se c'è. */
export function credentialName(item: Pick<CredentialItem, "service" | "label">): string {
  return item.label ? `${item.service} · ${item.label}` : item.service;
}

/** Un campo in chiaro facoltativo: vuoto = nessun valore. */
function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Crea o modifica una credenziale (design «Cosa contiene una credenziale»).
 * Solo la password è cifrata, qui nel browser, per i destinatari che dà il
 * server (`writeEncrypted`: su 409 `recipients_changed` ricifra e riprova
 * una volta); gli altri campi viaggiano in chiaro, e accanto alle note lo
 * si dice. Cifrare non richiede la cassaforte aperta: servono solo le chiavi
 * PUBBLICHE dei lettori. La password digitata resta nello stato del form e
 * sparisce con lui.
 *
 * In modifica la password è facoltativa (vuota = invariata);
 * `focusPassword` la mette a fuoco, per il «Cambia la password» proposto
 * dopo una revoca.
 */
export function CredentialForm({
  projectId,
  credential,
  focusPassword = false,
  onDone,
}: {
  projectId: string;
  credential?: CredentialItem;
  focusPassword?: boolean;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const editing = credential !== undefined;
  const prefix = credential ? `credential-${credential.id}` : `credential-new-${projectId}`;
  const [service, setService] = useState(credential?.service ?? "");
  const [label, setLabel] = useState(credential?.label ?? "");
  const [url, setUrl] = useState(credential?.url ?? "");
  const [username, setUsername] = useState(credential?.username ?? "");
  const [notes, setNotes] = useState(credential?.notes ?? "");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  // L'id di una credenziale nuova si fissa una volta: è l'AAD della password cifrata.
  const [newId] = useState(() => (editing ? null : newCredentialId()));

  useEffect(() => {
    if (focusPassword) passwordRef.current?.focus();
  }, [focusPassword]);

  async function save() {
    const fields = {
      label: orNull(label),
      url: orNull(url),
      username: orNull(username),
      notes: orNull(notes),
    };
    if (!credential) {
      const id = newId!;
      await writeEncrypted({
        credentialId: id,
        password,
        loadRecipients: () => getNewCredentialRecipients(projectId),
        write: (encrypted) =>
          postCredential(projectId, { id, service: service.trim(), ...fields, ...encrypted }),
      });
      return;
    }
    await patchCredential(credential.id, { service: service.trim(), ...fields });
    if (password !== "") {
      await writeEncrypted({
        credentialId: credential.id,
        password,
        loadRecipients: () => getCredentialRecipients(credential.id),
        write: (encrypted) => putCredentialPassword(credential.id, encrypted),
      });
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await save();
      setPassword("");
      await queryClient.invalidateQueries({ queryKey: ["credentials"] });
      onDone();
    } catch (cause) {
      setError(translateApiError(cause, t));
    } finally {
      setPending(false);
    }
  }

  const title = credential
    ? t("vault:credentials.editTitle", { name: credentialName(credential) })
    : t("vault:credentials.newTitle");
  const passwordLabel = editing
    ? t("vault:credentials.fields.newPassword")
    : t("vault:credentials.fields.password");

  return (
    <form
      onSubmit={handleSubmit}
      aria-label={title}
      className="flex flex-col gap-3 rounded-sm border border-line bg-ink-950/40 p-4"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          id={`${prefix}-service`}
          label={t("vault:credentials.fields.service")}
          value={service}
          onChange={(event) => setService(event.target.value)}
          required
          maxLength={200}
        />
        <TextField
          id={`${prefix}-label`}
          label={t("vault:credentials.fields.label")}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          maxLength={200}
        />
        <TextField
          id={`${prefix}-url`}
          label={t("vault:credentials.fields.url")}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          inputMode="url"
          maxLength={2000}
        />
        <TextField
          id={`${prefix}-username`}
          label={t("vault:credentials.fields.username")}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="off"
          maxLength={500}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${prefix}-password`} className={labelClass}>
          {passwordLabel}
        </label>
        <input
          id={`${prefix}-password`}
          ref={passwordRef}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required={!editing}
          aria-describedby={`${prefix}-password-hint`}
          className={textareaClass}
        />
        <p id={`${prefix}-password-hint`} className={hintClass}>
          {editing ? t("vault:credentials.newPasswordHint") : t("vault:credentials.passwordHint")}
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${prefix}-notes`} className={labelClass}>
          {t("vault:credentials.fields.notes")}
        </label>
        <textarea
          id={`${prefix}-notes`}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          rows={3}
          maxLength={10_000}
          aria-describedby={`${prefix}-notes-hint`}
          className={textareaClass}
        />
        <p id={`${prefix}-notes-hint`} className={`${hintClass} text-signal`}>
          {t("vault:credentials.notesHint")}
        </p>
      </div>
      <FormError message={error} />
      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={onDone}
          className="rounded-sm px-3 py-2 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase hover:text-fg"
        >
          {t("vault:credentials.cancel")}
        </button>
        <button
          type="submit"
          disabled={pending || service.trim() === "" || (!editing && password === "")}
          className="rounded-sm border border-line-strong px-3 py-2 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? t("vault:credentials.saving") : t("vault:credentials.save")}
        </button>
      </div>
    </form>
  );
}
