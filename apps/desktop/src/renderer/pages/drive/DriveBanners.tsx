import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  useConnectGoogle,
  useGoogleAccount,
  useOpenDm,
  usePeople,
  useSessionPersonId,
} from "../../data/queries";
import type { FolderLinkView, Project } from "../../data/types";
import { can, useViewer } from "../../data/viewer";
import { formatDate } from "../../notifications/time";
import { useToast } from "../../tasks-ui/Toast";
import { readDraft, writeDraft } from "../chat/drafts";
import { quietButton, secondaryButton } from "../tasks/controls";
import { GoogleDriveGlyph, Spinner, WarningGlyph } from "./glyphs";

// Le fasce Google del Drive (shape drive-google.md §3, A6).
//
// Collegamento scaduto: la vede SOLO chi gestisce il Drive del progetto
// (un avviso a chi non può farci niente è un anti-obiettivo; gli altri
// leggono «Not updating since…» nel gruppo). Se la cartella l'ha collegata
// chi guarda: «Reconnect» (il suo account). Se l'ha collegata un altro:
// «Ask X to reconnect» (DM precompilato) — ricollegare col proprio account
// cambierebbe chi legge, e l'unica strada alternativa (scollegare e
// ricollegare) fa ripartire i file con codici nuovi e senza aperture: la
// fascia lo dice.
//
// Invito a collegare l'account: la riga quieta che la ricerca (Task 8)
// mostra al posto dei file Google fuori dai progetti a chi non ha l'account.

export function ExpiredLinkBanners({
  project,
  folders,
}: {
  project: Project;
  folders: FolderLinkView[];
}) {
  const { viewer } = useViewer();
  if (!can(viewer, "drive.manage", project.id)) return null;
  const expired = folders.filter((f) => f.status === "expired");
  if (expired.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {expired.map((f) => (
        <ExpiredBanner key={f.id} project={project} folder={f} />
      ))}
    </div>
  );
}

function ExpiredBanner({ project, folder }: { project: Project; folder: FolderLinkView }) {
  const { t, i18n } = useTranslation();
  const me = useSessionPersonId();
  const navigate = useNavigate();
  const toast = useToast();
  const people = usePeople().data;
  const connect = useConnectGoogle();
  const openDm = useOpenDm();
  const mine = folder.linkedById === me;
  const linker = people?.find((p) => p.id === folder.linkedById)?.name ?? t("drive.row.someone");
  const date = formatDate(folder.expiredAt ?? folder.linkedAt, i18n.language);

  const ask = () =>
    openDm.mutate([folder.linkedById], {
      onSuccess: (channel) => {
        const text = t("drive.expired.draft", {
          name: linker.split(" ")[0],
          folder: folder.name,
          code: project.code,
          date,
        });
        const draft = readDraft(me, channel.id);
        writeDraft(me, channel.id, draft ? `${draft}\n${text}` : text);
        void navigate({ to: "/chat/$channelId", params: { channelId: channel.id } });
      },
      onError: () => toast.error(t("drive.google.failed")),
    });

  return (
    <section
      role="region"
      aria-label={t("drive.expired.region")}
      data-drive-expired={folder.id}
      className="flex flex-wrap items-start gap-x-4 gap-y-2 rounded-md border border-rule bg-warning/6 py-2.5 pr-3 pl-3"
    >
      <span className="mt-0.5 text-warning">
        <WarningGlyph />
      </span>
      <div className="flex min-w-[min(100%,320px)] flex-1 flex-col gap-0.5">
        <p className="text-md text-ink">{t("drive.expired.text", { folder: folder.name, date })}</p>
        {!mine && <p className="text-sm text-ink-muted">{t("drive.expired.other", { name: linker })}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2 self-center">
        {mine ? (
          <button
            type="button"
            className={secondaryButton}
            disabled={connect.isPending}
            onClick={() => connect.mutate()}
          >
            {connect.isPending && <Spinner />}
            {t("drive.expired.reconnect")}
          </button>
        ) : (
          <button
            type="button"
            className={secondaryButton}
            disabled={openDm.isPending}
            onClick={ask}
          >
            {t("drive.expired.ask", { name: linker })}
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * La riga quieta per chi non ha l'account Google collegato (o l'ha
 * scaduto): «Connect» lo collega lì, senza lasciare la ricerca.
 */
export function GoogleConnectInvite() {
  const { t } = useTranslation();
  const account = useGoogleAccount();
  const connect = useConnectGoogle();
  if (account.isPending || account.data?.status === "connected") return null;
  const expired = account.data?.status === "expired";
  return (
    <div data-google-invite className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
      <span className="text-ink-faint">
        <GoogleDriveGlyph />
      </span>
      <p className="min-w-0 flex-1 text-ink-muted">
        {expired ? t("drive.searchInvite.expired") : t("drive.searchInvite.connect")}
      </p>
      {connect.isPending ? (
        <span role="status" className="flex items-center gap-1.5 text-ink-muted">
          <Spinner />
          {t("drive.connect.connecting")}
        </span>
      ) : (
        <button type="button" className={quietButton} onClick={() => connect.mutate()}>
          {expired ? t("drive.searchInvite.reconnect") : t("drive.searchInvite.connectAction")}
        </button>
      )}
      {connect.isError && (
        <p role="alert" className="w-full text-critical">
          {t("drive.connect.error")}
        </p>
      )}
    </div>
  );
}
