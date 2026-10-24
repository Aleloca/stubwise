import { useTranslation } from "react-i18next";
import { usePeople, useProjects, useSessionPersonId } from "../../data/queries";
import type { ChannelView } from "../../data/types";
import { formatDate } from "../../notifications/time";
import { ChannelLifecycleActions, MembersSection } from "./ChannelSettings";
import { useChannelName } from "./ChannelView";
import { LockGlyph } from "./glyphs";

// Il privato visto da chi gestisce i canali senza esserne membro (shape
// chat-manage.md §5): sa che esiste, chi c'è, e può archiviarlo o
// eliminarlo — non ne legge nulla. Niente conteggi di messaggi, niente data
// dell'ultimo, niente anteprime: il livello dati non li dà (`listMessages`
// risponde `null`, la riga ha `lastActivityAt` vuoto), e questa pagina non
// li chiede nemmeno. Chi gestisce non può aggiungersi: si chiede a un membro.

export function PrivateChannelPage({ channel }: { channel: ChannelView }) {
  const { t, i18n } = useTranslation();
  const me = useSessionPersonId();
  const people = usePeople().data;
  const projects = useProjects().data;
  const name = useChannelName(channel, me);
  const creator = people?.find((p) => p.id === channel.createdById);
  const scope =
    channel.kind === "project"
      ? (projects?.find((p) => p.id === channel.projectId)?.code ?? "")
      : null;
  const meta = [
    channel.archived ? t("chat.channel.archived") : null,
    t("chat.channel.private"),
    t("chat.channel.members", { count: channel.memberIds.length }),
    t("chat.channel.createdBy", {
      name: creator?.name ?? "",
      date: formatDate(channel.createdAt, i18n.language),
    }),
  ].filter(Boolean);
  return (
    <section aria-label={name.label} data-private-channel={channel.id} className="flex flex-col">
      <header className="page-header flex min-w-0 flex-col gap-1 border-b border-rule pb-3 pl-8 [--page-header-pr:32px] [--page-header-pt:24px]">
        <h1
          className="flex min-w-0 items-center gap-2 text-2xl font-semibold text-ink"
          title={name.label}
        >
          <span className="text-ink-muted">
            <LockGlyph size={20} />
          </span>
          <span className="min-w-0 truncate">
            {name.code && (
              <span className="num text-ink-muted">
                {name.code}
                {channel.kind === "project" ? " · " : " "}
              </span>
            )}
            {name.name}
          </span>
        </h1>
        <p className="text-sm text-ink-muted">{meta.join(" · ")}</p>
      </header>
      <div className="flex max-w-[640px] flex-col gap-2 px-8 pt-6 pb-4">
        <p className="text-lg font-semibold text-ink">{t("chat.private.cantRead")}</p>
        <p className="text-md text-ink-muted">
          {scope
            ? t("chat.private.why", { code: scope })
            : t("chat.private.whyCompany")}
        </p>
      </div>
      <div className="max-w-[640px] px-4">
        <MembersSection channel={channel} readOnly />
        {(channel.canArchive || channel.canDelete) && (
          <div className="flex flex-wrap items-center gap-1 border-t border-rule px-2 py-3">
            <ChannelLifecycleActions channel={channel} label={name.label} />
          </div>
        )}
      </div>
    </section>
  );
}
