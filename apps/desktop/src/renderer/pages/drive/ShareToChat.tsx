import { useNavigate } from "@tanstack/react-router";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePeople, useProjects, useSessionPersonId } from "../../data/queries";
import type { ChannelRow, DriveFileRow } from "../../data/types";
import { Dialog } from "../../tasks-ui/Dialog";
import { readDraft, writeDraft } from "../chat/drafts";
import { smallPrimary, smallSecondary } from "../task/parts";
import { closePreview } from "./FilePreview";

// «Cite in Chat» (shape drive.md A11): il dialogo «Share to…». Il canale
// preselezionato è il «general» del progetto del file; si può scegliere fra
// i canali in cui chi guarda può scrivere (`canWrite`, lo calcola il
// «server»). Confermando, il codice entra nella bozza di quel canale e il
// canale si apre: il messaggio lo manda chi scrive, non questo dialogo.
// Nessun canale in cui scrivere → l'azione non c'è (lo decide chi la mostra).

/** I canali in cui chi guarda può scrivere: l'azione esiste solo se ce n'è almeno uno. */
export const writableChannels = (channels: readonly ChannelRow[] | undefined) =>
  (channels ?? []).filter((c) => c.canWrite);

export function ShareToChatDialog({
  file,
  channels,
  onClose,
}: {
  file: Pick<DriveFileRow, "code" | "projectId">;
  /** Solo quelli con `canWrite`. */
  channels: ChannelRow[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const me = useSessionPersonId();
  const projects = useProjects().data;
  const people = usePeople().data;
  const groupId = useId();
  const code = (projectId: string | null) => projects?.find((p) => p.id === projectId)?.code ?? "";
  const fileProject = code(file.projectId);

  const groups = useMemo(() => {
    const own = channels.filter((c) => c.kind === "project" && c.projectId === file.projectId);
    // Il «general» del progetto in testa: è il preselezionato.
    own.sort((a, b) => Number(b.isGeneral) - Number(a.isGeneral) || a.name.localeCompare(b.name));
    const other = channels.filter((c) => c.kind !== "dm" && !own.includes(c));
    const dms = channels.filter((c) => c.kind === "dm");
    return [
      { key: "project", label: t("drive.share.groupProject", { code: fileProject }), list: own },
      { key: "other", label: t("drive.share.groupOther"), list: other },
      { key: "dm", label: t("drive.share.groupDm"), list: dms },
    ].filter((g) => g.list.length > 0);
  }, [channels, file.projectId, fileProject, t]);

  const preselected = channels.find(
    (c) => c.kind === "project" && c.projectId === file.projectId && c.isGeneral,
  );
  const [chosen, setChosen] = useState<string | undefined>(preselected?.id);

  const label = (c: ChannelRow) => {
    if (c.kind === "dm") {
      return c.memberIds
        .filter((id) => id !== me)
        .map((id) => people?.find((p) => p.id === id)?.name ?? "")
        .filter(Boolean)
        .join(", ");
    }
    return c.kind === "project" ? `${code(c.projectId)} · ${c.name}` : `# ${c.name}`;
  };

  const confirm = () => {
    const channel = channels.find((c) => c.id === chosen);
    if (!channel) return;
    const draft = readDraft(me, channel.id);
    writeDraft(me, channel.id, `${draft}${draft && !draft.endsWith(" ") ? " " : ""}${file.code} `);
    closePreview();
    onClose();
    if (channel.kind === "project" && channel.projectId) {
      void navigate({
        to: "/p/$code/chat/$channelId",
        params: { code: code(channel.projectId), channelId: channel.id },
      });
    } else {
      void navigate({ to: "/chat/$channelId", params: { channelId: channel.id } });
    }
  };

  return (
    <Dialog
      title={t("drive.share.title")}
      description={t("drive.share.body", { code: file.code })}
      onClose={onClose}
      width={460}
      footer={
        <>
          <button type="button" className={smallSecondary} onClick={onClose}>
            {t("drive.share.cancel")}
          </button>
          <button type="button" className={smallPrimary} disabled={!chosen} onClick={confirm}>
            {t("drive.share.open")}
          </button>
        </>
      }
    >
      <fieldset className="flex max-h-80 min-w-0 flex-col gap-3 overflow-y-auto">
        <legend className="sr-only">{t("drive.share.channels")}</legend>
        {groups.map((g) => (
          <div key={g.key} role="group" aria-labelledby={`${groupId}-${g.key}`} className="flex flex-col gap-px">
            <span id={`${groupId}-${g.key}`} className="heading-group px-2 pb-1">
              {g.label}
            </span>
            {g.list.map((c) => (
              <label
                key={c.id}
                className="flex min-h-8 cursor-default items-center gap-2.5 rounded-md px-2 py-1 text-sm text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 has-[:checked]:bg-ink/8"
              >
                <input
                  type="radio"
                  name={`${groupId}-channel`}
                  value={c.id}
                  checked={chosen === c.id}
                  data-autofocus={chosen === c.id ? "" : undefined}
                  onChange={() => setChosen(c.id)}
                  className="size-3.5 shrink-0"
                />
                <span className="min-w-0 truncate">{label(c)}</span>
              </label>
            ))}
          </div>
        ))}
      </fieldset>
    </Dialog>
  );
}
