import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { isUnknown } from "@stubwise/shared";
import type { ProjectPulseSummary, Reader } from "@stubwise/shared";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import type { ProjectsStackParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
import { HubSection, type HubSectionState } from "../../components/projects/HubSection";
import type { ProjectGroupRowProps } from "../../components/projects/ProjectRowsCard";
import { docsKeys } from "../../lib/docs-mutations";
import { pulseValue } from "../../lib/project-settings";
import { milestoneKeys, projectKeys, serverKeys } from "../../lib/query-keys";
import { serverIsBroken, serverStatusKey } from "../../lib/server-health";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Skeleton } from "../../components/Skeleton";
import { projectsPulseKey } from "./ProjectsScreen";
import { colors } from "../../theme/tokens";
import { fontFamily } from "../../theme/typography";
import { usePullToRefresh } from "../../components/PullToRefresh";
import { HubTabBar } from "../../components/projects/HubTabBar";
import { useState } from "react";
import { monitorAlert, yourTurnCount, type HubDestination } from "../../lib/project-hub";
import { NowTab } from "./hub/NowTab";
import { WorkTab } from "./hub/WorkTab";
import { hubKeys } from "./hub/hub-keys";
import { MergeSheet, type MergeTarget } from "./hub/MergeSheet";
import { useRelease } from "../../lib/release-mutations";

/** Le tre tab del dettaglio (design v3 §3). */
type HubTabKey = "now" | "work" | "project";

/** Vedi `InboxScreen.tsx` per il perché di una costante invece di leggere `styles.body.paddingBottom`. */
const CONTENT_BASE_BOTTOM_PADDING = 40;

/** Righe delle anteprime delle sezioni lunghe (provvisorio, fino alla tab Progetto). */
const HUB_PREVIEW_LIMIT = 2;

/**
 * Dettaglio di UN progetto (canvas `2b`): l'intestazione col nome e il
 * polso, poi i gruppi ordinati per URGENZA UMANA — prima chi aspetta te
 * (ambra), poi cosa gira, poi il resto — esattamente come il canvas
 * descrive l'ordine del dettaglio. Un gruppo vuoto non si mostra affatto
 * (stesso pattern di `SECTION_ORDER` in `InboxScreen`).
 *
 * Guidato dalla STESSA query di `ProjectsScreen` (`projectsPulseKey`): se la
 * lista è già in cache il dettaglio appare subito, senza un secondo fetch —
 * stesso principio di `InboxCardScreen` che riusa `inboxKeys.list()`. Non
 * esiste una rotta "un solo progetto" nel polso: la ricerca per id è locale.
 */
export function ProjectDetailScreen({ navigation, route }: NativeStackScreenProps<ProjectsStackParamList, "Detail">) {
  const { t } = useTranslation();
  const { client, user } = useAuth();
  const tabBarHeight = useBottomTabBarHeight();
  const { id } = route.params;
  const viewerId = user?.id ?? "";

  const query = useQuery({
    queryKey: projectsPulseKey,
    queryFn: () => {
      if (!client) throw new Error("ProjectDetailScreen richiede un client autenticato");
      return client.projects.pulse();
    },
    enabled: client !== null,
    staleTime: 10_000,
    // IL POLSO SI RICARICA DA SOLO OGNI MINUTO (23 set 2026): è la parte che
    // dice cosa fare adesso, e contiene i lavori «in corso» — proprio ciò che
    // il worker cambia mentre guardi, senza che tu tocchi niente. In
    // background si ferma da solo (`focusManager`, `app/providers.tsx`).
    //
    // ⚠️ In ENTRAMBI i posti che leggono `projectsPulseKey` (`ProjectsScreen`
    // e `ProjectDetailScreen`): con l'intervallo in uno solo, lo stesso dato
    // si aggiornerebbe o no a seconda di quale schermata è montata.
    refetchInterval: 60_000,
  });

  const summary = query.data?.find((row) => row.projectId === id);
  /**
   * Il nome del progetto: titolo dell'header e — passato alla rotta `Ticket`
   * — riga «indietro» di chi apre un ticket da qui (21 set 2026). `undefined`
   * finché il polso non è arrivato: in quel caso il ticket non è nemmeno
   * apribile, quindi non c'è un caso in cui manchi davvero.
   */
  const projectName = summary?.projectName;

  // Task 7 (App M1+M2, 11 set 2026): un solo `ScrollView`, l'header come
  // primo figlio e ancorato — stesso schema di `InboxScreen.tsx`.
  // 21 set 2026: era un header fatto a mano (solo «indietro» + avatar),
  // quindi senza titolo e senza ricerca. Ora è `ScreenHeader` come ovunque:
  // il titolo è il NOME del progetto, e la ricerca c'è anche da qui.
  const refreshControl = usePullToRefresh([projectsPulseKey, hubKeys.tickets(id), hubKeys.backlog(id), hubKeys.inbox(id), projectKeys.detail(id), docsKeys.spaces(id), milestoneKeys.forProject(id), serverKeys.forProject(id)], "project-detail-refresh");

  /**
   * LA TAB SCELTA (28 set 2026, dettaglio progetto v3 §3). Stato locale e non
   * un parametro di rotta: si apre SEMPRE su Adesso, e la scelta resta finché
   * la schermata è montata — lo stack nativo la tiene montata sotto il ticket
   * aperto da qui, quindi tornando indietro si ritrova la tab di prima.
   */
  const [tab, setTab] = useState<HubTabKey>("now");

  /**
   * I SERVER DEL PROGETTO, letti QUI e non nella sola tab Progetto: il
   * pallino sulla tab e il banner di Adesso ne hanno bisogno da ovunque.
   * Stessa chiave del monitor (`serverKeys.forProject`), quindi una lettura
   * sola. È una lettura ACCESSORIA, fuori da ogni gate: se fallisce, niente
   * pallino né banner, e la schermata resta intera.
   */
  const serversQuery = useQuery({
    queryKey: serverKeys.forProject(id),
    queryFn: () => {
      if (!client) throw new Error("ProjectDetailScreen richiede un client autenticato");
      return client.servers.list(id);
    },
    enabled: client !== null,
    staleTime: 30_000,
  });
  const alert = serversQuery.data !== undefined ? monitorAlert(serversQuery.data) : null;

  /**
   * La PR di cui si sta confermando il merge (§6): il pannello di conferma
   * si apre quando c'è. Arriva dal bottone Mergia, che esiste solo con
   * `canMerge` E `repositoryId` (`lib/project-hub.ts`).
   */
  const [mergeTarget, setMergeTarget] = useState<MergeTarget | null>(null);
  const release = useRelease();
  const openMerge = (target: MergeTarget) => {
    // Un errore rimasto da un tentativo su un'ALTRA PR non deve comparire qui.
    release.reset();
    setMergeTarget(target);
  };
  const closeMerge = () => {
    if (release.isPending) return;
    setMergeTarget(null);
    release.reset();
  };

  /** Dove porta un tap sulla tab Adesso: le destinazioni le decide `lib/project-hub.ts`. */
  const open = (destination: HubDestination) => {
    const backLabel = summary?.projectName;
    const back = backLabel !== undefined ? { backLabel } : {};
    if (destination.kind === "ticket") navigation.navigate("Ticket", { id: destination.ticketId, ...back });
    else if (destination.kind === "inboxCard") navigation.navigate("Card", { id: destination.notificationId, ...back });
    else openMerge(destination);
  };
  const badge = summary !== undefined ? yourTurnCount(summary) : 0;

  return (
    <View style={styles.container}>
      <ScrollView
        refreshControl={refreshControl}
        contentContainerStyle={{ paddingBottom: CONTENT_BASE_BOTTOM_PADDING + tabBarHeight }}
        stickyHeaderIndices={[0]}
      >
        <View style={styles.header}>
          <ScreenHeader
            title={projectName ?? t("mobile.tabs.projects")}
            onBack={() => navigation.navigate("List")}
            backLabel={t("mobile.projects.detail.back")}
            titleNumberOfLines={2}
          />
          {summary !== undefined && (
            <HubTabBar
              active={tab}
              onSelect={setTab}
              tabs={[
                {
                  key: "now",
                  label: t("mobile.projects.detail.tabs.now"),
                  badge,
                  badgeLabel: t("mobile.projects.detail.tabs.badgeLabel", { count: badge }),
                },
                { key: "work", label: t("mobile.projects.detail.tabs.work") },
                {
                  key: "project",
                  label: t("mobile.projects.detail.tabs.project"),
                  alert: alert !== null,
                  alertLabel: t("mobile.projects.detail.tabs.alertLabel"),
                },
              ]}
            />
          )}
        </View>

        {query.isPending ? (
          <View style={styles.skeletonList} testID="project-detail-skeleton">
            <Skeleton height={28} width="60%" />
            <Skeleton height={140} />
          </View>
        ) : query.isError ? (
          <View style={styles.centered} testID="project-detail-error">
            <Text style={styles.errorTitle}>{t("mobile.projects.loadError.title")}</Text>
            <GhostButton
              label={t("mobile.projects.loadError.retry")}
              onPress={() => void query.refetch()}
              testID="project-detail-retry"
            />
          </View>
        ) : summary === undefined ? (
          <View style={styles.centered} testID="project-detail-not-found">
            <Text style={styles.errorTitle}>{t("mobile.projects.detail.notFound.title")}</Text>
            <Text style={styles.notFoundBody}>{t("mobile.projects.detail.notFound.body")}</Text>
          </View>
        ) : (
          <View style={styles.panel}>
            {tab === "now" && (
              <View testID="hub-panel-now">
                <NowTab
                  summary={summary}
                  viewerId={viewerId}
                  alert={alert}
                  now={new Date()}
                  onOpen={open}
                  onGoProject={() => setTab("project")}
                />
                <ProjectDetailBody summary={summary} navigation={navigation} />
              </View>
            )}
            {tab === "work" && (
              <View testID="hub-panel-work">
                <WorkTab
                  projectId={summary.projectId}
                  projectName={summary.projectName}
                  backlogReadyCount={summary.backlogReadyCount}
                  navigation={navigation}
                />
              </View>
            )}
            {tab === "project" && <View testID="hub-panel-project" />}
          </View>
        )}
      </ScrollView>
      <MergeSheet
        target={mergeTarget}
        pending={release.isPending}
        errorMessage={release.errorMessage}
        onClose={closeMerge}
        onConfirm={() => {
          if (mergeTarget === null) return;
          release.release({ ticketId: mergeTarget.ticketId, repositoryId: mergeTarget.repositoryId }, () =>
            setMergeTarget(null),
          );
        }}
      />
    </View>
  );
}

/**
 * LE SEZIONI LUNGHE di prima (provvisorio, dettaglio progetto v3): restano
 * qui sotto Adesso solo finché le tab Lavoro e Progetto non le rimpiazzano.
 */
function ProjectDetailBody({
  summary,
  navigation,
}: {
  summary: Reader<ProjectPulseSummary>;
  navigation: NativeStackScreenProps<ProjectsStackParamList, "Detail">["navigation"];
}) {
  return (
    <View style={styles.groups}>
      <HubRepositoriesSection projectId={summary.projectId} projectName={summary.projectName} navigation={navigation} />
      <HubDocsSection projectId={summary.projectId} projectName={summary.projectName} navigation={navigation} />
      <HubRoadmapSection projectId={summary.projectId} projectName={summary.projectName} navigation={navigation} />
      <HubMonitorSection projectId={summary.projectId} projectName={summary.projectName} navigation={navigation} />
      <HubSettingsSection projectId={summary.projectId} projectName={summary.projectName} navigation={navigation} />
    </View>
  );
}

type HubNavigation = NativeStackScreenProps<ProjectsStackParamList, "Detail">["navigation"];

/**
 * Lo stato comune di una sezione dell'hub a partire da una `useQuery`: in
 * attesa, in errore, o pronta — tre esiti che ogni sezione tratta allo stesso
 * modo. Il quarto (`empty`) lo decide ciascuna, perché «vuoto» vuol dire cose
 * diverse (nessun ticket aperto, backlog vuoto, niente da gestire) e merita
 * parole diverse.
 */
function hubQueryState(
  query: { isPending: boolean; isError: boolean; refetch: () => unknown },
  t: (key: string) => string,
): HubSectionState | null {
  if (query.isPending) return { kind: "pending" };
  if (query.isError) {
    return {
      kind: "error",
      message: t("mobile.projects.hub.loadError"),
      retryLabel: t("mobile.projects.hub.retry"),
      onRetry: () => void query.refetch(),
    };
  }
  return null;
}

/**
 * REPOSITORY — di quali codebase è fatto il progetto.
 *
 * ⚠️ Non costa una richiesta sua nel senso che conta: `projects.get` porta
 * già la proiezione sintetica dei repository, ed è la STESSA query (stessa
 * chiave) che usa la schermata dietro «vedi ›» — entrarci non ne fa partire
 * una seconda.
 */
function HubRepositoriesSection({
  projectId,
  projectName,
  navigation,
}: {
  projectId: string;
  projectName: string;
  navigation: HubNavigation;
}) {
  const { t } = useTranslation();
  const { client } = useAuth();

  const query = useQuery({
    queryKey: projectKeys.detail(projectId),
    queryFn: () => {
      if (!client) throw new Error("HubRepositoriesSection richiede un client autenticato");
      return client.projects.get(projectId);
    },
    enabled: client !== null,
    staleTime: 60_000,
  });

  const repositories = query.data?.repositories ?? [];
  const rows: ProjectGroupRowProps[] = repositories.slice(0, HUB_PREVIEW_LIMIT).map((repository) => ({
    rowKey: repository.id,
    title: repository.name,
    trailing: repository.slug,
    trailingTone: "muted",
    onPress: () => navigation.navigate("Repository", { slug: repository.slug, projectName }),
    testID: `hub-repository-${repository.id}`,
  }));

  const state =
    hubQueryState(query, t) ??
    (repositories.length === 0
      ? ({ kind: "empty", message: t("mobile.projects.hub.repositories.empty") } as const)
      : ({ kind: "ready", rows } as const));

  return (
    <HubSection
      testID="hub-repositories"
      label={
        query.data === undefined
          ? t("mobile.projects.hub.repositories.label")
          : t("mobile.projects.hub.repositories.labelWithCount", { count: repositories.length })
      }
      seeAllLabel={t("mobile.projects.hub.seeAll")}
      onSeeAll={() => navigation.navigate("ProjectRepositories", { projectId, projectName })}
      state={state}
    />
  );
}

/**
 * DOCUMENTAZIONE — quanti spazi documentati ha il progetto e quanto sono
 * grandi. Un «spazio» è un repository con almeno una pagina: un repository
 * senza documentazione non compare, ed è corretto — non c'è niente da
 * aprire.
 */
function HubDocsSection({
  projectId,
  projectName,
  navigation,
}: {
  projectId: string;
  projectName: string;
  navigation: HubNavigation;
}) {
  const { t } = useTranslation();
  const { client } = useAuth();

  // STESSA chiave della schermata dietro «vedi ›» (`docsKeys.spaces`), e
  // stessa risposta: qui non serve un `limit` diverso, quindi non serve
  // nemmeno una chiave diversa — al contrario di ticket, backlog e inbox.
  const query = useQuery({
    queryKey: docsKeys.spaces(projectId),
    queryFn: () => {
      if (!client) throw new Error("HubDocsSection richiede un client autenticato");
      return client.docs.projectSpaces(projectId);
    },
    enabled: client !== null,
    staleTime: 60_000,
  });

  const spaces = query.data ?? [];
  // Una riga apre la documentazione DI QUEL repository, a tab come sul web
  // (25 set 2026); «vedi ›» la pagina generale del progetto.
  const rows: ProjectGroupRowProps[] = spaces.slice(0, HUB_PREVIEW_LIMIT).map((space) => ({
    rowKey: space.repositoryId,
    title: space.name,
    trailing: t("mobile.docs.browse.pageCount", { count: space.pageCount }),
    trailingTone: "muted",
    onPress: () => navigation.navigate("RepoDocs", { repositoryId: space.repositoryId, repositoryName: space.name }),
    testID: `hub-docs-space-${space.repositoryId}`,
  }));

  const state =
    hubQueryState(query, t) ??
    (spaces.length === 0
      ? ({ kind: "empty", message: t("mobile.projects.hub.docs.empty") } as const)
      : ({ kind: "ready", rows } as const));

  return (
    <HubSection
      testID="hub-docs"
      label={
        query.data === undefined
          ? t("mobile.projects.hub.docs.label")
          : t("mobile.projects.hub.docs.labelWithCount", { count: spaces.length })
      }
      seeAllLabel={t("mobile.projects.hub.seeAll")}
      onSeeAll={() => navigation.navigate("ProjectDocs", { projectId, projectName })}
      state={state}
    />
  );
}

/**
 * ROADMAP — quante milestone ci sono e quante sono ancora aperte.
 *
 * ⚠️ Il numero in etichetta è quello delle APERTE, non il totale: di una
 * roadmap interessa quanto manca, non quanto si è accumulato. Il totale
 * resta leggibile nella schermata, dove le chiuse si vedono con le altre.
 */
function HubRoadmapSection({
  projectId,
  projectName,
  navigation,
}: {
  projectId: string;
  projectName: string;
  navigation: HubNavigation;
}) {
  const { t } = useTranslation();
  const { client } = useAuth();

  const query = useQuery({
    queryKey: milestoneKeys.forProject(projectId),
    queryFn: () => {
      if (!client) throw new Error("HubRoadmapSection richiede un client autenticato");
      return client.projects.milestones(projectId);
    },
    enabled: client !== null,
    staleTime: 60_000,
  });

  const milestones = query.data ?? [];
  // Il server manda le APERTE per prime: le prime righe dell'anteprima sono
  // quindi già quelle che contano, senza riordinare niente qui.
  const openCount = milestones.filter((milestone) => !isUnknown(milestone.status) && milestone.status === "open").length;
  const rows: ProjectGroupRowProps[] = milestones.slice(0, HUB_PREVIEW_LIMIT).map((milestone) => ({
    rowKey: milestone.id,
    title: milestone.name,
    trailing: t("mobile.projects.hub.roadmap.rowProgress", {
      completed: milestone.counts.completed,
      total: milestone.counts.total,
    }),
    trailingTone: "muted",
  }));

  const state =
    hubQueryState(query, t) ??
    (milestones.length === 0
      ? ({ kind: "empty", message: t("mobile.projects.hub.roadmap.empty") } as const)
      : ({ kind: "ready", rows } as const));

  return (
    <HubSection
      testID="hub-roadmap"
      label={
        query.data === undefined
          ? t("mobile.projects.hub.roadmap.label")
          : t("mobile.projects.hub.roadmap.labelWithCount", { count: openCount })
      }
      seeAllLabel={t("mobile.projects.hub.seeAll")}
      onSeeAll={() => navigation.navigate("ProjectRoadmap", { projectId, projectName })}
      state={state}
    />
  );
}

/**
 * MONITOR — quanti server e se qualcosa è giù: «Monitor · 2 server · 3
 * controlli giù».
 *
 * ⚠️ Il ROSSO solo quando qualcosa è DAVVERO rotto (`serverIsBroken`: server
 * offline o controlli giù). Un server appena registrato che non ha mai
 * mandato campioni non è un guasto, e un monitor che è sempre un po' rosso
 * smette di dire qualcosa.
 *
 * Stessa chiave della schermata dietro «vedi ›» (`serverKeys.forProject`):
 * chiedono la stessa risposta, senza `limit`.
 */
function HubMonitorSection({
  projectId,
  projectName,
  navigation,
}: {
  projectId: string;
  projectName: string;
  navigation: HubNavigation;
}) {
  const { t } = useTranslation();
  const { client } = useAuth();

  const query = useQuery({
    queryKey: serverKeys.forProject(projectId),
    queryFn: () => {
      if (!client) throw new Error("HubMonitorSection richiede un client autenticato");
      return client.servers.list(projectId);
    },
    enabled: client !== null,
    staleTime: 30_000,
  });

  const servers = query.data ?? [];
  const checksDown = servers.reduce((sum, server) => sum + server.checksDown, 0);

  const rows: ProjectGroupRowProps[] = servers.slice(0, HUB_PREVIEW_LIMIT).map((server) => {
    const broken = serverIsBroken(server);
    return {
      rowKey: server.id,
      title: server.name,
      // Un server online con controlli giù: il numero dei giù, che è la cosa
      // da sapere. Altrimenti lo stato.
      trailing:
        server.status === "online" && server.checksDown > 0
          ? t("mobile.projects.hub.monitor.rowChecksDown", { count: server.checksDown })
          : t(serverStatusKey(server.status)),
      trailingTone: broken ? "danger" : "muted",
      onPress: () => navigation.navigate("Server", { serverId: server.id, projectName }),
      testID: `hub-server-${server.id}`,
    };
  });

  const state =
    hubQueryState(query, t) ??
    (servers.length === 0
      ? ({ kind: "empty", message: t("mobile.projects.hub.monitor.empty") } as const)
      : ({ kind: "ready", rows } as const));

  const label =
    query.data === undefined
      ? t("mobile.projects.hub.monitor.label")
      : checksDown > 0
        ? t("mobile.projects.hub.monitor.labelWithDown", {
            servers: t("mobile.projects.hub.monitor.serverCount", { count: servers.length }),
            count: checksDown,
          })
        : t("mobile.projects.hub.monitor.labelWithCount", { count: servers.length });

  return (
    <HubSection
      testID="hub-monitor"
      label={label}
      seeAllLabel={t("mobile.projects.hub.seeAll")}
      onSeeAll={() => navigation.navigate("ProjectMonitor", { projectId, projectName })}
      state={state}
    />
  );
}

/**
 * IMPOSTAZIONI — cosa è acceso. Una riga sola, le automazioni attive: di
 * come è configurato un progetto interessa cosa FA da solo.
 *
 * Nessuna richiesta sua: è la STESSA query di repository e schermata
 * impostazioni (`projectKeys.detail`), che il salvataggio invalida — quindi
 * tornando qui dopo aver salvato la riga è già quella nuova.
 */
function HubSettingsSection({
  projectId,
  projectName,
  navigation,
}: {
  projectId: string;
  projectName: string;
  navigation: HubNavigation;
}) {
  const { t } = useTranslation();
  const { client } = useAuth();

  const query = useQuery({
    queryKey: projectKeys.detail(projectId),
    queryFn: () => {
      if (!client) throw new Error("HubSettingsSection richiede un client autenticato");
      return client.projects.get(projectId);
    },
    enabled: client !== null,
    staleTime: 60_000,
  });

  const project = query.data;
  const active: string[] = [];
  if (project !== undefined) {
    if (project.docAutoUpdate) active.push(t("mobile.projects.hub.settings.docAutoUpdate"));
    if (project.dailyReportEnabled) active.push(t("mobile.projects.hub.settings.dailyReport"));
    if (project.backlogEnabled) active.push(t("mobile.projects.hub.settings.backlog"));
    // Il pulse si dice come lo dice la schermata: acceso senza backlog è
    // «in attesa del backlog», non una cadenza che non succederà.
    const pulse = pulseValue(project);
    if (pulse.key === "mobile.projects.settings.pulseEvery") {
      active.push(t("mobile.projects.hub.settings.pulseEvery", { count: pulse.count }));
    } else if (pulse.key === "mobile.projects.settings.pulseWaitingBacklog") {
      active.push(t("mobile.projects.hub.settings.pulseWaitingBacklog"));
    }
    if (project.weeklyBriefEnabled) active.push(t("mobile.projects.hub.settings.weeklyBrief"));
  }

  const state =
    hubQueryState(query, t) ??
    ({
      kind: "ready",
      rows: [
        {
          rowKey: "settings-summary",
          title: active.length === 0 ? t("mobile.projects.hub.settings.noneActive") : active.join(" · "),
          // Stessa destinazione di «apri ›» (23 set 2026): la riga si apriva
          // solo dal bottone, e sul telefono si tocca la riga.
          onPress: () => navigation.navigate("ProjectSettings", { projectId, projectName }),
          testID: "hub-settings-summary",
        },
      ],
    } as const);

  return (
    <HubSection
      testID="hub-settings"
      label={t("mobile.projects.hub.settings.label")}
      seeAllLabel={t("mobile.projects.hub.open")}
      onSeeAll={() => navigation.navigate("ProjectSettings", { projectId, projectName })}
      state={state}
    />
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  // Task 7: niente più `paddingHorizontal`/`paddingTop` propri — vivono ora
  // in `body`, il `contentContainerStyle` dell'unico `ScrollView` che
  // avvolge SIA questo link SIA il resto (raddoppiarli qui darebbe un
  // inset doppio, visto che `backRow` non è più fratello del container ma
  // il suo primo figlio).
  // Fix di review (Task 2, 11 set 2026): `headerRow` è ora ANCORATA
  // (`stickyHeaderIndices` sullo `ScrollView` sopra) e porta anche
  // l'avatar — `backgroundColor` opaco necessario, o il contenuto sotto
  // l'attraverserebbe scorrendo.
  skeletonList: {
    gap: 12,
    padding: 20,
  },
  centered: {
    alignItems: "center",
    flex: 1,
    gap: 12,
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  errorTitle: {
    color: colors.fg,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 15,
    fontWeight: "600",
    textAlign: "center",
  },
  notFoundBody: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 14,
    textAlign: "center",
  },
  // L'intestazione ANCORATA è il nome del progetto più le tab: la linea sotto
  // le tab separa la parte fissa da quella che scorre (riferimento v3).
  // `backgroundColor` opaco: il contenuto non deve attraversarla scorrendo.
  header: {
    backgroundColor: colors.ink950,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
  },
  panel: {
    padding: 20,
  },
  pulseRow: {
    marginBottom: 8,
  },
  groups: {
    gap: 16,
  },
});
