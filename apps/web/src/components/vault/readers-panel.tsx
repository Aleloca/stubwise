import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  deleteCredentialReader,
  getCredentialSharePreview,
  postCredentialReader,
  type CredentialReader,
  type CredentialReaderPerson,
  type CredentialReaderTarget,
  type CredentialReadersResponse,
} from "../../lib/api";
import { credentialReadersQueryOptions, projectMembersQueryOptions } from "../../lib/queries";
import { translateApiError } from "../../lib/translate-api-error";
import { proveKey, shareEncrypted } from "../../lib/vault/credentials";
import { FormError } from "../field";
import { useWithUnlockedVault } from "./reveal-button";
import { vaultErrorMessage } from "./unlock-dialog";

const smallButtonClass =
  "tap rounded-sm border border-line-strong px-2 py-1 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg disabled:cursor-not-allowed disabled:opacity-50";

function readerName(reader: CredentialReader, t: TFunction): string {
  if (reader.roleName) return t("vault:credentials.readers.role", { name: reader.roleName });
  return reader.email ?? "—";
}

function personStatus(person: CredentialReaderPerson, t: TFunction): string {
  if (person.status === "can_read") return t("vault:credentials.readers.canRead");
  if (person.keyStatus === "none") return t("vault:credentials.readers.pendingNone");
  if (person.keyStatus === "pending") return t("vault:credentials.readers.pendingKey");
  return t("vault:credentials.readers.pendingCopy");
}

/**
 * Lettori di UNA credenziale (design «Permessi e accesso», «Revoca»). Il
 * chiamante la monta solo con `canShare` del server (`credentials.share` E
 * lettore adesso). Condividere apre la propria copia della chiave con la
 * cassaforte aperta e la ricifra per chi ha già una chiave confermata; gli
 * altri restano in attesa di una conferma umana. Togliere un lettore propone
 * subito di cambiare la password (`onChangePassword`), perché chi l'aveva
 * vista potrebbe ricordarla.
 */
export function ReadersPanel({
  projectId,
  credentialId,
  name,
  canEdit,
  onChangePassword,
}: {
  projectId: string;
  credentialId: string;
  name: string;
  canEdit: boolean;
  onChangePassword: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const readers = useQuery(credentialReadersQueryOptions(credentialId));
  const members = useQuery(projectMembersQueryOptions(projectId));
  const { run, dialog } = useWithUnlockedVault();
  const [target, setTarget] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<string[]>([]);
  const [revoked, setRevoked] = useState<string | null>(null);

  async function refresh(view: CredentialReadersResponse) {
    queryClient.setQueryData(credentialReadersQueryOptions(credentialId).queryKey, view);
    await queryClient.invalidateQueries({ queryKey: ["credentials"] });
  }

  function share() {
    const parsed: CredentialReaderTarget | null = target.startsWith("user:")
      ? { userId: target.slice(5) }
      : target.startsWith("role:")
        ? { roleId: target.slice(5) }
        : null;
    if (!parsed) return;
    setError(null);
    setRevoked(null);
    setWaiting([]);
    run(({ privateKey, personKeyId }) => {
      setPending(true);
      void (async () => {
        try {
          let lastWaiting: string[] = [];
          const view = await shareEncrypted({
            credentialId,
            privateKey,
            personKeyId,
            loadPreview: async () => {
              const preview = await getCredentialSharePreview(credentialId, parsed);
              lastWaiting = (preview.waiting ?? []).map((person) => person.email);
              return preview;
            },
            write: (body) => postCredentialReader(credentialId, { ...parsed, ...body }),
          });
          setTarget("");
          setWaiting(lastWaiting);
          await refresh(view);
        } catch (cause) {
          setError(
            cause instanceof DOMException
              ? t("vault:credentials.revealFailed")
              : vaultErrorMessage(cause, t),
          );
        } finally {
          setPending(false);
        }
      })();
    });
  }

  /** Togliere un lettore vuole la prova della propria chiave: con la cassaforte aperta. */
  function remove(reader: CredentialReader) {
    setError(null);
    setWaiting([]);
    run((key) => {
      void (async () => {
        try {
          const view = await deleteCredentialReader(credentialId, reader.id, await proveKey(key));
          setRevoked(readerName(reader, t));
          await refresh(view);
        } catch (cause) {
          setError(vaultErrorMessage(cause, t));
        }
      })();
    });
  }

  const title = t("vault:credentials.readers.title", { name });
  const direct = readers.data?.readers ?? [];
  const people = readers.data?.people ?? [];
  const directUsers = new Set(direct.map((reader) => reader.userId).filter(Boolean));
  const directRoles = new Set(direct.map((reader) => reader.roleId).filter(Boolean));
  const memberList = members.data ?? [];
  const candidatePeople = memberList.filter((member) => !directUsers.has(member.userId));
  // I ruoli di progetto si ricavano dai membri: l'elenco dei ruoli è solo di chi li gestisce.
  const roles = new Map<string, string>();
  for (const member of memberList) {
    if (!directRoles.has(member.roleId)) roles.set(member.roleId, member.roleName);
  }

  return (
    <section
      aria-label={title}
      className="flex flex-col gap-3 rounded-sm border border-line bg-ink-950/40 p-3"
    >
      {readers.isError && <FormError message={translateApiError(readers.error, t)} />}
      <div>
        <h4 className="font-mono text-[11px] tracking-[0.14em] text-fg-muted uppercase">
          {t("vault:credentials.readers.direct")}
        </h4>
        {direct.length === 0 ? (
          <p className="mt-1 font-mono text-[12px] text-fg-faint">
            {t("vault:credentials.readers.none")}
          </p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1">
            {direct.map((reader) => (
              <li key={reader.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate font-mono text-[13px] text-fg">
                  {readerName(reader, t)}
                  {(reader.creator ?? false) && (
                    <span className="ml-2 text-[11px] text-fg-faint">
                      {t("vault:credentials.readers.creator")}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => remove(reader)}
                  aria-label={t("vault:credentials.readers.removeAria", {
                    name: readerName(reader, t),
                  })}
                  className={smallButtonClass}
                >
                  {t("vault:credentials.readers.remove")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {people.length > 0 && (
        <div>
          <h4 className="font-mono text-[11px] tracking-[0.14em] text-fg-muted uppercase">
            {t("vault:credentials.readers.effective")}
          </h4>
          <ul className="mt-1 flex flex-col gap-1">
            {people.map((person) => (
              <li
                key={person.userId}
                className="flex flex-wrap items-baseline justify-between gap-2"
              >
                <span className="font-mono text-[13px] text-fg">
                  {person.email}
                  {person.fullAdmin && (
                    <span className="ml-2 text-[11px] text-fg-faint">
                      {t("vault:credentials.readers.fullAdmin")}
                    </span>
                  )}
                </span>
                <span
                  className={`font-mono text-[11px] ${person.status === "can_read" ? "text-fg-faint" : "text-signal"}`}
                >
                  {personStatus(person, t)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {revoked && (
        <div role="status" className="rounded-sm border border-signal/40 bg-signal/10 p-3 text-sm">
          <p>{t("vault:credentials.readers.revoked", { name: revoked })}</p>
          {canEdit && (
            <button type="button" onClick={onChangePassword} className={`${smallButtonClass} mt-2`}>
              {t("vault:credentials.readers.changePassword")}
            </button>
          )}
        </div>
      )}
      {waiting.length > 0 && (
        <p className="font-mono text-[12px] text-signal">
          {t("vault:credentials.readers.waiting", { emails: waiting.join(", ") })}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label
            htmlFor={`share-${credentialId}`}
            className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase"
          >
            {t("vault:credentials.readers.shareWith")}
          </label>
          <select
            id={`share-${credentialId}`}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            className="rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1.5 font-mono text-[13px] text-fg"
          >
            <option value="">{t("vault:credentials.readers.pick")}</option>
            {candidatePeople.length > 0 && (
              <optgroup label={t("vault:credentials.readers.people")}>
                {candidatePeople.map((member) => (
                  <option key={member.userId} value={`user:${member.userId}`}>
                    {member.email}
                  </option>
                ))}
              </optgroup>
            )}
            {roles.size > 0 && (
              <optgroup label={t("vault:credentials.readers.roles")}>
                {[...roles].map(([roleId, roleName]) => (
                  <option key={roleId} value={`role:${roleId}`}>
                    {t("vault:credentials.readers.roleOption", { name: roleName })}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
        <button
          type="button"
          onClick={share}
          disabled={pending || target === ""}
          className={smallButtonClass}
        >
          {pending ? t("vault:credentials.readers.sharing") : t("vault:credentials.readers.share")}
        </button>
      </div>
      <FormError message={error} />
      {dialog}
    </section>
  );
}
