import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
  redirect,
  useRouterState,
  useSearch,
  type RouterHistory,
} from "@tanstack/react-router";
import { AppLayout } from "./layout/AppLayout";
import { Placeholder } from "./pages/Placeholder";
import { NotFound } from "./pages/NotFound";
import { ProjectNotFound } from "./pages/ProjectNotFound";
import { useTranslation } from "react-i18next";
import { useChatChannels, useEntryGate, useProject } from "./data/queries";
import { LoginPage } from "./pages/entry/LoginPage";
import { RegisterPage } from "./pages/entry/RegisterPage";
import { ResetPasswordPage } from "./pages/entry/ResetPasswordPage";
import { SetupPage } from "./pages/entry/SetupPage";
import {
  APP_ROUTES,
  PEOPLE_SEARCH_KEYS,
  PROJECT_SECTIONS,
  isPeopleSearchValue,
  isProjectSection,
  isValidSearchParam,
} from "./data/routes";
import { can, useViewer } from "./data/viewer";
import {
  AdminIndex,
  AdminSectionPage,
  AdminInvitePage,
  AdminPersonPage,
  AdminRolePage,
} from "./pages/admin/AdminLayout";
import type { FilterCriteria } from "./data/types";
import { parseCriteria } from "./domain/filters";
import { TasksPage } from "./pages/tasks/TasksPage";
import { AllFiltersPage } from "./pages/filters/AllFiltersPage";
import { FilterPage } from "./pages/filters/FilterPage";
import { HomePage } from "./pages/home/HomePage";
import { MyWeekPage } from "./pages/week/MyWeekPage";
import { PlanningPage } from "./pages/planning/PlanningPage";
import { RequestsPage } from "./pages/requests/RequestsPage";
import { OverviewPage } from "./pages/overview/OverviewPage";
import { AllProjectsPage } from "./pages/projects/AllProjectsPage";
import { ProjectSettingsPage } from "./pages/settings/ProjectSettingsPage";
import { ClaudePage, ConversationPage } from "./pages/claude/ClaudePage";
import { ChannelView, chatHref, type ChannelHref } from "./pages/chat/ChannelView";
import { ChatPage } from "./pages/chat/ChatPage";
import { rememberLastChannel } from "./pages/chat/column";
import { SEARCH_PARAM_KEYS, isSearchParamValue } from "./pages/chat/search";
import { useChatChannel } from "./data/queries";
import { useEffect, useRef } from "react";
import { DocsHome, DocsProjectGate } from "./pages/docs/DocsHome";
import { DocSpace, RepoIndex } from "./pages/docs/DocSpace";
import { DocPageRoute } from "./pages/docs/DocPageView";
import { DocGraph } from "./pages/docs/DocGraph";
import { DocReleases } from "./pages/docs/DocReleases";
import { RepoBrief } from "./pages/docs/RepoBrief";
import { EditManualPageRoute, NewManualPageRoute } from "./pages/docs/ManualPageForm";
import { DrivePage } from "./pages/drive/DrivePage";
import { DRIVE_SEARCH_KEYS, isDriveSearchValue } from "./pages/drive/driveFilters";
import { MailPage } from "./pages/mail/MailPage";
import { MAIL_SEARCH_KEYS, NO_PROJECT, isMailSearchValue } from "./pages/mail/mailFilters";
import { CalendarPage } from "./pages/calendar/CalendarPage";
import { CALENDAR_SEARCH_KEYS } from "./pages/calendar/calendarParams";
import {
  AutomationRoutePage,
  AutomationsPage,
  RunRoutePage,
} from "./pages/automations/AutomationsPage";
import {
  AUTOMATION_SEARCH_KEYS,
  isAutomationSearchValue,
} from "./pages/automations/automationParams";
import { ProjectAutomationsPage } from "./pages/automations/ProjectAutomations";
import { SourcesPage } from "./pages/automations/SourcesPage";
import { BuilderRoutePage } from "./pages/automations/builder/BuilderPage";
import { TestRoutePage } from "./pages/automations/test/TestPage";
import { PreferencesPage, isPreferenceSection } from "./pages/preferences/PreferencesPage";
import { ReleasesPage } from "./pages/releases/ReleasesPage";
import { ReleaseDetail } from "./pages/releases/ReleaseDetail";
import { ServerDetail } from "./pages/servers/ServerDetail";
import { ServersPage } from "./pages/servers/ServersPage";
import { ConversationNotFound, SupportPage } from "./pages/support/SupportPage";
import { PageError } from "./tasks-ui/PageStates";
import { useSupportConversation } from "./data/queries";

/** La ricerca che ogni route accetta (`?task=` apre il pannello, gli altri li montano i dialoghi). */
export interface AppSearch {
  task?: string;
  newTask?: string;
  project?: string;
  newRequest?: string;
  request?: string;
  /** Con `request`: la richiesta si apre nella conversazione di refine (`1`). */
  refine?: string;
  /** Il brief settimanale aperto nel pannello (Overview). */
  brief?: string;
  view?: string;
  group?: string;
  /** Criteri di una pagina di task (oggetto JSON nell'indirizzo). */
  filters?: FilterCriteria;
  /** Destinazione «Claude»: l'elenco aperto (`live`, `mine`, `public`, `finished`). */
  scope?: string;
  /** Destinazione «Claude»: la domanda scritta nella palette («Ask Claude…»), da rivedere e mandare. */
  ask?: string;
  /** All projects → Activity, per persona: il giorno (YYYY-MM-DD). */
  date?: string;
  /** All projects → Activity, per persona: il reparto. */
  dept?: string;
  /** Chat: il thread aperto nel pannello (l'id della radice). */
  thread?: string;
  /** Chat: il messaggio da portare in vista (link, menzione, ricerca). */
  message?: string;
  /** Chat: le impostazioni del canale aperte nel pannello (`1`). */
  settings?: string;
  /** Chat: il dialogo «New message» (`1`). */
  newMessage?: string;
  /** Chat: il dialogo «New channel» (`1`, `company` o il codice del progetto). */
  newChannel?: string;
  /** Chat → ricerca: la query e i filtri (`pages/chat/search.ts`). */
  q?: string;
  in?: string;
  by?: string;
  when?: string;
  since?: string;
  until?: string;
  att?: string;
  cit?: string;
  ppl?: string;
  /** Il dettaglio di un file del Drive (`AUD-F7`): vale ovunque, come `task`. */
  file?: string;
  /** Drive: ordinamento e filtri (`pages/drive/driveFilters.ts`). */
  sort?: string;
  type?: string;
  source?: string;
  addedBy?: string;
  prj?: string;
  hidden?: string;
  /** Posta: la casella e l'importanza (`pages/mail/mailFilters.ts`); `project` e `q` sopra. */
  mailbox?: string;
  importance?: string;
  /** Posta: la nuova email nel pannello di lettura (`new`). */
  compose?: string;
  /** Calendario: l'evento e la serie aperti nel pannello (`view` e `date` sopra). */
  event?: string;
  series?: string;
  /** Calendario: ⌘K «New meeting» apre il dialogo all'arrivo (`1`). */
  newMeeting?: string;
  /** Automations: i filtri dell'elenco, la riga del registro, la sorgente aperta (`automationParams.ts`). */
  general?: string;
  status?: string;
  owner?: string;
  automation?: string;
  mine?: string;
  entry?: string;
  /** Automations: porta alla sezione Problems di un'automazione (`1`). */
  problems?: string;
  /** Automations: il passo selezionato nel costruttore (percorso R-J5 o `trigger`). */
  step?: string;
  /** Automations: si arriva al costruttore dall'elenco (`list`). */
  from?: string;
  /** Releases: il pannello di una PR aperta (l'id). */
  pr?: string;
  /** Support → Widget: il pannello di un widget (l'id, o `new`). */
  widget?: string;
  /** Il dettaglio di un server: intervallo dei grafici, controllo selezionato, parte in vista. */
  range?: string;
  check?: string;
  section?: string;
  /** Departments (area 9a): il pannello del reparto aperto. */
  department?: string;
  /** People (area 9a): i filtri dell'elenco e «Invite someone» (`data/routes.ts`). */
  find?: string;
  depts?: string;
  roles?: string;
  statuses?: string;
  invite?: string;
}

const SEARCH_KEYS = [
  "task",
  "newTask",
  "project",
  "newRequest",
  "request",
  "refine",
  "brief",
  "view",
  "group",
  "scope",
  "ask",
  "date",
  "dept",
  "thread",
  "message",
  "settings",
  "newMessage",
  "newChannel",
  ...SEARCH_PARAM_KEYS,
  "file",
  ...DRIVE_SEARCH_KEYS,
  ...MAIL_SEARCH_KEYS,
  ...CALENDAR_SEARCH_KEYS,
  ...AUTOMATION_SEARCH_KEYS,
  "pr",
  "widget",
  "range",
  "check",
  "section",
  "department",
  ...PEOPLE_SEARCH_KEYS,
] as const;

/**
 * Un parametro malformato si scarta in silenzio (non rompe la route). `request`,
 * `view`, `group` e `filters` valgono solo sulla loro route: lì vengono
 * riletti dal componente. `filters` arriva già come oggetto (il parser
 * dell'indirizzo legge il JSON): si tiene ciò che ha la forma di criteri.
 */
function validateSearch(search: Record<string, unknown>): AppSearch {
  const out: AppSearch = {};
  for (const key of SEARCH_KEYS) {
    // Il parser dell'indirizzo legge `1` come numero: si rilegge come testo.
    const raw = search[key];
    const value = typeof raw === "number" ? String(raw) : raw;
    // Esplicitamente `undefined`: il router fonde la ricerca grezza con questa,
    // e una chiave solo omessa resterebbe com'era scritta nell'indirizzo.
    out[key] = undefined;
    if (typeof value !== "string") continue;
    // `request` e `view` dipendono dal percorso: qui si controlla la forma, la route decide.
    const shapeOk =
      (PEOPLE_SEARCH_KEYS as readonly string[]).includes(key)
        ? isPeopleSearchValue(key, value)
        : (AUTOMATION_SEARCH_KEYS as readonly string[]).includes(key)
        ? isAutomationSearchValue(key, value)
        : (SEARCH_PARAM_KEYS as readonly string[]).includes(key)
        ? isSearchParamValue(key, value)
        : (DRIVE_SEARCH_KEYS as readonly string[]).includes(key)
          ? // `source` è anche il pannello di una sorgente delle Automations (un id).
            isDriveSearchValue(key, value) || (key === "source" && /^[\w-]+$/.test(value))
          : (MAIL_SEARCH_KEYS as readonly string[]).includes(key) ||
              (key === "project" && value === NO_PROJECT)
            ? isMailSearchValue(key, value)
            : key === "request" ||
      key === "event" ||
      key === "series" ||
      key === "brief" ||
      key === "dept" ||
      key === "department" ||
      key === "thread" ||
      key === "message" ||
      key === "pr" ||
      key === "widget" ||
      key === "check"
        ? /^[\w-]+$/.test(value)
        : key === "range"
          ? /^(1h|24h|7d)$/.test(value)
          : key === "section"
            ? /^[a-z]+$/.test(value)
        : key === "date"
          ? /^\d{4}-\d{2}-\d{2}$/.test(value)
          : key === "view" || key === "group" || key === "scope"
            ? /^[a-z-]+$/.test(value)
            : key === "ask"
              ? value.trim().length > 0 && value.length <= ASK_MAX
              : key === "refine" || key === "settings" || key === "newMeeting"
                ? value === "1"
                : false;
    if (shapeOk || isValidSearchParam("", key, value)) out[key] = value;
  }
  out.filters = parseCriteria(search.filters) ?? undefined;
  return out;
}

/** Quanto può essere lunga una domanda portata dalla palette. */
const ASK_MAX = 2000;

/** Le rotte d'ingresso: fuori dall'intelaiatura (niente binario né colonna). */
const ENTRY_PATH = /^\/(login|setup|register\/[^/]+|reset-password\/[^/]+)\/?$/;

/**
 * Il cancello dell'ingresso (area 9a, shape `entry.md`). Con l'istanza vuota
 * ogni rotta porta al primo avvio, e `/setup` con l'istanza piena porta al
 * login (o alla Home, se si è dentro). Fuori, ogni rotta dell'app porta al
 * login. Le rotte d'ingresso si disegnano da sole, senza `AppLayout`.
 */
function EntryGate() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { stage, empty } = useEntryGate();
  if (empty) return pathname === "/setup" ? <Outlet /> : <Navigate to="/setup" replace />;
  if (pathname === "/setup") return <Navigate to={stage === "in" ? "/home" : "/login"} replace />;
  if (ENTRY_PATH.test(pathname)) return <Outlet />;
  if (stage !== "in") return <Navigate to="/login" replace />;
  return <AppLayout />;
}

const rootRoute = createRootRoute({
  component: EntryGate,
  notFoundComponent: NotFound,
  validateSearch,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

function RegisterRoutePage() {
  const { token } = registerRoute.useParams();
  // Un altro link rimonta la pagina: niente modulo a metà dell'invito di prima.
  return <RegisterPage key={token} token={token} />;
}

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/register/$token",
  component: RegisterRoutePage,
});

function ResetPasswordRoutePage() {
  const { token } = resetPasswordRoute.useParams();
  return <ResetPasswordPage key={token} token={token} />;
}

/** Il link di reset della password (area 9a): una pagina dell'ingresso, come l'invito. */
const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reset-password/$token",
  component: ResetPasswordRoutePage,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  component: SetupPage,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/home", replace: true });
  },
});

/** Cambiare persona rimonta la pagina: nessuna carta presa né menu a metà resta aperto. */
function PlanningRoutePage() {
  const { viewer } = useViewer();
  // «Planning» trasversale: solo a chi ha `planning.others` in almeno un progetto.
  if (!can(viewer, "planning.others")) return <Navigate to="/home" replace />;
  return <PlanningPage key={viewer.personId} />;
}

function FilterRoutePage() {
  const { id } = filterRoute.useParams();
  return <FilterPage id={id} />;
}

/**
 * `/home`: la Home a blocchi; `?view=week` è La mia settimana a pagina
 * intera (Task 10). Cambiare persona rimonta la Home: nessuna modifica a
 * metà della persona precedente resta aperta.
 */
function HomeRoutePage() {
  const { viewer } = useViewer();
  const search = useSearch({ strict: false }) as { view?: string };
  if (search.view === "week") return <MyWeekPage key={viewer.personId} />;
  return <HomePage key={viewer.personId} />;
}

/** Cambiare persona rimonta il portafoglio: filtri e dialoghi della persona di prima non restano. */
function ProjectsRoutePage() {
  const { viewer } = useViewer();
  return <AllProjectsPage key={viewer.personId} />;
}

/** Il Drive di tutti i progetti: cambiare persona lo rimonta (caricamenti, selezione e menu via). */
function DriveRoutePage() {
  const { viewer } = useViewer();
  return <DrivePage key={viewer.personId} />;
}

/**
 * La Posta (`/mail`, `/mail/<threadId>`): cambiare persona la rimonta —
 * schede in modifica, passi «fuori dal progetto», menu e conversazione
 * della persona di prima non restano.
 */
function MailRoutePage() {
  const { viewer } = useViewer();
  // Sopravvive al rimontaggio: la pagina nuova sa che la persona è appena cambiata.
  const switchedPersona = useRef(false);
  return <MailPage key={viewer.personId} switchedPersona={switchedPersona} />;
}

/**
 * Il Calendario (`/calendar?view&date&event&series`): cambiare persona lo
 * rimonta — dialoghi, spostamenti e menu della persona di prima non restano.
 */
function CalendarRoutePage() {
  const { viewer } = useViewer();
  return <CalendarPage key={viewer.personId} />;
}

/** `/preferences` porta alla sola sezione costruita, Notifiche, tenendo la ricerca. */
function PreferencesLanding() {
  return (
    <Navigate
      to="/preferences/$section"
      params={{ section: "notifications" }}
      search={(prev: Record<string, unknown>) => prev}
      replace
    />
  );
}

/**
 * Una sezione delle Preferenze (`/preferences/notifications`); una sezione
 * che non c'è torna a Notifiche. `?project=AUD` apre quel gruppo.
 */
function PreferencesRoutePage() {
  const { section } = preferencesSectionRoute.useParams();
  const search = useSearch({ strict: false }) as { project?: string };
  if (!isPreferenceSection(section)) return <PreferencesLanding />;
  return <PreferencesPage section={section} focusCode={search.project} />;
}

function pageOf(name: (typeof APP_ROUTES)[number]) {
  if (name === "admin") return AdminIndex;
  if (name === "planning") return PlanningRoutePage;
  if (name === "filters") return AllFiltersPage;
  if (name === "home") return HomeRoutePage;
  if (name === "projects") return ProjectsRoutePage;
  if (name === "claude") return ClaudePage;
  if (name === "chat") return ChatPage;
  if (name === "drive") return DriveRoutePage;
  if (name === "mail") return MailRoutePage;
  if (name === "calendar") return CalendarRoutePage;
  if (name === "automations") return AutomationsPage;
  if (name === "preferences") return PreferencesLanding;
  return () => <Placeholder titleKey={`nav.${name}`} bodyKey={`placeholder.pages.${name}`} />;
}

const appRoutes = APP_ROUTES.map((name) =>
  createRoute({ getParentRoute: () => rootRoute, path: `/${name}`, component: pageOf(name) }),
);

/**
 * Una conversazione aperta nella Posta: figlia di `/mail`, così la pagina
 * (elenco, scorrimento, filtri) resta montata cambiando conversazione. La
 * legge `MailPage` dai parametri; qui non si disegna nulla.
 */
const mailRoute = appRoutes[APP_ROUTES.indexOf("mail")]!;
const mailThreadRoute = createRoute({
  getParentRoute: () => mailRoute,
  path: "$threadId",
  component: () => null,
});

function ConversationRoutePage() {
  const { id } = conversationRoute.useParams();
  return <ConversationPage id={id} />;
}

/** Una conversazione o una sessione di lavoro con Claude. */
const conversationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/claude/$id",
  component: ConversationRoutePage,
});

/**
 * Un canale della Chat. Cambiare persona (o canale) lo rimonta: nessun
 * messaggio, bozza, riga «New» o invio a metà di chi guardava prima resta.
 * La colonna e l'atterraggio di `/chat` arrivano con la destinazione.
 */
function ChatChannelRoutePage() {
  const { channelId } = chatChannelRoute.useParams();
  const { viewer } = useViewer();
  const search = useSearch({ strict: false }) as { message?: string; thread?: string };
  // L'atterraggio di `#/chat` riapre l'ultimo canale aperto (shape chat.md §6).
  useEffect(() => rememberLastChannel(viewer.personId, channelId), [viewer.personId, channelId]);
  return (
    <ChannelView
      key={`${viewer.personId}:${channelId}`}
      channelId={channelId}
      focusMessageId={search.message}
      openThreadId={search.thread}
    />
  );
}

const chatChannelRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat/$channelId",
  component: ChatChannelRoutePage,
});

/** I link del canale dentro la sezione Chat del progetto: restano nel progetto. */
const projectChatHref =
  (code: string, channelId: string): ChannelHref =>
  (params) =>
    chatHref(channelId)(params).replace(/^#\/chat\//, `#/p/${code}/chat/`);

/**
 * La sezione Chat del progetto (`/p/<CODE>/chat`): atterra sul «general»
 * del progetto. Lo stesso `ChannelView` e gli stessi letti della Chat.
 */
function ProjectChatLanding({ projectId, code }: { projectId: string; code: string }) {
  const { t } = useTranslation();
  const { data } = useChatChannels({ scope: "project", projectId });
  if (!data) {
    return (
      <p role="status" className="p-8 text-sm text-ink-muted">
        {t("chat.channel.loading")}
      </p>
    );
  }
  const general = data.find((c) => c.isGeneral) ?? data.find((c) => c.isMember && !c.archived);
  if (!general) {
    return (
      <Placeholder titleKey="project.sections.chat" bodyKey="chat.project.noChannels" />
    );
  }
  return (
    <Navigate
      to="/p/$code/chat/$channelId"
      params={{ code, channelId: general.id }}
      replace
    />
  );
}

function ProjectChatChannelRoutePage() {
  const { code, channelId } = projectChatChannelRoute.useParams();
  const { viewer } = useViewer();
  const search = useSearch({ strict: false }) as { message?: string; thread?: string };
  const { data: project, isPending } = useProject(code);
  const channel = useChatChannel(channelId);
  if (isPending) return null;
  if (!project) return <ProjectNotFound />;
  // Un canale di un altro ambito si apre nella Chat, non qui.
  if (channel.data && channel.data.projectId !== project.id) {
    return (
      <Navigate
        to="/chat/$channelId"
        params={{ channelId }}
        search={(prev: Record<string, unknown>) => prev}
        replace
      />
    );
  }
  return (
    <ChannelView
      key={`${viewer.personId}:${channelId}`}
      channelId={channelId}
      hrefFor={projectChatHref(project.code, channelId)}
      focusMessageId={search.message}
      openThreadId={search.thread}
    />
  );
}

const projectChatChannelRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$code/chat/$channelId",
  beforeLoad: ({ params }) => {
    if (upperCaseCode(params.code)) {
      throw redirect({
        to: "/p/$code/chat/$channelId",
        params: { code: params.code.toUpperCase(), channelId: params.channelId },
        search: (prev) => prev,
        replace: true,
      });
    }
  },
  component: ProjectChatChannelRoutePage,
});

/**
 * Il dettaglio di un rilascio (`#/p/AUD/releases/AUD-V3`, area 8a). Un
 * rilascio inesistente, di un progetto che non si vede o di un altro
 * progetto risponde allo stesso modo (R-G5): lo decide `ReleaseDetail`.
 * Cambiare persona rimonta la pagina.
 */
function ReleaseRoutePage() {
  const { code, release } = releaseRoute.useParams();
  const { viewer } = useViewer();
  return (
    <ReleaseDetail key={`${release}:${viewer.personId}`} projectCode={code} code={release} />
  );
}

const releaseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$code/releases/$release",
  beforeLoad: ({ params }) => {
    if (upperCaseCode(params.code) || upperCaseCode(params.release)) {
      throw redirect({
        to: "/p/$code/releases/$release",
        params: { code: params.code.toUpperCase(), release: params.release.toUpperCase() },
        search: (prev) => prev,
        replace: true,
      });
    }
  },
  component: ReleaseRoutePage,
});

/**
 * Il dettaglio di un server (`#/p/ACQ/servers/SRV-1`, area 8b). Un server
 * inesistente, invisibile o di un altro progetto risponde allo stesso modo
 * (R-G5): lo decide `ServerDetail`. Senza il modulo Servers il progetto
 * torna alla panoramica. Cambiare persona rimonta la pagina: le parti di
 * gestione compaiono o spariscono, un server non più visibile diventa «non
 * trovato».
 */
function ServerRoutePage() {
  const { t } = useTranslation();
  const { code, server } = serverRoute.useParams();
  const { viewer } = useViewer();
  const project = useProject(code);
  if (project.isError) {
    return (
      <section className="p-8">
        <PageError message={t("project.error")} onRetry={() => void project.refetch()} />
      </section>
    );
  }
  if (project.isPending) return <section className="h-full" aria-busy="true" />;
  if (!project.data) return <ProjectNotFound />;
  if (!project.data.modules.includes("servers")) {
    return <Navigate to="/p/$code/$section" params={{ code, section: "overview" }} replace />;
  }
  return <ServerDetail key={`${server}:${viewer.personId}`} projectCode={code} code={server} />;
}

const serverRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$code/servers/$server",
  beforeLoad: ({ params }) => {
    if (upperCaseCode(params.code) || upperCaseCode(params.server)) {
      throw redirect({
        to: "/p/$code/servers/$server",
        params: { code: params.code.toUpperCase(), server: params.server.toUpperCase() },
        search: (prev) => prev,
        replace: true,
      });
    }
  },
  component: ServerRoutePage,
});

/**
 * Una conversazione di Support aperta (`#/p/ACQ/support/ACQ-S2`, area 8a).
 * Una conversazione che non esiste, di un progetto che non si vede o di un
 * altro progetto danno la STESSA pagina (R-G5). Cambiare persona rimonta.
 */
function SupportConversationRoutePage() {
  const { t } = useTranslation();
  const { code, conversation } = supportConversationRoute.useParams();
  const { viewer } = useViewer();
  const project = useProject(code);
  const conv = useSupportConversation(conversation);
  // Un errore di caricamento non è «non esiste»: si dice, con «Retry».
  if (project.isError || conv.isError) {
    return (
      <section className="p-8">
        <PageError
          message={t("support.detail.error")}
          onRetry={() => {
            if (project.isError) void project.refetch();
            if (conv.isError) void conv.refetch();
          }}
        />
      </section>
    );
  }
  if (project.isPending || conv.isPending) {
    return <section className="h-full" aria-busy="true" />;
  }
  if (!project.data || !conv.data || conv.data.projectCode !== project.data.code) {
    return <ConversationNotFound />;
  }
  if (!project.data.modules.includes("support")) {
    return <Navigate to="/p/$code/$section" params={{ code, section: "overview" }} replace />;
  }
  return (
    <SupportPage
      key={`${code}:${viewer.personId}`}
      projectCode={code}
      conversationCode={conversation}
    />
  );
}

const supportConversationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$code/support/$conversation",
  beforeLoad: ({ params }) => {
    if (upperCaseCode(params.code) || upperCaseCode(params.conversation)) {
      throw redirect({
        to: "/p/$code/support/$conversation",
        params: {
          code: params.code.toUpperCase(),
          conversation: params.conversation.toUpperCase(),
        },
        search: (prev) => prev,
        replace: true,
      });
    }
  },
  component: SupportConversationRoutePage,
});

const filterRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/filters/$id",
  component: FilterRoutePage,
});

/** Un codice progetto in minuscolo (`#/p/aud`) si riporta alle maiuscole, conservando la ricerca. */
function upperCaseCode(code: string): boolean {
  return code !== code.toUpperCase();
}

const projectIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$code",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/p/$code/$section",
      params: { code: params.code.toUpperCase(), section: "overview" },
      search: (prev) => prev,
      replace: true,
    });
  },
});

function ProjectSectionPage() {
  const { code, section } = projectSectionRoute.useParams();
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const { data: project, isPending, isError, refetch } = useProject(code);
  if (isError) {
    return (
      <section role="alert" className="flex h-full flex-col items-start gap-3 p-8">
        <p className="text-md text-ink">{t("project.error")}</p>
        <button
          type="button"
          onClick={() => void refetch()}
          className="rounded-md border border-rule-strong px-3 py-1.5 text-sm font-medium text-ink hover:bg-ink/6"
        >
          {t("project.retry")}
        </button>
      </section>
    );
  }
  if (isPending) {
    return (
      <p role="status" className="p-8 text-sm text-ink-muted">
        {t("project.loading")}
      </p>
    );
  }
  if (!project) return <ProjectNotFound />;
  const def = PROJECT_SECTIONS.find((s) => s.id === section);
  const needed = def && "module" in def ? def.module : undefined;
  if (needed && !project.modules.includes(needed)) {
    return <Navigate to="/p/$code/$section" params={{ code, section: "overview" }} replace />;
  }
  if (section === "tasks") return <TasksPage projectCode={project.code} />;
  if (section === "planning") {
    return <PlanningPage key={`${project.code}:${viewer.personId}`} projectCode={project.code} />;
  }
  if (section === "overview") {
    return <OverviewPage key={`${project.code}:${viewer.personId}`} projectCode={project.code} />;
  }
  if (section === "requests") {
    return <RequestsPage key={`${project.code}:${viewer.personId}`} projectCode={project.code} />;
  }
  if (section === "chat") return <ProjectChatLanding projectId={project.id} code={project.code} />;
  if (section === "automations") {
    return (
      <ProjectAutomationsPage key={`${project.code}:${viewer.personId}`} projectCode={project.code} />
    );
  }
  if (section === "releases") {
    return (
      <ReleasesPage key={`${project.code}:${viewer.personId}`} projectCode={project.code} />
    );
  }
  if (section === "support") {
    return <SupportPage key={`${project.code}:${viewer.personId}`} projectCode={project.code} />;
  }
  if (section === "drive") {
    return <DrivePage key={`${project.code}:${viewer.personId}`} projectCode={project.code} />;
  }
  if (section === "settings") {
    return (
      <ProjectSettingsPage key={`${project.code}:${viewer.personId}`} projectCode={project.code} />
    );
  }
  if (section === "servers") {
    return <ServersPage key={`${project.code}:${viewer.personId}`} projectCode={project.code} />;
  }
  return (
    <Placeholder
      titleKey={`project.sections.${section}`}
      bodyKey={`placeholder.sections.${section}`}
    />
  );
}

const projectSectionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$code/$section",
  beforeLoad: ({ params }) => {
    const section = isProjectSection(params.section) ? params.section : "overview";
    if (section !== params.section || upperCaseCode(params.code)) {
      throw redirect({
        to: "/p/$code/$section",
        params: { code: params.code.toUpperCase(), section },
        search: (prev) => prev,
        replace: true,
      });
    }
  },
  component: ProjectSectionPage,
});

/**
 * La sezione Docs del progetto (area 5): pagina iniziale, e lo spazio di un
 * repository (per nome) con le sue viste — indice, pagina per slug, pagina
 * manuale nuova e modifica. Le route letterali (`docs`, `new`, `edit`)
 * vincono sulle parametriche (`$section`, `$slug`) per specificità; uno
 * slug `new` non può esistere (riservato dal livello dati). Cambiare
 * persona rimonta la vista: niente form né stato della persona di prima.
 */
function DocsHomeRoutePage() {
  const { code } = docsHomeRoute.useParams();
  const { viewer } = useViewer();
  return (
    <DocsProjectGate code={code}>
      {(project) => <DocsHome key={`${project.code}:${viewer.personId}`} project={project} />}
    </DocsProjectGate>
  );
}

function DocSpaceRoutePage() {
  const { code, repo } = docSpaceRoute.useParams();
  const { viewer } = useViewer();
  return (
    <DocsProjectGate code={code}>
      {(project) => (
        <DocSpace key={`${project.code}:${repo}:${viewer.personId}`} project={project} repo={repo} />
      )}
    </DocsProjectGate>
  );
}

/** Un codice progetto in minuscolo nelle route dei Docs: si riporta alle maiuscole. */
function upperCaseDocsCode(code: string, pathname: string) {
  if (upperCaseCode(code)) {
    throw redirect({
      href: pathname.replace(`/p/${code}/`, `/p/${code.toUpperCase()}/`),
      replace: true,
    });
  }
}

const docsHomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$code/docs",
  beforeLoad: ({ params, location }) => upperCaseDocsCode(params.code, location.pathname),
  component: DocsHomeRoutePage,
});

const docSpaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$code/docs/$repo",
  beforeLoad: ({ params, location }) => upperCaseDocsCode(params.code, location.pathname),
  component: DocSpaceRoutePage,
});

const docSpaceIndexRoute = createRoute({
  getParentRoute: () => docSpaceRoute,
  path: "/",
  component: RepoIndex,
});

const docNewPageRoute = createRoute({
  getParentRoute: () => docSpaceRoute,
  path: "new",
  component: NewManualPageRoute,
});

// Le viste dello spazio (Task 3): letterali, vincono su `$slug` (slug riservati).
const docBriefRoute = createRoute({
  getParentRoute: () => docSpaceRoute,
  path: "brief",
  component: RepoBrief,
});

const docReleasesRoute = createRoute({
  getParentRoute: () => docSpaceRoute,
  path: "releases",
  component: DocReleases,
});

const docGraphRoute = createRoute({
  getParentRoute: () => docSpaceRoute,
  path: "graph",
  component: DocGraph,
});

function DocPageRoutePage() {
  const { slug } = docPageRoute.useParams();
  return <DocPageRoute slug={slug} />;
}

const docPageRoute = createRoute({
  getParentRoute: () => docSpaceRoute,
  path: "$slug",
  component: DocPageRoutePage,
});

function DocEditRoutePage() {
  const { slug } = docEditRoute.useParams();
  return <EditManualPageRoute slug={slug} />;
}

const docEditRoute = createRoute({
  getParentRoute: () => docSpaceRoute,
  path: "$slug/edit",
  component: DocEditRoutePage,
});

/**
 * Le Automations (area 7): sorgenti, un'automazione, un'esecuzione, e il
 * costruttore e la prova (Task 6 e 7). `sources` è letterale: vince sul
 * codice per costruzione del router.
 */
function SourcesRoutePage() {
  const { viewer } = useViewer();
  return <SourcesPage key={viewer.personId} />;
}

const preferencesSectionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/preferences/$section",
  component: PreferencesRoutePage,
});

/**
 * L'Amministrazione (area 9a): una voce (`/admin/people`), una persona, un
 * invito. `invites` è letterale: vince su `$personId` per costruzione del
 * router.
 */
function AdminSectionRoutePage() {
  const { section } = adminSectionRoute.useParams();
  return <AdminSectionPage section={section} />;
}

const adminSectionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/$section",
  component: AdminSectionRoutePage,
});

function AdminPersonRoutePage() {
  const { personId } = adminPersonRoute.useParams();
  return <AdminPersonPage personId={personId} />;
}

const adminPersonRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/people/$personId",
  component: AdminPersonRoutePage,
});

function AdminInviteRoutePage() {
  const { inviteId } = adminInviteRoute.useParams();
  return <AdminInvitePage inviteId={inviteId} />;
}

const adminInviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/people/invites/$inviteId",
  component: AdminInviteRoutePage,
});

/** La pagina di un ruolo (`/admin/roles/$roleId`), dentro Roles. */
function AdminRoleRoutePage() {
  const { roleId } = adminRoleRoute.useParams();
  return <AdminRolePage roleId={roleId} />;
}

const adminRoleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/roles/$roleId",
  component: AdminRoleRoutePage,
});

const automationSourcesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/automations/sources",
  component: SourcesRoutePage,
});

function AutomationDetailRoutePage() {
  const { code } = automationRoute.useParams();
  return <AutomationRoutePage code={code} />;
}

const automationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/automations/$code",
  component: AutomationDetailRoutePage,
});

function AutomationRunRoutePage() {
  const { code, n } = automationRunRoute.useParams();
  return <RunRoutePage code={code} n={n} />;
}

const automationRunRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/automations/$code/runs/$n",
  component: AutomationRunRoutePage,
});

function AutomationEditRoutePage() {
  const { code } = automationEditRoute.useParams();
  return <BuilderRoutePage code={code} />;
}

const automationEditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/automations/$code/edit",
  component: AutomationEditRoutePage,
});

function AutomationTestRoutePage() {
  const { code } = automationTestRoute.useParams();
  return <TestRoutePage code={code} />;
}

const automationTestRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/automations/$code/test",
  component: AutomationTestRoutePage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  registerRoute,
  resetPasswordRoute,
  setupRoute,
  ...appRoutes.map((r) => (r === mailRoute ? mailRoute.addChildren([mailThreadRoute]) : r)),
  conversationRoute,
  preferencesSectionRoute,
  adminSectionRoute,
  adminPersonRoute,
  adminInviteRoute,
  adminRoleRoute,
  automationSourcesRoute,
  automationRoute,
  automationRunRoute,
  automationEditRoute,
  automationTestRoute,
  chatChannelRoute,
  filterRoute,
  projectIndexRoute,
  projectSectionRoute,
  projectChatChannelRoute,
  releaseRoute,
  serverRoute,
  supportConversationRoute,
  docsHomeRoute,
  docSpaceRoute.addChildren([
    docSpaceIndexRoute,
    docNewPageRoute,
    docBriefRoute,
    docReleasesRoute,
    docGraphRoute,
    docPageRoute,
    docEditRoute,
  ]),
]);

export function createAppRouter(history: RouterHistory) {
  return createRouter({ routeTree, history });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
