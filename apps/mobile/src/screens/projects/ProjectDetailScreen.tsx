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
import { PulseIndicator } from "../../components/PulseIndicator";
import { HubSection, type HubSectionState } from "../../components/projects/HubSection";
import { ProjectGroup } from "../../components/projects/ProjectGroup";
import type { ProjectGroupRowProps } from "../../components/projects/ProjectRowsCard";
import { backlogKeys } from "../../lib/backlog-mutations";
import { docsKeys } from "../../lib/docs-mutations";
import { OPEN_TICKET_STATUSES } from "../../lib/project-tickets";
import { pulseValue } from "../../lib/project-settings";
import { inboxKeys, milestoneKeys, projectKeys, serverKeys, ticketKeys } from "../../lib/query-keys";
import { serverIsBroken, serverStatusKey } from "../../lib/server-health";
import { ticketHeading } from "../../lib/ticket-labels";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Skeleton } from "../../components/Skeleton";
import { pulseLineFor } from "../../lib/pulse-line";
import { stalledDays, stalledReasonKey } from "../../lib/stalled";
import { projectsPulseKey } from "./ProjectsScreen";
import { colors } from "../../theme/tokens";
import { fontFamily } from "../../theme/typography";

/** Vedi `InboxScreen.tsx` per il perché di una costante invece di leggere `styles.body.paddingBottom`. */
const CONTENT_BASE_BOTTOM_PADDING = 40;

/**
 * Quante righe vere mostra l'ANTEPRIMA di una sezione dell'hub (design §3:
 * «le prime due o tre righe»). Basso apposta: queste sei richieste partono
 * tutte all'apertura, e la sezione serve a dire *che aria tira*, non a
 * sostituire l'elenco — quello sta dietro «vedi ›».
 */
const HUB_PREVIEW_LIMIT = 2;

/**
 * Le chiavi di query delle ANTEPRIME dell'hub.
 *
 * Sono DISTINTE da quelle delle schermate piene (`ticketKeys.list`,
 * `backlogKeys.list`, `projectInboxKey`) perché chiedono un `limit` diverso:
 * la stessa chiave farebbe servire una pagina da due righe alla schermata
 * intera.
 *
 * ⚠️ **Ma stanno sotto i prefissi ESISTENTI — `["tickets"]`, `["backlog"]`,
 * `["inbox"]` — e quella è la parte che conta.** Non è un modo di
 * raggruppare: è ciò che le fa invalidare insieme al resto, da ogni
 * mutazione di oggi e da quelle che verranno. In un namespace proprio
 * (`["projects","hub",…]`, com'erano nate) nessuna invalidazione le
 * raggiungeva: questa schermata resta MONTATA sotto, nello stack nativo,
 * mentre si è nella schermata figlia, e l'app non ha refetch-on-focus da
 * nessuna parte — si tornava indietro dopo aver convertito una voce o
 * risposto a una proposta e si vedeva il numero vecchio. `staleTime` non
 * salva: una query stale rifetcha su un EVENTO, e tornare indietro senza
 * rimontare non è un evento.
 *
 * Chi le sposta «per ordine» sotto un namespace `projects` riapre quel
 * difetto.
 */
const hubKeys = {
  tickets: (projectId: string) => ticketKeys.hub(projectId),
  backlog: (projectId: string) => [...backlogKeys.all, "list", "hub", projectId] as const,
  inbox: (projectId: string) => [...inboxKeys.all, "list", "hub", projectId] as const,
};

type WaitingForOthersItem = Reader<ProjectPulseSummary>["waitingForOthers"][number];

/**
 * Ruolo di chi sblocca una voce `waitingForOthers`, nel testo del canvas
 * ("→ …"). Tipizzato sul campo REALE (`WaitingForOthersItem["who"]["kind"]`,
 * non un'unione scritta a mano che collasserebbe a `string` aggiungendoci
 * `| string`) e con `isUnknown()`, stesso trattamento di `waitingKindKey` in
 * `lib/pulse-line.ts`: se `pulseWaitingWhoKindSchema` guadagna un terzo
 * valore un domani, il compilatore lo fa notare qui esattamente come là.
 * `UNKNOWN` (server più nuovo di questa build) va allo stesso testo del
 * richiedente, il meno privilegiato dei due — mai un valore grezzo mostrato.
 */
function whoArrowKey(kind: WaitingForOthersItem["who"]["kind"]): string {
  if (!isUnknown(kind) && kind === "maintainer") return "mobile.projects.detail.waitingMaintainerArrow";
  return "mobile.projects.detail.waitingRequesterArrow";
}

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
  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: CONTENT_BASE_BOTTOM_PADDING + tabBarHeight }]}
        stickyHeaderIndices={[0]}
      >
        <ScreenHeader
          title={projectName ?? t("mobile.tabs.projects")}
          onBack={() => navigation.navigate("List")}
          backLabel={t("mobile.projects.detail.back")}
          titleNumberOfLines={2}
        />

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
          <ProjectDetailBody summary={summary} viewerId={viewerId} navigation={navigation} />
        )}
      </ScrollView>
    </View>
  );
}

function ProjectDetailBody({
  summary,
  viewerId,
  navigation,
}: {
  summary: Reader<ProjectPulseSummary>;
  viewerId: string;
  navigation: NativeStackScreenProps<ProjectsStackParamList, "Detail">["navigation"];
}) {
  const { t } = useTranslation();
  const line = pulseLineFor(summary, viewerId);

  // L'ORA della lettura, una sola per tutta la schermata: l'età dei ticket e
  // i giorni di fermo si contano da qui. I giorni li conta il CLIENT, non il
  // server — un conteggio calcolato a monte invecchia dentro una risposta in
  // cache (vedi `lib/stalled.ts`).
  const now = new Date();

  /**
   * La riga grigia di testa di una voce che è un TICKET. Un helper solo,
   * usato da tutti e cinque i secchi: i punti di costruzione sono tanti, e
   * l'intestazione dimenticata in uno non farebbe rumore — semplicemente non
   * comparirebbe su quel secchio.
   */
  const headingFor = (item: {
    ticketNumber: number;
    priority?: Parameters<typeof ticketHeading>[0]["priority"];
    type?: Parameters<typeof ticketHeading>[0]["type"];
    createdAt?: string;
  }) => ticketHeading(item, t, now.getTime());

  // ⚠️ `canMerge` arriva dal SERVER, calcolato col ruolo: qui si legge, non si
  // deduce. Un maintainer vede la PR fra le cose che aspettano LUI, un
  // operatore fra quelle che aspettano altri — stessi dati, due posti. È il
  // secondo divieto dell'operatore (CLAUDE.md) applicato in lettura, e la
  // copia della regola sta di là apposta: questa app si aggiorna dagli store.
  const mergeForYou = summary.waitingForMerge.filter((item) => item.canMerge);
  const mergeForOthers = summary.waitingForMerge.filter((item) => !item.canMerge);

  // Una voce per (ticket, PR): `prUrl` è l'identità della riga, non
  // `ticketId` — un ticket che tocca due repo ha due PR, e sono due merge.
  const mergeRow = (item: (typeof summary.waitingForMerge)[number], mine: boolean) => ({
    rowKey: `merge-${item.prUrl}`,
    heading: headingFor(item),
    title: item.title,
    trailing: mine
      ? t("mobile.projects.detail.waitingMergeArrow")
      : t("mobile.projects.detail.waitingMaintainerArrow"),
    trailingTone: (mine ? "amber" : "muted") as "amber" | "muted",
    onPress: () => navigation.navigate("Ticket", { id: item.ticketId, ...(summary.projectName !== undefined ? { backLabel: summary.projectName } : {}) }),
  });

  const waitingRows = [
    ...summary.waitingForYou.map((item) => ({
      rowKey: `you-${item.ticketId}`,
      heading: headingFor(item),
      title: item.title,
      trailing: t("mobile.projects.detail.waitingYouArrow"),
      trailingTone: "amber" as const,
      onPress: () => navigation.navigate("Ticket", { id: item.ticketId, ...(summary.projectName !== undefined ? { backLabel: summary.projectName } : {}) }),
    })),
    ...mergeForYou.map((item) => mergeRow(item, true)),
    ...summary.waitingForOthers.map((item) => ({
      rowKey: `other-${item.ticketId}`,
      heading: headingFor(item),
      title: item.title,
      trailing: t(whoArrowKey(item.who.kind)),
      trailingTone: "muted" as const,
      onPress: () => navigation.navigate("Ticket", { id: item.ticketId, ...(summary.projectName !== undefined ? { backLabel: summary.projectName } : {}) }),
    })),
    ...mergeForOthers.map((item) => mergeRow(item, false)),
  ];

  const runningRows = summary.running.map((item) => ({
    rowKey: `running-${item.ticketId}`,
    heading: headingFor(item),
    title: item.title,
    trailing: t("mobile.projects.detail.running"),
    trailingTone: "muted" as const,
    onPress: () => navigation.navigate("Ticket", { id: item.ticketId, ...(summary.projectName !== undefined ? { backLabel: summary.projectName } : {}) }),
  }));

  // IL QUARTO SECCHIO (21 set 2026). Le voci arrivano GIÀ ordinate dal più
  // fermo (il server: è parte del significato, non una comodità), quindi qui
  // non si riordina. I GIORNI si contano adesso, dalla data: vedi
  // `lib/stalled.ts` per il perché non li manda il server.
  //
  // ⚠️ DUE date su questa voce, e ognuna tiene la sua parola: l'ETÀ sta
  // nell'intestazione («aperto …»), il FERMO qui a destra coi giorni e il
  // motivo. È il difetto corretto sul web il 21 settembre — `createdAt`
  // mostrato dove si leggeva «ultima attività» — e toglierne una per far
  // stare tutto su una riga lo riaprirebbe.
  const stalledRows = summary.stalled.map((item) => ({
    rowKey: `stalled-${item.ticketId}`,
    heading: headingFor(item),
    title: item.title,
    trailing: t("mobile.projects.detail.stalledTrailing", {
      days: stalledDays(item.stalledSince, now),
      reason: t(stalledReasonKey(item.reason)),
    }),
    trailingTone: "muted" as const,
    onPress: () => navigation.navigate("Ticket", { id: item.ticketId, ...(summary.projectName !== undefined ? { backLabel: summary.projectName } : {}) }),
  }));

  const backlogRows =
    summary.backlogReadyCount > 0
      ? [
          {
            rowKey: "backlog-ready",
            title: t("mobile.projects.detail.backlogReadySummary", { count: summary.backlogReadyCount }),
            // ⚠️ Una riga riassuntiva È un'azione (23 set 2026): va dove va il
            // suo «vedi ›». Senza `onPress` la riga si disegna identica a
            // quelle premibili ma non risponde al tocco — il maintainer l'ha
            // trovato sul telefono con le impostazioni.
            onPress: () =>
              navigation.navigate("ProjectBacklog", {
                projectId: summary.projectId,
                projectName: summary.projectName,
              }),
            testID: "backlog-ready-row",
          },
        ]
      : [];

  // Task 7 (App M1+M2, 11 set 2026): non più il proprio `ScrollView` — è
  // già dentro quello di `ProjectDetailScreen`, che ora avvolge anche il
  // link "indietro" sopra di lui.
  return (
    <>
      {/*
        Il NOME del progetto non si ripete qui: dal 21 set 2026 è il titolo
        dell'header (`ScreenHeader`), che è ancorato e resta visibile mentre
        si scorre. Scriverlo due volte sulla stessa schermata è l'unica cosa
        che questo blocco faceva e che ora sarebbe un doppione.
      */}
      <View style={styles.pulseRow}>
        <PulseIndicator tone={line.tone} text={t(line.key, line.params)} />
      </View>

      <View style={styles.groups}>
        {waitingRows.length > 0 && (
          <ProjectGroup
            amber
            label={t("mobile.projects.detail.groups.waitingSomeone", { count: waitingRows.length })}
            rows={waitingRows}
          />
        )}
        {runningRows.length > 0 && (
          <ProjectGroup label={t("mobile.projects.detail.groups.now", { count: runningRows.length })} rows={runningRows} />
        )}
        {backlogRows.length > 0 && (
          <ProjectGroup
            label={t("mobile.projects.detail.groups.backlogReady", { count: summary.backlogReadyCount })}
            rows={backlogRows}
          />
        )}
        {/* Sotto i secchi esistenti, e SOLO se c'è qualcosa: un «Fermo · 0»
            sarebbe rumore su una schermata che deve dire cosa fare. */}
        {stalledRows.length > 0 && (
          <ProjectGroup
            label={t("mobile.projects.detail.groups.stalled", { count: stalledRows.length })}
            rows={stalledRows}
          />
        )}
        {/*
          LE TRE AREE DEL LAVORO (22 set 2026, hub di progetto, design §3):
          sotto il polso, che resta il primo blocco perché è l'unico che dice
          COSA FARE ADESSO. Queste dicono invece COSA C'È DA FARE, ed è una
          domanda diversa — per questo stanno sotto e non al posto suo.

          Ognuna carica per conto suo (design §4): tre `useQuery`
          indipendenti, non suspense. Una che fallisce mostra il proprio
          errore e le altre restano usabili.
        */}
        <HubTicketsSection projectId={summary.projectId} projectName={summary.projectName} navigation={navigation} />
        <HubBacklogSection
          projectId={summary.projectId}
          projectName={summary.projectName}
          readyCount={summary.backlogReadyCount}
          navigation={navigation}
        />
        <HubInboxSection projectId={summary.projectId} projectName={summary.projectName} navigation={navigation} />

        {/*
          DI COSA È FATTO IL PROGETTO (22 set 2026, tappa 2): sotto le tre
          del lavoro, nell'ordine del design §3. Scende da «cosa devi fare»
          (il polso) a «cosa c'è da fare» a «di cosa è fatto» — chi apre
          l'hub dieci volte al giorno trova in alto la risposta che cerca
          nove volte su dieci.
        */}
        <HubRepositoriesSection projectId={summary.projectId} projectName={summary.projectName} navigation={navigation} />
        <HubDocsSection projectId={summary.projectId} projectName={summary.projectName} navigation={navigation} />
        <HubRoadmapSection projectId={summary.projectId} projectName={summary.projectName} navigation={navigation} />

        {/*
          MONITOR E IMPOSTAZIONI (23 set 2026, tappa 3 — l'ultima): in fondo,
          nell'ordine del design §3. Si scende da «di cosa è fatto» a «com'è
          configurato», che è la domanda che si fa più di rado.
        */}
        <HubMonitorSection projectId={summary.projectId} projectName={summary.projectName} navigation={navigation} />
        <HubSettingsSection projectId={summary.projectId} projectName={summary.projectName} navigation={navigation} />
        {/*
          Brief settimanale e report di ieri NON stanno più qui (23 set 2026,
          richiesta del maintainer). Il brief resta raggiungibile dall'inbox,
          dove arriva come card quando il progetto lo ha attivo; il report di
          ieri sul telefono non ha più un accesso, e resta sul web. Chi li
          rimette qui lo faccia come una sezione dell'hub (`HubSection`), non
          come le due righe a sé che erano.
        */}
      </View>
    </>
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
 * TICKET — il conteggio degli APERTI e le prime due righe.
 *
 * Il numero viene da `total` della risposta, non dalle righe ricevute: con
 * `limit: 2` contarle direbbe sempre «2». Quando il server non lo manda
 * (più vecchio di questa app, vedi `ticketPageSchema.total`) l'etichetta
 * resta la sola parola e le righe si vedono lo stesso — è il degrado
 * previsto, non un guasto.
 */
function HubTicketsSection({
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
  const now = Date.now();

  const query = useQuery({
    queryKey: hubKeys.tickets(projectId),
    queryFn: () => {
      if (!client) throw new Error("HubTicketsSection richiede un client autenticato");
      return client.tickets.list({ projectId, statuses: OPEN_TICKET_STATUSES }, undefined, HUB_PREVIEW_LIMIT);
    },
    enabled: client !== null,
    staleTime: 10_000,
  });

  const total = query.data?.total;
  const items = query.data?.items ?? [];
  const rows: ProjectGroupRowProps[] = items.map((item) => ({
    rowKey: item.id,
    heading: ticketHeading(
      { ticketNumber: item.number, priority: item.priority, type: item.type, createdAt: item.createdAt },
      t,
      now,
    ),
    title: item.title,
    onPress: () => navigation.navigate("Ticket", { id: item.id, backLabel: projectName }),
  }));

  const state =
    hubQueryState(query, t) ??
    (rows.length === 0
      ? ({ kind: "empty", message: t("mobile.projects.hub.tickets.empty") } as const)
      : ({ kind: "ready", rows } as const));

  return (
    <HubSection
      testID="hub-tickets"
      label={total === undefined ? t("mobile.projects.hub.tickets.label") : t("mobile.projects.hub.tickets.labelWithCount", { count: total })}
      seeAllLabel={t("mobile.projects.hub.seeAll")}
      onSeeAll={() => navigation.navigate("Tickets", { projectId, projectName })}
      state={state}
    />
  );
}

/**
 * BACKLOG — quanto materiale c'è e QUANTO È MATURO, non quali sono le prime
 * voci (design §Task 5: di un backlog interessa la maturità, non l'ordine di
 * arrivo).
 *
 * ⚠️ I due numeri arrivano da due posti diversi, e nessuno dei due costa una
 * richiesta in più: il TOTALE delle voci attive da `total` della lista (che
 * questa sezione chiede comunque), e le PRONTE dal polso, che è già in cache
 * — `backlogReadyCount` è esattamente «voci `ready`». Contarle dalle righe
 * ricevute darebbe un numero capato dal `limit`.
 *
 * Senza `total` (server più vecchio) la maturità non è calcolabile — la
 * differenza «attive meno pronte» richiede il totale — e la sezione degrada
 * ai TITOLI delle prime voci: meno informativo, mai sbagliato.
 */
function HubBacklogSection({
  projectId,
  projectName,
  readyCount,
  navigation,
}: {
  projectId: string;
  projectName: string;
  readyCount: number;
  navigation: HubNavigation;
}) {
  const { t } = useTranslation();
  const { client } = useAuth();

  const query = useQuery({
    queryKey: hubKeys.backlog(projectId),
    queryFn: () => {
      if (!client) throw new Error("HubBacklogSection richiede un client autenticato");
      // Nessuno `status`: il server nasconde già `converted`/`archived` di
      // default — sono le voci ATTIVE, le stesse del chip «Attivi».
      return client.backlog.list({ projectId }, undefined, HUB_PREVIEW_LIMIT);
    },
    enabled: client !== null,
    staleTime: 10_000,
  });

  const total = query.data?.total;
  const items = query.data?.items ?? [];

  // `Math.max(0, …)`: i due numeri vengono da due risposte diverse, quindi in
  // una finestra di qualche secondo possono raccontare momenti diversi — una
  // voce appena passata a `ready` renderebbe la differenza negativa, e «-1 da
  // preparare» è peggio di uno zero.
  const notReady = total === undefined ? 0 : Math.max(0, total - readyCount);

  const rows: ProjectGroupRowProps[] =
    total !== undefined
      ? [
          {
            rowKey: "maturity",
            title: t("mobile.projects.hub.backlog.maturity", { ready: readyCount, notReady }),
            // Stessa destinazione del «vedi ›» della sezione: vedi la riga
            // «backlog-ready» del polso per il perché.
            onPress: () => navigation.navigate("ProjectBacklog", { projectId, projectName }),
            testID: "hub-backlog-maturity",
          },
        ]
      : items.map((item) => ({
          rowKey: item.id,
          title: item.title,
          // Il ripiego (server senza `total`) mostra VOCI, non un riassunto:
          // qui ogni riga apre la sua voce, come nella schermata piena.
          onPress: () => navigation.navigate("Item", { id: item.id }),
        }));

  const isEmpty = total !== undefined ? total === 0 : items.length === 0;
  const state =
    hubQueryState(query, t) ??
    (isEmpty
      ? ({ kind: "empty", message: t("mobile.projects.hub.backlog.empty") } as const)
      : ({ kind: "ready", rows } as const));

  return (
    <HubSection
      testID="hub-backlog"
      label={total === undefined ? t("mobile.projects.hub.backlog.label") : t("mobile.projects.hub.backlog.labelWithCount", { count: total })}
      seeAllLabel={t("mobile.projects.hub.seeAll")}
      onSeeAll={() => navigation.navigate("ProjectBacklog", { projectId, projectName })}
      state={state}
    />
  );
}

/**
 * INBOX — le notifiche di CHI GUARDA su questo progetto.
 *
 * ⚠️ L'etichetta dice «da gestire», non «del progetto»: l'inbox è per utente,
 * e il filtro di progetto non allarga niente. Chiamarle «le notifiche del
 * progetto» prometterebbe di vedere anche quelle dei colleghi.
 */
function HubInboxSection({
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
    queryKey: hubKeys.inbox(projectId),
    queryFn: () => {
      if (!client) throw new Error("HubInboxSection richiede un client autenticato");
      return client.inbox.list({ projectId }, undefined, HUB_PREVIEW_LIMIT);
    },
    enabled: client !== null,
    staleTime: 10_000,
  });

  const total = query.data?.total;
  const items = query.data?.items ?? [];
  // `text` è la riga che la notifica porta con sé — quella che la card
  // d'inbox mostra in testa. Non esiste un `title` su questo schema, e
  // costruirne uno dal `kind` qui vorrebbe dire una seconda copia delle
  // parole che `InboxCard` già sceglie.
  const rows: ProjectGroupRowProps[] = items.map((item) => ({
    rowKey: item.id,
    title: item.text,
  }));

  const state =
    hubQueryState(query, t) ??
    (rows.length === 0
      ? ({ kind: "empty", message: t("mobile.projects.hub.inbox.empty") } as const)
      : ({ kind: "ready", rows } as const));

  return (
    <HubSection
      testID="hub-inbox"
      label={total === undefined ? t("mobile.projects.hub.inbox.label") : t("mobile.projects.hub.inbox.labelWithCount", { count: total })}
      seeAllLabel={t("mobile.projects.hub.seeAll")}
      onSeeAll={() => navigation.navigate("ProjectInbox", { projectId, projectName })}
      state={state}
    />
  );
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
  const rows: ProjectGroupRowProps[] = spaces.slice(0, HUB_PREVIEW_LIMIT).map((space) => ({
    rowKey: space.repositoryId,
    title: space.name,
    trailing: t("mobile.docs.browse.pageCount", { count: space.pageCount }),
    trailingTone: "muted",
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
  body: {
    gap: 8,
    padding: 20,
    paddingBottom: 40,
  },
  pulseRow: {
    marginBottom: 8,
  },
  groups: {
    gap: 16,
  },
});
