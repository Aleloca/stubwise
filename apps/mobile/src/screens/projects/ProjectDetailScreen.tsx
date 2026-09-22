import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { isUnknown } from "@stubwise/shared";
import type { ProjectPulseSummary, Reader } from "@stubwise/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SafeMarkdown } from "../../components/SafeMarkdown";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import type { ProjectsStackParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
import { PulseIndicator } from "../../components/PulseIndicator";
import { HubSection, type HubSectionState } from "../../components/projects/HubSection";
import { ProjectGroup } from "../../components/projects/ProjectGroup";
import type { ProjectGroupRowProps } from "../../components/projects/ProjectRowsCard";
import { OPEN_TICKET_STATUSES } from "../../lib/project-tickets";
import { ticketHeading } from "../../lib/ticket-labels";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Skeleton } from "../../components/Skeleton";
import { pulseLineFor } from "../../lib/pulse-line";
import { stalledDays, stalledReasonKey } from "../../lib/stalled";
import { projectsPulseKey } from "./ProjectsScreen";
import { colors, radii } from "../../theme/tokens";
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
 * Le chiavi di query delle ANTEPRIME dell'hub. Distinte da quelle delle
 * schermate piene (`projectTicketsKey`, `projectInboxKey`,
 * `backlogKeys.list`) perché chiedono un `limit` diverso: la stessa chiave
 * farebbe servire due pagine di lunghezza diversa dalla stessa cache, e la
 * schermata piena mostrerebbe due righe.
 */
const hubKeys = {
  tickets: (projectId: string) => ["projects", "hub", "tickets", projectId] as const,
  backlog: (projectId: string) => ["projects", "hub", "backlog", projectId] as const,
  inbox: (projectId: string) => ["projects", "hub", "inbox", projectId] as const,
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
      ? [{ rowKey: "backlog-ready", title: t("mobile.projects.detail.backlogReadySummary", { count: summary.backlogReadyCount }) }]
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

        <BriefRow projectId={summary.projectId} />
        {summary.lastReportDate !== null && <ReportRow projectId={summary.projectId} date={summary.lastReportDate} />}
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
      ? [{ rowKey: "maturity", title: t("mobile.projects.hub.backlog.maturity", { ready: readyCount, notReady }) }]
      : items.map((item) => ({ rowKey: item.id, title: item.title }));

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
 * "Brief settimanale" (fase 5): il resoconto della settimana scritto per chi
 * non legge codice — dove siamo, cosa è cambiato, cosa è fermo, cosa serve.
 *
 * Stessa forma del "Report di ieri" qui sotto, e per le stesse ragioni: la riga
 * c'è sempre (un brief può esistere anche per un progetto senza attività
 * recente, quindi non c'è un campo del polso che dica "qui non guardare"), e il
 * fetch è PIGRO — parte al primo tocco, non all'apertura del dettaglio.
 *
 * `limit: 1`: solo l'ULTIMO brief. Lo storico ha una sua pagina sul web
 * (`/projects/:id/roadmap`), e la vista roadmap sull'app è esplicitamente fuori
 * dalla v1 della fase.
 *
 * Tre esiti diversi, tre parole diverse — un brief assente, uno senza testo e
 * uno fallito non sono la stessa cosa: `summary` è `null` anche a brief `done`
 * quando l'istanza non ha un provider AI configurato (vedi
 * `projectBriefWeeklySchema`), e quello è "non c'è ancora niente da leggere";
 * `failed` invece è "c'è stato un tentativo e non è andato", che merita di
 * essere detto perché suggerisce di riprovare dal web.
 */
function BriefRow({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const [expanded, setExpanded] = useState(false);

  const query = useQuery({
    queryKey: ["briefs", "latest", projectId],
    queryFn: () => {
      if (!client) throw new Error("BriefRow richiede un client autenticato");
      return client.projects.briefs(projectId, { limit: 1 });
    },
    enabled: expanded && client !== null,
    staleTime: 60_000,
  });

  const latest = query.data?.[0];
  const text = latest?.summary ?? null;

  return (
    <View style={styles.reportCard}>
      <Pressable
        onPress={() => setExpanded((current) => !current)}
        accessibilityRole="button"
        style={styles.reportRow}
        testID="project-detail-brief-toggle"
      >
        <Text style={styles.reportTitle}>{t("mobile.projects.detail.brief.title")}</Text>
      </Pressable>
      {expanded && (
        <View style={styles.reportBody} testID="project-detail-brief">
          {query.isPending ? (
            <Text style={styles.reportMeta}>{t("mobile.projects.detail.brief.loading")}</Text>
          ) : query.isError ? (
            <Text style={styles.reportMeta}>{t("mobile.projects.detail.brief.loadError")}</Text>
          ) : text !== null && text.trim() !== "" ? (
            // Markdown come il piano e le pagine Docs: `MARKDOWN_STYLE` è
            // l'unica definizione dello stile, e markdown-it ha `html: false`
            // di default (vedi la nota in `components/work/PlanSection.tsx`).
            <SafeMarkdown>{text}</SafeMarkdown>
          ) : latest !== undefined && !isUnknown(latest.status) && latest.status === "failed" ? (
            <Text style={styles.reportMeta}>{t("mobile.projects.detail.brief.failed")}</Text>
          ) : (
            <Text style={styles.reportMeta}>{t("mobile.projects.detail.brief.empty")}</Text>
          )}
        </View>
      )}
    </View>
  );
}

/**
 * "Report di ieri" (canvas `2b`): v1 mostra SOLO il riassunto narrativo
 * (`summary`) del report giornaliero esistente — non la lista commit, non
 * la vista per-sviluppatore, non una navigazione verso `/activity` (che sul
 * mobile non esiste ancora come schermata a sé). Il fetch è PIGRO: parte al
 * primo tap, non all'apertura del dettaglio — la maggior parte delle visite
 * al dettaglio non apre questa riga.
 */
function ReportRow({ projectId, date }: { projectId: string; date: string }) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const [expanded, setExpanded] = useState(false);

  const query = useQuery({
    queryKey: ["activity", "for-date", date],
    queryFn: () => {
      if (!client) throw new Error("ReportRow richiede un client autenticato");
      return client.activity.forDate(date);
    },
    enabled: expanded && client !== null,
    staleTime: 60_000,
  });

  const projectReport = query.data?.projects.find((row) => row.project.id === projectId);

  return (
    <View style={styles.reportCard}>
      <Pressable
        onPress={() => setExpanded((current) => !current)}
        accessibilityRole="button"
        style={styles.reportRow}
        testID="project-detail-report-toggle"
      >
        <Text style={styles.reportTitle}>{t("mobile.projects.detail.report.title")}</Text>
      </Pressable>
      {expanded && (
        <View style={styles.reportBody}>
          {query.isPending ? (
            <Text style={styles.reportMeta}>{t("mobile.projects.detail.report.loading")}</Text>
          ) : query.isError ? (
            <Text style={styles.reportMeta}>{t("mobile.projects.detail.report.loadError")}</Text>
          ) : projectReport?.summary != null && projectReport.summary.length > 0 ? (
            <Text style={styles.reportSummary}>{projectReport.summary}</Text>
          ) : (
            <Text style={styles.reportMeta}>{t("mobile.projects.detail.report.empty")}</Text>
          )}
        </View>
      )}
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
  reportCard: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.card,
    borderWidth: 1,
    overflow: "hidden",
  },
  reportRow: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  reportTitle: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 14,
  },
  reportBody: {
    borderTopColor: colors.line,
    borderTopWidth: 1,
    padding: 16,
  },
  reportSummary: {
    color: colors.fg,
    fontFamily: fontFamily.sans,
    fontSize: 14,
    lineHeight: 20,
  },
  reportMeta: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 12,
  },
});
