import { Link, useRouterState } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  useChatChannels,
  useDocSpaces,
  usePeople,
  useProject,
  useOpenPrs,
  useProjectAutomations,
  useProjectServers,
  useReleases,
} from "../data/queries";
import { PROJECT_SECTIONS, PROJECT_SETTINGS_SECTIONS } from "../data/routes";
import type { ChannelRow, Project } from "../data/types";
import { can, useViewer } from "../data/viewer";
import {
  ChannelLink,
  MentionPill,
  projectChatTo,
  useChatKeys,
  useOpenChatDialog,
} from "../pages/chat/ChatColumn";
import { inColumn } from "../pages/chat/column";
import { PlusGlyph } from "../pages/chat/glyphs";
import { ProjectAlerts } from "./ProjectAlerts";

/** Una riga, ellissi in fondo. Inline perché il test la legge dallo stile calcolato. */
export const ONE_LINE: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export const columnItemClass =
  "flex h-8 min-w-0 items-center gap-2 rounded-md px-2.5 text-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink active:bg-ink/10 aria-[current=page]:bg-ink/10 aria-[current=page]:font-medium aria-[current=page]:text-ink";

function sectionsOf(project: Project) {
  return PROJECT_SECTIONS.filter((s) => !("module" in s) || project.modules.includes(s.module));
}

function Header({ code, project }: { code: string; project?: Project | null }) {
  const { t } = useTranslation();
  const kind = project
    ? project.kind === "client"
      ? [t("column.client"), project.clientName].filter(Boolean).join(" · ")
      : t("column.internal")
    : null;
  return (
    <header className="relative shrink-0 border-b border-rule px-4 pt-4 pb-3">
      {/* Gli avvisi del progetto, sulla riga del codice (shape alerts.md [A 14]). */}
      {project && (
        <span className="absolute top-[19px] right-3">
          <ProjectAlerts projectId={project.id} code={project.code} />
        </span>
      )}
      {/* Il codice è l'ancora, a scala di titolo; il nome sotto, fino a due righe. */}
      <h2 className="flex min-w-0 flex-col gap-1">
        <span data-column-code className="num text-2xl font-semibold tracking-[-0.01em] text-ink">
          {project?.code ?? code.toUpperCase()}
        </span>{" "}
        {project && (
          <span title={project.name} className="line-clamp-2 min-w-0 text-lg font-semibold">
            {project.name}
          </span>
        )}
      </h2>
      {kind && (
        <p title={kind} style={ONE_LINE} className="mt-1 text-xs text-ink-muted">
          {kind}
        </p>
      )}
    </header>
  );
}

/**
 * Colonna di un progetto: testata (codice, nome, interno/cliente) e le
 * sezioni nell'ordine di `PROJECT_SECTIONS`, senza quelle dei moduli spenti.
 * «Settings» c'è sempre; senza `project.settings.manage` è in sola lettura.
 */
export function ProjectColumn({ code }: { code: string }) {
  const { viewer } = useViewer();
  const { data: project, isPending } = useProject(code);

  if (isPending || !project) return <Header code={code} project={isPending ? undefined : null} />;

  const canManage = can(viewer, "project.settings.manage", project.id);
  return <ProjectSections project={project} canManage={canManage} />;
}

/**
 * La sezione «Chat» porta le menzioni del progetto; da corrente si apre in
 * sottovoci rientrate con i canali del progetto in cui si è — gli stessi
 * della Chat, con gli stessi segnali (shape chat.md §6).
 */
function ProjectSections({
  project,
  canManage,
}: {
  project: Project;
  canManage: boolean;
}) {
  const { t } = useTranslation();
  const chat = useChatChannels({ scope: "project", projectId: project.id });
  const onChat = useRouterState({
    select: (s) => new RegExp(`^/p/${project.code}/chat(/|$)`).test(s.location.pathname),
  });
  const onDocs = useRouterState({
    select: (s) => new RegExp(`^/p/${project.code}/docs(/|$)`).test(s.location.pathname),
  });
  const onSettings = useRouterState({
    select: (s) => new RegExp(`^/p/${project.code}/settings(/|$)`).test(s.location.pathname),
  });
  const channels = (chat.data ?? []).filter(inColumn).sort(
    (a, b) => Number(b.isGeneral) - Number(a.isGeneral) || a.name.localeCompare(b.name),
  );
  const mentions = channels.reduce((n, c) => n + c.mentions, 0);
  // «Automations» solo se c'è qualcosa o chi guarda può crearne [A 22]; conta le esecuzioni in corso.
  const automations = useProjectAutomations(project.id).data;
  const running = automations?.runs.length ?? 0;
  const sections = sectionsOf(project).filter((s) => s.id !== "automations" || automations?.show);
  // «Releases» ([R 6]): il conteggio delle PR aperte; il punto pieno solo per un
  // rilascio fallito che aspetta chi guarda (destinatario obbligatorio, senza riparazione).
  const hasReleases = sections.some((s) => s.id === "releases");
  const openPrs = useOpenPrs(hasReleases ? project.id : undefined).data?.length ?? 0;
  const releaseWaits = (useReleases(hasReleases ? project.id : undefined).data ?? []).some(
    (r) => r.waitsOnViewer,
  );
  // «Servers» ([S 9]): il numero dei server; un punto di stato al suo posto
  // quando uno non risponde (`critical`) o è in difficoltà (`warning`), con
  // la frase per i lettori di schermo: il colore non è l'unico segnale.
  const hasServers = sections.some((s) => s.id === "servers");
  const serverRows = useProjectServers(hasServers ? project.id : undefined).data ?? [];
  const serversDown = serverRows.filter((s) => s.health.health === "down").length;
  const serversTrouble = serverRows.filter((s) => s.health.health === "trouble").length;
  const serversLabel = [
    serversDown > 0 ? t("servers.column.down", { count: serversDown }) : null,
    serversTrouble > 0 ? t("servers.column.trouble", { count: serversTrouble }) : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <>
      <Header code={project.code} project={project} />
      <nav
        aria-label={t("column.projectSections")}
        className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
      >
        <ul className="flex flex-col gap-px">
          {sections.map((s) => (
            <li
              key={s.id}
              className={s.id === "settings" ? "mt-2 border-t border-rule pt-2" : undefined}
            >
              <Link
                // «Docs» ha la sua route (`/p/$code/docs`): il link la nomina, o il
                // router avverte che `/p/$code/$section` porta a un'altra.
                {...(s.id === "docs"
                  ? { to: "/p/$code/docs", params: { code: project.code } }
                  : { to: "/p/$code/$section", params: { code: project.code, section: s.id } })}
                data-section={s.id}
                // Nella Chat il canale aperto è la sottovoce corrente, non la sezione;
                // in Settings, la sezione aperta.
                activeOptions={{ exact: s.id === "chat" || s.id === "settings" }}
                style={{ whiteSpace: "nowrap" }}
                className={columnItemClass}
              >
                <span style={ONE_LINE} className="min-w-0">
                  {t(`project.sections.${s.id}`)}
                </span>
                {s.id === "chat" && mentions > 0 && (
                  <span className="ml-auto flex">
                    <span className="sr-only">
                      {t("chat.column.mentions", { count: mentions })}
                    </span>
                    <MentionPill count={mentions} />
                  </span>
                )}
                {s.id === "automations" && running > 0 && (
                  <span className="num ml-auto shrink-0 text-xs font-normal text-ink-faint">
                    <span className="sr-only">
                      {t("automations.column.runningInProject", { count: running })}
                    </span>
                    <span aria-hidden="true">{running}</span>
                  </span>
                )}
                {s.id === "releases" && (releaseWaits || openPrs > 0) && (
                  <span className="ml-auto flex shrink-0 items-center gap-2">
                    {releaseWaits && (
                      <>
                        <span
                          aria-hidden="true"
                          data-waiting-dot
                          className="size-2 shrink-0 rounded-full bg-ink"
                        />
                        <span className="sr-only">{t("releases.column.waiting")}</span>
                      </>
                    )}
                    {openPrs > 0 && (
                      <span className="num text-xs font-normal text-ink-faint">
                        <span className="sr-only">
                          {t("releases.column.openPrs", { count: openPrs })}
                        </span>
                        <span aria-hidden="true">{openPrs}</span>
                      </span>
                    )}
                  </span>
                )}
                {s.id === "servers" && serverRows.length > 0 && (
                  <span className="ml-auto flex shrink-0 items-center">
                    {serversDown + serversTrouble > 0 ? (
                      <>
                        <span
                          aria-hidden="true"
                          data-servers-dot={serversDown > 0 ? "down" : "trouble"}
                          title={serversLabel}
                          className={`size-1.5 shrink-0 rounded-full ${serversDown > 0 ? "bg-critical" : "bg-warning"}`}
                        />
                        <span className="sr-only">{serversLabel}</span>
                      </>
                    ) : (
                      <span className="num text-xs font-normal text-ink-faint">
                        <span className="sr-only">
                          {t("servers.column.count", { count: serverRows.length })}
                        </span>
                        <span aria-hidden="true">{serverRows.length}</span>
                      </span>
                    )}
                  </span>
                )}
                {s.id === "settings" && !canManage && (
                  <span className="ml-auto shrink-0 text-xs font-normal text-ink-faint">
                    {t("column.viewOnly")}
                  </span>
                )}
              </Link>
              {s.id === "chat" && onChat && (
                <ProjectChatChannels project={project} channels={channels} />
              )}
              {s.id === "docs" && onDocs && <ProjectDocSpaces project={project} />}
              {s.id === "settings" && onSettings && <ProjectSettingsSections project={project} />}
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}

/**
 * «Settings», da corrente, si apre nelle sue sezioni come voci rientrate da
 * 32 px, una pagina ciascuna (area 9a, [RM 4]); quelle dei moduli spenti no.
 */
function ProjectSettingsSections({ project }: { project: Project }) {
  const { t } = useTranslation();
  const sections = PROJECT_SETTINGS_SECTIONS.filter(
    (s) => !("module" in s) || project.modules.includes(s.module),
  );
  return (
    <ul
      aria-label={t("settings.sections.label", { code: project.code })}
      className="mt-px flex flex-col gap-px"
    >
      {sections.map((s) => (
        <li key={s.id}>
          <Link
            to="/p/$code/settings/$section"
            params={{ code: project.code, section: s.id }}
            data-settings-section={s.id}
            style={{ whiteSpace: "nowrap" }}
            className={`${columnItemClass} pl-7`}
          >
            <span style={ONE_LINE} className="min-w-0">
              {t(`settings.sections.${s.id}`)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * La sezione «Docs», da corrente, si apre in sottovoci rientrate: una per
 * spazio di repository, col numero di pagine (shape docs.md, A 1). Con un
 * solo repository nessuna sottovoce: la sezione basta.
 */
function ProjectDocSpaces({ project }: { project: Project }) {
  const { t } = useTranslation();
  const spaces = useDocSpaces(project.id).data ?? [];
  if (spaces.length < 2) return null;
  return (
    <ul aria-label={t("docs.space.columnLabel", { code: project.code })} className="mt-px flex flex-col gap-px">
      {spaces.map((space) => (
        <li key={space.repositoryId}>
          <Link
            to="/p/$code/docs/$repo"
            params={{ code: project.code, repo: space.name }}
            title={space.name}
            style={{ whiteSpace: "nowrap" }}
            className={`${columnItemClass} h-7 pl-7 text-sm`}
          >
            <span style={ONE_LINE} className="min-w-0 flex-1">
              {space.name}
            </span>
            <span className="num shrink-0 text-xs text-ink-faint">{space.pageCount}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function ProjectChatChannels({ project, channels }: { project: Project; channels: ChannelRow[] }) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const people = usePeople().data;
  const openDialog = useOpenChatDialog();
  useChatKeys(channels, (row) => projectChatTo(project.code, row.id));
  return (
    <ul aria-label={t("chat.column.projectChannels", { code: project.code })} className="mt-px flex flex-col gap-px">
      {channels.map((row) => (
        <li key={row.id}>
          <ChannelLink row={row} to={projectChatTo(project.code, row.id)} people={people} nested />
        </li>
      ))}
      {can(viewer, "chat.channels.create", project.id) && (
        <li>
          <button
            type="button"
            onClick={() => openDialog("newChannel", project.code)}
            className={`${columnItemClass} h-7 w-full pl-7 text-sm`}
          >
            <PlusGlyph size={13} />
            <span style={ONE_LINE} className="min-w-0">
              {t("chat.column.newChannel")}
            </span>
          </button>
        </li>
      )}
    </ul>
  );
}
