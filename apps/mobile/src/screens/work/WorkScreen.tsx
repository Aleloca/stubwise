import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { ApiError } from "@stubwise/api-client";
import { isUnknown } from "@stubwise/shared";
import type {
  AiJob,
  MilestoneWithCounts,
  PublicUser,
  Reader,
  TicketComment,
  TicketDetail,
  TicketHistory as TicketHistoryData,
  TicketQuestion,
} from "@stubwise/shared";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ComponentRef, ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, ScrollView, StyleSheet, Text, View } from "react-native";
import type { LayoutChangeEvent, RefreshControlProps, StyleProp, ViewStyle } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import type { TicketParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
import { HubTabBar } from "../../components/projects/HubTabBar";
import { ScreenHeader } from "../../components/ScreenHeader";
import { SafeMarkdown } from "../../components/SafeMarkdown";
import { Skeleton } from "../../components/Skeleton";
import { CommentComposer, CommentList } from "../../components/work/CommentsSection";
import { DestructiveActions } from "../../components/work/DestructiveActions";
import { PlanSection } from "../../components/work/PlanSection";
import { QuestionBlock } from "../../components/work/QuestionBlock";
import { hasPrToShow, PrCycleSection } from "../../components/work/PrCycleSection";
import { PrAdoptionSection } from "../../components/work/PrAdoptionSection";
import { RunWorkButton } from "../../components/work/RunWorkButton";
import { StatusBadge } from "../../components/work/StatusBadge";
import { TicketFields } from "../../components/work/TicketFields";
import { TechLevel } from "../../components/work/TechLevel";
import { TicketHistory } from "../../components/work/TicketHistory";
import { WorkingPill } from "../../components/work/WorkingPill";
import { isHeldCorrectionJob } from "../../lib/pr-cycle";
import { parseTicketTab, statusNeedsViewer } from "../../lib/ticket-tabs";
import type { TicketTab } from "../../lib/ticket-tabs";
import { resolveWorkState } from "../../lib/work-state";
import { workKeys } from "../../lib/work-mutations";
import { milestoneKeys } from "../../lib/query-keys";
import { colors } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";
import { usePullToRefresh } from "../../components/PullToRefresh";
import { KEYBOARD_AWARE_SCROLL_PROPS } from "../../lib/keyboard";

/** Vedi `InboxScreen.tsx` per il perché di una costante invece di leggere `styles.body.paddingBottom`. */
const CONTENT_BASE_BOTTOM_PADDING = 40;

/**
 * Schermata Lavoro (canvas `2c`/`2d`): timeline in parole per tutti, piano +
 * approvazione + livello tecnico solo per un maintainer. Monta sotto
 * `ProjectsStack` come screen `Ticket` (era il placeholder del Task 15).
 *
 * Le query del ticket stanno sulla STESSA chiave radice (`workKeys.all(id)`,
 * così `useApprovePlan`/`useRejectPlan` — dentro `PlanSection` — le invalidano
 * tutte insieme dopo una decisione): dettaglio ticket (titolo, descrizione,
 * piano, riassunto del piano), job, domande dell'agente, commenti e — dal 5
 * ott 2026 — la storia del ticket (`GET /history`, un evento per riga,
 * calcolata dal server). Solo `jobs[0]` — l'ultimo job — decide
 * badge/pillola/gate di approvazione.
 *
 * Il ciclo review → correzione delle PR (30 set 2026) arriva COL dettaglio del
 * ticket (`repositories[].cycle`), non con una query sua: un guasto del ciclo
 * non esiste come caso a sé, e `PrCycleSection` non aggiunge letture.
 *
 * ⚠️ **La storia NON entra nei gate `isPending`/`isError`.** Un suo guasto
 * — o un server più vecchio della rotta, che risponde 404 — costa la sola
 * sezione, che dice «Storia non disponibile»; il resto della tab Attività e
 * la schermata restano. Le tre query storiche (ticket, job, domande) restano
 * i dati senza cui la pagina non ha senso, e decidono skeleton ed errore da
 * sole. Il feed `/activity` e le review del progetto, che reggevano la
 * timeline a sei passi, non si leggono più da qui (il metodo
 * `tickets.activity` del client resta: è API del package).
 *
 * Il bottone indietro fa `navigation.goBack()`, NON `navigate("List")` come
 * `ProjectDetailScreen`: a differenza del dettaglio progetto (raggiungibile
 * solo dalla lista), questa schermata si raggiunge da più punti (righe
 * "Aspetta qualcuno"/"Adesso" del dettaglio progetto oggi, deep link
 * `tickets` in futuro) — `goBack()` torna sempre a quello giusto, un
 * `navigate` fisso tornerebbe altrove per metà dei percorsi.
 */
export function WorkScreen({ navigation, route }: NativeStackScreenProps<TicketParamList, "Ticket">) {
  const { t } = useTranslation();
  const { client, user } = useAuth();
  const tabBarHeight = useBottomTabBarHeight();
  const { id } = route.params;

  const ticketQuery = useQuery({
    queryKey: workKeys.ticket(id),
    queryFn: () => {
      if (!client) throw new Error("WorkScreen richiede un client autenticato");
      return client.tickets.get(id);
    },
    enabled: client !== null,
    staleTime: 10_000,
  });
  const jobsQuery = useQuery({
    queryKey: workKeys.jobs(id),
    queryFn: () => {
      if (!client) throw new Error("WorkScreen richiede un client autenticato");
      return client.tickets.jobs(id);
    },
    enabled: client !== null,
    staleTime: 10_000,
  });
  const questionsQuery = useQuery({
    queryKey: workKeys.questions(id),
    queryFn: () => {
      if (!client) throw new Error("WorkScreen richiede un client autenticato");
      return client.tickets.questions(id);
    },
    enabled: client !== null,
    staleTime: 10_000,
  });

  const historyQuery = useQuery({
    queryKey: workKeys.history(id),
    queryFn: () => {
      if (!client) throw new Error("WorkScreen richiede un client autenticato");
      return client.tickets.history(id);
    },
    enabled: client !== null,
    staleTime: 10_000,
  });
  const commentsQuery = useQuery({
    queryKey: workKeys.comments(id),
    queryFn: () => {
      if (!client) throw new Error("WorkScreen richiede un client autenticato");
      return client.tickets.comments(id);
    },
    enabled: client !== null,
    staleTime: 10_000,
  });

  const projectId = ticketQuery.data?.projectId;

  // Gli elenchi dietro i selettori "assegnatario" e "milestone". Fuori dai
  // gate `isPending`/`isError` come le due query della fase 5, e per lo stesso
  // motivo: un loro guasto deve costare quei due selettori, non la schermata —
  // il valore corrente di entrambi i campi arriva col ticket.
  const usersQuery = useQuery({
    queryKey: ["users"],
    queryFn: () => {
      if (!client) throw new Error("WorkScreen richiede un client autenticato");
      return client.users.list();
    },
    enabled: client !== null,
    staleTime: 5 * 60_000,
  });
  const milestonesQuery = useQuery({
    // Sotto `["milestones"]` dal 22 set 2026: vedi il docblock di
    // `milestoneKeys`. Era un letterale sotto `["projects"]`, che nessuna
    // mutazione invalida.
    queryKey: milestoneKeys.forProject(projectId ?? ""),
    queryFn: () => {
      if (!client) throw new Error("WorkScreen richiede un client autenticato");
      return client.projects.milestones(projectId!);
    },
    enabled: client !== null && projectId !== undefined,
    staleTime: 60_000,
  });

  const isPending = ticketQuery.isPending || jobsQuery.isPending || questionsQuery.isPending;
  const isError = ticketQuery.isError || jobsQuery.isError || questionsQuery.isError;
  // Solo il dettaglio del ticket dice "non esiste" (404): un errore su
  // jobs/questions di un ticket che invece esiste non è previsto dal
  // contratto server, e trattarlo come "non trovato" mostrerebbe il
  // messaggio sbagliato per un guasto diverso.
  const notFound = ticketQuery.isError && ticketQuery.error instanceof ApiError && ticketQuery.error.status === 404;

  function retry(): void {
    void ticketQuery.refetch();
    void jobsQuery.refetch();
    void questionsQuery.refetch();
    void historyQuery.refetch();
    void commentsQuery.refetch();
    void usersQuery.refetch();
    void milestonesQuery.refetch();
  }

  const isAdmin = user !== null && !isUnknown(user.role) && user.role === "admin";

  const refreshControl = usePullToRefresh([workKeys.all(id), milestoneKeys.all], "work-refresh");
  const contentContainerStyle = [styles.body, { paddingBottom: CONTENT_BASE_BOTTOM_PADDING + tabBarHeight }];

  // La pagina a tab (2 ott 2026, design `2026-10-02-app-ticket-tabs-design.md`):
  // l'intestazione NON scorre più — sta fuori da ogni `ScrollView`, e sotto ci
  // sono le tab, ognuna col suo scorrimento. Skeleton, «non trovato» ed errore
  // restano SOPRA le tab, che con un errore non si mostrano (design §6).
  return (
    <View style={styles.container}>
      {/* La chevron dell'indietro non si scrive qui: la mette `ScreenHeader`
          per tutti (23 set 2026). */}
      <View style={styles.headerBar}>
        <ScreenHeader
          title={ticketQuery.data?.title ?? t("mobile.work.fallbackTitle")}
          onBack={() => navigation.goBack()}
          backLabel={route.params.backLabel ?? t("mobile.work.back")}
          titleNumberOfLines={3}
        />
      </View>

      {isPending || notFound || isError ? (
        <ScrollView refreshControl={refreshControl} contentContainerStyle={contentContainerStyle}>
          {isPending ? (
            <View style={styles.skeletonList} testID="work-skeleton">
              <Skeleton height={28} width="70%" />
              <Skeleton height={90} />
              <Skeleton height={160} />
            </View>
          ) : notFound ? (
            <View style={styles.centered} testID="work-not-found">
              <Text style={styles.errorTitle}>{t("mobile.work.notFound.title")}</Text>
              <Text style={styles.notFoundBody}>{t("mobile.work.notFound.body")}</Text>
            </View>
          ) : (
            <View style={styles.centered} testID="work-error">
              <Text style={styles.errorTitle}>{t("mobile.work.loadError.title")}</Text>
              <GhostButton label={t("mobile.work.loadError.retry")} onPress={retry} testID="work-retry" />
            </View>
          )}
        </ScrollView>
      ) : (
        // ⚠️ Keyato sul TICKET: la tab scelta e la posizione di ogni pannello
        // sono di questo ticket. La schermata può ricevere un altro `id` senza
        // smontarsi (memoria «stato stantio senza key»), e allora deve
        // ripartire da Stato, non restare sulla tab dell'altro.
        <WorkTabs
          key={id}
          requestedTab={route.params.tab}
          navigationRequest={route.params}
          ticket={ticketQuery.data!}
          jobs={jobsQuery.data!}
          questions={questionsQuery.data!}
          history={historyQuery.data}
          historyUnavailable={historyQuery.isError}
          comments={commentsQuery.data}
          users={usersQuery.data}
          milestones={milestonesQuery.data}
          isAdmin={isAdmin}
          currentUserId={user?.id ?? null}
          refreshControl={refreshControl}
          contentContainerStyle={contentContainerStyle}
        />
      )}
    </View>
  );
}

function WorkTabs({
  requestedTab,
  navigationRequest,
  ticket,
  jobs,
  questions,
  history,
  historyUnavailable,
  comments,
  users,
  milestones,
  isAdmin,
  currentUserId,
  refreshControl,
  contentContainerStyle,
}: {
  /**
   * Il `tab` della rotta, GREZZO: da un deep link può essere una stringa
   * qualunque, quindi passa sempre da `parseTicketTab`.
   */
  requestedTab: unknown;
  /**
   * L'OGGETTO params della rotta, usato solo per la sua identità: react-
   * navigation 7 ne crea uno nuovo a ogni `navigate` (`createParamsFromAction`
   * in `@react-navigation/routers`, anche quando aggiorna la rotta già in
   * primo piano) e lascia lo stesso ai render che non sono una navigazione.
   * È così che «Apri» due volte sullo stesso ticket, con la stessa `tab`,
   * riporta sulla tab chiesta anche dopo una scelta a mano.
   */
  navigationRequest: object;
  ticket: Reader<TicketDetail>;
  jobs: Reader<AiJob>[];
  questions: Reader<TicketQuestion>[];
  /** La storia del ticket; `undefined` finché la query non ha risposto, o se è fallita. */
  history: Reader<TicketHistoryData> | undefined;
  /** La query della storia è fallita (anche un 404 da un server più vecchio della rotta). */
  historyUnavailable: boolean;
  /** Idem per i commenti: senza, la conversazione non si vede ma il resto resta (e la tab non ha numero). */
  comments: Reader<TicketComment>[] | undefined;
  /** Idem per i due selettori: la riga resta leggibile, non premibile. */
  users: Reader<PublicUser>[] | undefined;
  milestones: Reader<MilestoneWithCounts>[] | undefined;
  isAdmin: boolean;
  /** Serve a sapere chi può rispondere a una domanda: il richiedente del run, o un maintainer. */
  currentUserId: string | null;
  refreshControl: ReactElement<RefreshControlProps>;
  contentContainerStyle: StyleProp<ViewStyle>;
}) {
  const { t } = useTranslation();
  // Un ticket di tipo REVIEW (6 ott 2026) è la review automatica di una PR che
  // non nasce da un ticket (es. quella dei Changesets): non si «lavora», si
  // legge. Si apre quindi su Contenuto, dove c'è la review — Stato non ha
  // niente da mostrare per lui — anche se la card chiedeva Stato.
  const isReview = !isUnknown(ticket.type) && ticket.type === "review";
  // ADOZIONE della PR (6 ott 2026): un ticket review affidato a Stubwise ha
  // le correzioni e il ciclo della sua PR, quindi Stato torna ad avere senso.
  // `?? null`: la cache persistita può avere un dettaglio di prima del campo.
  const adoption = ticket.prAdoption ?? null;
  const isAdopted = adoption !== null && !isUnknown(adoption.state) && adoption.state === "adopted";
  const pickTab = (requested: unknown): TicketTab => {
    const parsed = parseTicketTab(requested);
    return isReview && !isAdopted && parsed === "status" ? "content" : parsed;
  };
  const [tab, setTab] = useState<TicketTab>(() => pickTab(requestedTab));
  // Una NAVIGAZIONE nuova verso la schermata già montata (stesso ticket, una
  // card che chiede una tab — anche la stessa di prima) porta su quella tab.
  // Legato all'identità dei params, non al valore di `tab`: con lo stesso
  // valore l'effetto non ripartirebbe e una scelta a mano resterebbe (I1
  // della review finale). Un render che non è una navigazione (refetch)
  // lascia lo stesso oggetto, quindi la scelta a mano resta. Al primo render
  // non fa niente di diverso dallo stato iniziale.
  useEffect(() => {
    setTab(pickTab(requestedTab));
    // `requestedTab` viene da `navigationRequest`: cambia solo insieme a lui.
  }, [navigationRequest, requestedTab]);
  const latestJob = jobs[0];
  const workState = resolveWorkState(latestJob);

  /**
   * La domanda APERTA del job corrente. Si guarda `answeredAt` e non `answer`:
   * quest'ultimo è `null` anche su una risposta che il server non è più
   * riuscito a rileggere, e prenderla per una domanda aperta mostrerebbe un
   * form di risposta su una decisione già presa. Stessa lettura della pagina
   * ticket sul web.
   */
  const openQuestion = questions.find(
    (question) => question.answeredAt === null && latestJob !== undefined && question.jobId === latestJob.id,
  );
  // Chi può rispondere: un maintainer, o chi ha chiesto il run. È la regola di
  // `actorAllows` lato server, dove resta l'autorità — qui decide solo cosa
  // mostrare (e, dal 2 ott 2026, il pallino di Stato: stessa deduzione).
  const requesterId = latestJob?.requestedByUserId ?? null;
  const canAnswer = isAdmin || (requesterId !== null && currentUserId !== null && requesterId === currentUserId);
  // Un commento ELIMINATO (0084) non è più un'indicazione: senza testo non
  // c'è niente da cui «riprendere con le istruzioni». `?? null` per la cache
  // persistita di una versione precedente (campo assente = non eliminato).
  const hasUserComment = (comments ?? []).some(
    (comment) => comment.authorType === "user" && (comment.deletedAt ?? null) === null,
  );
  const canDecide = isAdmin && latestJob !== undefined && !isUnknown(latestJob.status) && latestJob.status === "awaiting_plan_approval";
  const isWorking =
    latestJob !== undefined && !isUnknown(latestJob.status) && latestJob.status === "fixing" && latestJob.startedAt !== null;
  const needsViewer = statusNeedsViewer({
    hasOpenQuestion: openQuestion !== undefined,
    canAnswer,
    canDecide,
    repositories: ticket.repositories,
  });
  const commentCount = comments?.length;
  // UNA regola per «c'è un piano», per Stato e Contenuto: un piano di soli
  // spazi è nessun piano in tutte e due, o «Leggi il piano completo»
  // porterebbe a «Nessun piano ancora.».
  const plan = ticket.implementationPlan !== null && ticket.implementationPlan.trim() !== "" ? ticket.implementationPlan : null;

  /**
   * «Leggi il piano completo» porta SUL piano, non in cima a Contenuto: sui
   * ticket nati da un design la descrizione sopra è un documento intero.
   *
   * La richiesta resta SEMPRE in attesa finché Contenuto non si è misurato
   * dopo il cambio di tab: al primo `onLayout` del blocco del piano (che dà
   * anche la posizione aggiornata — una già nota può essere stantia, se la
   * descrizione è cambiata) o al primo `onContentSizeChange` della pagina, si
   * scorre e la richiesta si chiude. Il `requestAnimationFrame` è il ripiego
   * per quando nessuno dei due arriva: scorre sulla posizione nota, se c'è,
   * ma lascia la richiesta aperta, così un layout che arriva dopo corregge.
   * Un layout ad altezza 0 è quello del pannello nascosto (`display: "none"`)
   * e non dice niente.
   */
  const contentRef = useRef<ComponentRef<typeof ScrollView>>(null);

  /**
   * Rispondere a un commento (piano B4). Lo stato sta QUI perché due pezzi
   * separati della tab Attività lo usano: l'elenco (dove si preme «Rispondi»)
   * e il campo in cima (dove compare «Rispondendo a …»). Per scorrere
   * all'originale servono la posizione dell'elenco nella pagina e quella di
   * ogni riga nell'elenco, misurate con `onLayout`.
   */
  // Risposta e MODIFICA (0084) sono UNO stato: si escludono per costruzione.
  const [composer, setComposer] = useState<{ mode: "reply" | "edit"; commentId: string } | null>(null);
  const activityRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const commentsY = useRef(0);
  const commentRowY = useRef(new Map<string, number>());
  // Il campo della risposta si apre SOTTO il commento (5 ott 2026): niente
  // scorrimento in cima, il testo a cui si risponde resta sotto gli occhi.
  const startReply = (comment: Reader<TicketComment>) => setComposer({ mode: "reply", commentId: comment.id });
  const startEdit = useCallback(
    (comment: Reader<TicketComment>) => setComposer({ mode: "edit", commentId: comment.id }),
    [],
  );
  const jumpToComment = (commentId: string) => {
    const rowY = commentRowY.current.get(commentId);
    if (rowY === undefined) return;
    activityRef.current?.scrollTo({ y: commentsY.current + rowY, animated: true });
  };
  const planY = useRef<number | null>(null);
  const pendingPlanScroll = useRef(false);
  const scrollToKnownPlan = () => {
    if (planY.current === null) return false;
    contentRef.current?.scrollTo({ y: planY.current, animated: false });
    return true;
  };
  const readFullPlan = () => {
    pendingPlanScroll.current = true;
    setTab("content");
    requestAnimationFrame(() => {
      if (pendingPlanScroll.current) scrollToKnownPlan();
    });
  };
  const onPlanLayout = (event: LayoutChangeEvent) => {
    const { y, height } = event.nativeEvent.layout;
    if (height === 0) return;
    planY.current = y;
    if (pendingPlanScroll.current && scrollToKnownPlan()) pendingPlanScroll.current = false;
  };
  const onContentSizeChange = () => {
    if (pendingPlanScroll.current && scrollToKnownPlan()) pendingPlanScroll.current = false;
  };

  /**
   * Un pannello: montato SEMPRE, nascosto con `display: "none"` quando non è
   * la tab attiva — così ognuno conserva il suo scorrimento cambiando tab
   * (design §2). `{tab === "x" && …}` lo smonterebbe, e tornando si
   * ripartirebbe dall'alto. TUTTI gestiscono la tastiera (25 set 2026): ogni
   * tab ha un campo da scrivere — la risposta libera a una domanda in Stato,
   * il commento in Attività, le etichette in Dettagli — e senza la pagina non
   * scorre fino al campo e il primo tocco su «Invia» chiude solo la tastiera.
   */
  const panel = (key: TicketTab, children: ReactNode) => (
    <ScrollView
      key={key}
      ref={key === "content" ? contentRef : key === "activity" ? activityRef : undefined}
      onContentSizeChange={key === "content" ? onContentSizeChange : undefined}
      {...KEYBOARD_AWARE_SCROLL_PROPS}
      // Il pull-to-refresh SOLO sul pannello attivo: condiviso da quattro
      // ScrollView, `refreshing` arrivava anche alle nascoste (su iOS
      // `beginRefreshing` ne sposta l'offset) e il testID era quadruplicato.
      refreshControl={tab === key ? refreshControl : undefined}
      contentContainerStyle={contentContainerStyle}
      style={[styles.panel, tab !== key && styles.hidden]}
      testID={`work-panel-${key}`}
    >
      {children}
    </ScrollView>
  );

  return (
    <View style={styles.tabsRoot}>
      <View style={styles.fixedHeader}>
        <View style={styles.metaBlock}>
          <View style={styles.metaRow}>
            <StatusBadge state={workState} reviewTicket={isReview} />
            <Text style={styles.ticketNumber}>{t("mobile.work.ticketNumber", { number: ticket.number })}</Text>
          </View>
          {isWorking && (
            <View style={styles.workingPillRow}>
              <WorkingPill startedAt={latestJob!.startedAt!} />
            </View>
          )}
        </View>
        <HubTabBar
          compact
          testIDPrefix="work-tab"
          active={tab}
          onSelect={(next) => {
            // Un campo aperto in un pannello che sparisce lascerebbe la
            // tastiera a coprire quello nuovo.
            Keyboard.dismiss();
            setTab(next);
          }}
          tabs={[
            { key: "status", label: t("mobile.work.tabs.status"), dot: needsViewer, dotLabel: t("mobile.work.tabs.needsYou") },
            { key: "content", label: t("mobile.work.tabs.content") },
            {
              key: "activity",
              label: t("mobile.work.tabs.activity"),
              count: commentCount,
              countLabel: commentCount === undefined ? undefined : t("mobile.work.tabs.comments", { count: commentCount }),
            },
            { key: "details", label: t("mobile.work.tabs.details") },
          ]}
        />
      </View>

      <View style={styles.panels}>
        {panel(
          "status",
          <>
            {openQuestion !== undefined && (
              <View style={styles.firstRow}>
                <QuestionBlock ticketId={ticket.id} question={openQuestion} canAnswer={canAnswer} />
              </View>
            )}
            {/*
              Il piano COMPATTO con le sue azioni resta qui (decisione del
              maintainer, piano §3.1): il pallino «piano da approvare» deve
              indicare la tab dove Approva/Rifiuta ci sono. Il testo intero
              sta in Contenuto, e «Leggi il piano completo» porta lì.
            */}
            {isReview && (
              <Text style={[styles.firstRow, styles.releaseNote]} testID="work-review-note">
                {isAdopted ? t("mobile.work.reviewTicketNoteAdopted") : t("mobile.work.reviewTicketNote")}
              </Text>
            )}
            {isReview && adoption !== null && (
              <View style={styles.row} testID="work-adoption-row">
                <PrAdoptionSection ticketId={ticket.id} ticketNumber={ticket.number} adoption={adoption} />
              </View>
            )}
            {!isReview && (
            <View style={styles.row}>
              <PlanSection
                ticketId={ticket.id}
                ticketTitle={ticket.title}
                plan={plan}
                planSummary={ticket.planSummary ?? null}
                canDecide={canDecide}
                isAdmin={isAdmin}
                isClosed={ticket.status === "closed"}
                planApprovedAt={ticket.planApprovedAt ?? null}
                planApprovedBy={ticket.planApprovedBy ?? null}
                planApprovalStale={ticket.planApprovalStale ?? false}
                onReadFull={readFullPlan}
              />
            </View>
            )}
            {/* Nessun «Avvia il lavoro» su un ticket review: un fix ripartirebbe
                dal branch principale e non toccherebbe la PR rivista. */}
            {!isReview && (
            <View style={styles.row}>
              <RunWorkButton
                ticketId={ticket.id}
                latestJob={latestJob}
                hasUserComment={hasUserComment}
                latestJobIsHeldCorrection={isHeldCorrectionJob(ticket.repositories, latestJob)}
              />
            </View>
            )}
            {/*
              Senza PR la sezione non c'è, e nemmeno il suo contenitore: il
              margine resterebbe come uno spazio vuoto (`hasPrToShow`, la
              stessa condizione con cui la sezione decide di non rendere niente).
            */}
            {hasPrToShow(ticket.repositories) && (
              <View style={styles.row} testID="work-pr-row">
                <PrCycleSection ticketId={ticket.id} ticketNumber={ticket.number} repositories={ticket.repositories} />
              </View>
            )}
            {!isReview && <Text style={[styles.row, styles.releaseNote]}>{t("mobile.work.releaseNote")}</Text>}
          </>,
        )}

        {panel(
          "content",
          <>
            {/*
              Il corpo di un ticket è MARKDOWN (24 set 2026): lo scrivono i
              design, l'intake del backlog e chi apre il ticket dal web.
              `SafeMarkdown` porta con sé la guardia sui link (solo http/https).
            */}
            {ticket.body.trim() === "" ? (
              <Text style={[styles.firstRow, styles.description]}>{t("mobile.work.noDescription")}</Text>
            ) : (
              <View style={styles.firstRow} testID="work-body">
                <SafeMarkdown>{ticket.body}</SafeMarkdown>
              </View>
            )}
            <View style={styles.sectionGap} onLayout={onPlanLayout} testID="work-plan-block">
              <Text style={styles.eyebrow}>{t("mobile.work.planFull.title")}</Text>
              {plan === null ? (
                <Text style={styles.description} testID="work-plan-full-empty">
                  {t("mobile.work.planFull.empty")}
                </Text>
              ) : (
                <View testID="work-plan-full">
                  <SafeMarkdown>{plan}</SafeMarkdown>
                </View>
              )}
            </View>
          </>,
        )}

        {panel(
          "activity",
          <>
            {/* In cima il campo per scrivere e la storia, poi i commenti dal
                più recente (maintainer, 5 ott 2026: prima campo e storia
                stavano in fondo, sotto l'elenco). */}
            <View style={styles.firstRow}>
              <CommentComposer ticketId={ticket.id} />
            </View>
            <View style={styles.sectionGap}>
              <TicketHistory history={history} unavailable={historyUnavailable} />
            </View>
            <View
              style={styles.sectionGap}
              testID="work-comments-section"
              onLayout={(event) => {
                commentsY.current = event.nativeEvent.layout.y;
              }}
            >
              <CommentList
                ticketId={ticket.id}
                viewerId={currentUserId}
                comments={comments}
                users={users}
                replyingToId={composer?.mode === "reply" ? composer.commentId : null}
                editingId={composer?.mode === "edit" ? composer.commentId : null}
                onReply={startReply}
                onEdit={startEdit}
                onCancelReply={() => setComposer(null)}
                onJumpTo={jumpToComment}
                onRowLayout={(commentId, y) => commentRowY.current.set(commentId, y)}
              />
            </View>
          </>,
        )}

        {panel(
          "details",
          <>
            <View style={styles.firstRow}>
              <TicketFields ticket={ticket} users={users} milestones={milestones} />
            </View>
            {isAdmin && (
              <View style={styles.sectionGap}>
                <TechLevel
                  repositories={ticket.repositories.map((repo) => ({ repositoryId: repo.repositoryId, branch: repo.branch }))}
                  log={latestJob?.log ?? ""}
                />
              </View>
            )}
            {/*
              In FONDO: sono le sole azioni irreversibili della schermata, e non
              devono stare sul percorso del pollice (design §4 delle azioni).
            */}
            <View style={styles.destructiveRow}>
              <DestructiveActions
                ticketId={ticket.id}
                hasDesign={ticket.originContent !== null}
                hasPlan={ticket.implementationPlan !== null}
              />
            </View>
          </>,
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  headerBar: {
    backgroundColor: colors.ink950,
  },
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
  tabsRoot: {
    flex: 1,
  },
  // L'intestazione FISSA sotto il titolo: stato, numero, «AI al lavoro» e le
  // tab. La linea sotto le tab separa la parte ferma da quella che scorre,
  // come nel dettaglio progetto.
  fixedHeader: {
    backgroundColor: colors.ink950,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
  },
  metaBlock: {
    paddingBottom: 8,
    paddingHorizontal: 20,
  },
  panels: {
    flex: 1,
  },
  panel: {
    flex: 1,
  },
  hidden: {
    display: "none",
  },
  body: {
    gap: 4,
    padding: 20,
    paddingBottom: 40,
  },
  metaRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  ticketNumber: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  description: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.body,
    lineHeight: 20,
  },
  workingPillRow: {
    marginTop: 10,
  },
  firstRow: {
    marginTop: 0,
  },
  row: {
    marginTop: 16,
  },
  sectionGap: {
    gap: 8,
    marginTop: 24,
  },
  eyebrow: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  destructiveRow: {
    marginTop: 28,
  },
  releaseNote: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 11,
  },
});
