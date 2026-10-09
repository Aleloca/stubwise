import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import type { ProjectsStackParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
import { docsKeys } from "../../lib/docs-mutations";
import { milestoneKeys, projectKeys, serverKeys } from "../../lib/query-keys";
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
import { ProjectTab } from "./hub/ProjectTab";
import { hubKeys } from "./hub/hub-keys";
import { MergeSheet, type MergeTarget } from "./hub/MergeSheet";
import { useRelease } from "../../lib/release-mutations";

/** Le tre tab del dettaglio (design v3 §3). */
type HubTabKey = "now" | "work" | "project";

/** Vedi `InboxScreen.tsx` per il perché di una costante invece di leggere `styles.body.paddingBottom`. */
const CONTENT_BASE_BOTTOM_PADDING = 40;

/**
 * Dettaglio di UN progetto, v3 a TRE TAB (28 set 2026, design
 * `docs/plans/2026-09-28-project-hub-v3-design.md`, riferimento visivo
 * `docs/design/project-detail/Dettaglio Progetto v3.dc.html`):
 *  - **Adesso** (`hub/NowTab.tsx`) — cosa c'è da fare ORA: «Tocca a te»,
 *    «In esecuzione», «Aspetta altri · fermi», il banner del monitor;
 *  - **Lavoro** (`hub/WorkTab.tsx`) — ticket, backlog, notifiche;
 *  - **Progetto** (`hub/ProjectTab.tsx`) — repository, documentazione,
 *    roadmap, monitor, impostazioni.
 * Il merge dall'app (`hub/MergeSheet.tsx`) si apre da «Tocca a te».
 *
 * Guidato dalla STESSA query di `ProjectsScreen` (`projectsPulseKey`): se la
 * lista è già in cache il dettaglio appare subito, senza un secondo fetch —
 * stesso principio di `InboxCardScreen` che riusa `inboxKeys.list()`. Non
 * esiste una rotta "un solo progetto" nel polso: la ricerca per id è locale.
 * Il polso è l'unico GATE della schermata; ogni altra lettura è accessoria e
 * sta fuori, così un suo guasto non la porta giù.
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
            // `popTo`, non `navigate`: con react-navigation 7 `navigate("List")`
            // da qui spingerebbe una SECONDA List sopra il dettaglio.
            onBack={() => navigation.popTo("List")}
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
            {tab === "project" && (
              <View testID="hub-panel-project">
                <ProjectTab
                  projectId={summary.projectId}
                  projectName={summary.projectName}
                  servers={serversQuery}
                  alert={alert}
                  navigation={navigation}
                />
              </View>
            )}
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
});
