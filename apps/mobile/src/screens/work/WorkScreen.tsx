import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { ApiError } from "@stubwise/api-client";
import { isUnknown } from "@stubwise/shared";
import type {
  AiJob,
  MilestoneWithCounts,
  PrReviewSummary,
  PublicUser,
  Reader,
  TicketActivityEntry,
  TicketComment,
  TicketDetail,
  TicketQuestion,
} from "@stubwise/shared";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import type { ProjectsStackParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
import { ScreenHeader } from "../../components/ScreenHeader";
import { SafeMarkdown } from "../../components/SafeMarkdown";
import { Skeleton } from "../../components/Skeleton";
import { CommentsSection } from "../../components/work/CommentsSection";
import { DestructiveActions } from "../../components/work/DestructiveActions";
import { PlanSection } from "../../components/work/PlanSection";
import { QuestionBlock } from "../../components/work/QuestionBlock";
import { RunWorkButton } from "../../components/work/RunWorkButton";
import { StatusBadge } from "../../components/work/StatusBadge";
import { TicketFields } from "../../components/work/TicketFields";
import { TechLevel } from "../../components/work/TechLevel";
import { Timeline } from "../../components/work/Timeline";
import { WorkingPill } from "../../components/work/WorkingPill";
import { buildTimeline, resolveWorkState } from "../../lib/timeline";
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
 * Quattro query sulla STESSA chiave radice (`workKeys.all(id)`, così
 * `useApprovePlan`/`useRejectPlan` — dentro `PlanSection` — le invalidano
 * tutte insieme dopo una decisione): dettaglio ticket (titolo, descrizione,
 * piano, riassunto del piano), job (la storia del lavoro), domande dell'agente
 * e — dalla fase 5 — il feed di attività del ticket. Solo `jobs[0]` — l'ultimo
 * job — decide badge/pillola/timeline/gate di approvazione: vedi il commento su
 * questa stessa scelta in `lib/timeline.ts`.
 *
 * ⚠️ **Le due query della fase 5 NON entrano nei gate `isPending`/`isError`.**
 * Il feed di attività (date reali dei passi "piano approvato" e "PR e review")
 * e le review del progetto (il verdetto) sono DECORAZIONE della timeline: un
 * loro guasto deve costare quelle due date e quell'etichetta, non la
 * schermata. Le tre query storiche restano invece i dati senza cui la pagina
 * non ha senso, e continuano a decidere skeleton ed errore da sole.
 *
 * Le review sono per PROGETTO (non esiste una rotta "review di un ticket"),
 * quindi quella query DIPENDE dal dettaglio: parte solo quando `projectId` è
 * noto, e `buildTimeline` scarta le review degli altri ticket.
 *
 * Il bottone indietro fa `navigation.goBack()`, NON `navigate("List")` come
 * `ProjectDetailScreen`: a differenza del dettaglio progetto (raggiungibile
 * solo dalla lista), questa schermata si raggiunge da più punti (righe
 * "Aspetta qualcuno"/"Adesso" del dettaglio progetto oggi, deep link
 * `tickets` in futuro) — `goBack()` torna sempre a quello giusto, un
 * `navigate` fisso tornerebbe altrove per metà dei percorsi.
 */
export function WorkScreen({ navigation, route }: NativeStackScreenProps<ProjectsStackParamList, "Ticket">) {
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

  const activityQuery = useQuery({
    queryKey: workKeys.activity(id),
    queryFn: () => {
      if (!client) throw new Error("WorkScreen richiede un client autenticato");
      return client.tickets.activity(id);
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
  const reviewsQuery = useQuery({
    queryKey: ["projects", projectId ?? "", "reviews"],
    queryFn: () => {
      if (!client) throw new Error("WorkScreen richiede un client autenticato");
      return client.projects.reviews(projectId!);
    },
    enabled: client !== null && projectId !== undefined,
    staleTime: 30_000,
  });

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
    void activityQuery.refetch();
    void commentsQuery.refetch();
    void reviewsQuery.refetch();
    void usersQuery.refetch();
    void milestonesQuery.refetch();
  }

  const isAdmin = user !== null && !isUnknown(user.role) && user.role === "admin";

  // Task 7 (App M1+M2, 11 set 2026): un solo `ScrollView`, il link
  // "indietro" come primo figlio — stesso schema di `InboxScreen.tsx`.
  // Fix di review (Task 2, 11 set 2026): l'avatar, mancante del tutto su
  // questo screen — quello dove si approva un piano — ora c'è sulla
  // stessa riga, ancorata (`stickyHeaderIndices`, vedi `ScreenHeader.tsx`).
  const refreshControl = usePullToRefresh([workKeys.all(id), milestoneKeys.all], "work-refresh");

  return (
    <View style={styles.container}>
      <ScrollView
        {...KEYBOARD_AWARE_SCROLL_PROPS}
        refreshControl={refreshControl}
        contentContainerStyle={[styles.body, { paddingBottom: CONTENT_BASE_BOTTOM_PADDING + tabBarHeight }]}
        stickyHeaderIndices={[0]}
        testID="keyboard-aware-scroll"
      >
        {/* La chevron dell'indietro non si scrive più qui: la mette
            `ScreenHeader` per tutti (23 set 2026). Scritta a mano restava il
            nome nudo su chiunque passasse un `backLabel` che non fosse una
            nostra costante tradotta — le schermate dell'hub di progetto. */}
        <ScreenHeader
          title={ticketQuery.data?.title ?? t("mobile.work.fallbackTitle")}
          onBack={() => navigation.goBack()}
          backLabel={route.params.backLabel ?? t("mobile.work.back")}
          titleNumberOfLines={3}
        />

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
        ) : isError ? (
          <View style={styles.centered} testID="work-error">
            <Text style={styles.errorTitle}>{t("mobile.work.loadError.title")}</Text>
            <GhostButton label={t("mobile.work.loadError.retry")} onPress={retry} testID="work-retry" />
          </View>
        ) : (
          <WorkBody
            ticket={ticketQuery.data!}
            jobs={jobsQuery.data!}
            questions={questionsQuery.data!}
            activity={activityQuery.data}
            comments={commentsQuery.data}
            reviews={reviewsQuery.data}
            users={usersQuery.data}
            milestones={milestonesQuery.data}
            isAdmin={isAdmin}
            currentUserId={user?.id ?? null}
          />
        )}
      </ScrollView>
    </View>
  );
}

function WorkBody({
  ticket,
  jobs,
  questions,
  activity,
  comments,
  reviews,
  users,
  milestones,
  isAdmin,
  currentUserId,
}: {
  ticket: Reader<TicketDetail>;
  jobs: Reader<AiJob>[];
  questions: Reader<TicketQuestion>[];
  /** `undefined` finché la query non ha risposto, o se è fallita: la timeline resta senza quelle date. */
  activity: Reader<TicketActivityEntry>[] | undefined;
  /** Idem per i commenti: senza, la conversazione non si vede ma il resto resta. */
  comments: Reader<TicketComment>[] | undefined;
  /** Idem per il verdetto della review. */
  reviews: Reader<PrReviewSummary>[] | undefined;
  /** Idem per i due selettori: la riga resta leggibile, non premibile. */
  users: Reader<PublicUser>[] | undefined;
  milestones: Reader<MilestoneWithCounts>[] | undefined;
  isAdmin: boolean;
  /** Serve a sapere chi può rispondere a una domanda: il richiedente del run, o un maintainer. */
  currentUserId: string | null;
}) {
  const { t } = useTranslation();
  const latestJob = jobs[0];
  const workState = resolveWorkState(latestJob);
  const steps = buildTimeline({ ticket, jobs, questions, activity, reviews });

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
  // mostrare.
  const requesterId = latestJob?.requestedByUserId ?? null;
  const canAnswer = isAdmin || (requesterId !== null && currentUserId !== null && requesterId === currentUserId);
  const hasUserComment = (comments ?? []).some((comment) => comment.authorType === "user");
  const canDecide = isAdmin && latestJob !== undefined && !isUnknown(latestJob.status) && latestJob.status === "awaiting_plan_approval";
  const isWorking =
    latestJob !== undefined && !isUnknown(latestJob.status) && latestJob.status === "fixing" && latestJob.startedAt !== null;

  // Task 7 (App M1+M2, 11 set 2026): non più il proprio `ScrollView` — è
  // già dentro quello di `WorkScreen`, che ora avvolge anche il link
  // "indietro" sopra di lui.
  return (
    <>
      <View style={styles.metaRow}>
        <StatusBadge state={workState} />
        <Text style={styles.ticketNumber}>{t("mobile.work.ticketNumber", { number: ticket.number })}</Text>
      </View>

      {/*
        Il corpo di un ticket è MARKDOWN (24 set 2026): lo scrivono i design,
        l'intake del backlog e chi apre il ticket dal web, e fino a qui si
        leggeva come testo grezzo — `##`, `**` e le liste coi trattini a
        vista. `SafeMarkdown` è lo stesso componente del piano poco sotto, e
        porta con sé la guardia sui link (solo http/https).
      */}
      {ticket.body.trim() === "" ? (
        <Text style={styles.description}>{t("mobile.work.noDescription")}</Text>
      ) : (
        <View style={styles.bodyMarkdown} testID="work-body">
          <SafeMarkdown>{ticket.body}</SafeMarkdown>
        </View>
      )}

      {isWorking && (
        <View style={styles.workingPillRow}>
          <WorkingPill startedAt={latestJob!.startedAt!} />
        </View>
      )}

      {openQuestion !== undefined && (
        <View style={styles.questionRow}>
          <QuestionBlock ticketId={ticket.id} question={openQuestion} canAnswer={canAnswer} />
        </View>
      )}

      <View style={styles.planRow}>
        <PlanSection
          ticketId={ticket.id}
          ticketTitle={ticket.title}
          plan={ticket.implementationPlan}
          planSummary={ticket.planSummary ?? null}
          canDecide={canDecide}
          isAdmin={isAdmin}
          isClosed={ticket.status === "closed"}
          planApprovedAt={ticket.planApprovedAt ?? null}
          planApprovedBy={ticket.planApprovedBy ?? null}
          planApprovalStale={ticket.planApprovalStale ?? false}
        />
      </View>

      <View style={styles.runRow}>
        <RunWorkButton ticketId={ticket.id} latestJob={latestJob} hasUserComment={hasUserComment} />
      </View>

      <View style={styles.fieldsRow}>
        <TicketFields ticket={ticket} users={users} milestones={milestones} />
      </View>

      <View style={styles.timelineRow}>
        <Timeline steps={steps} />
      </View>
      <View style={styles.commentsRow}>
        <CommentsSection ticketId={ticket.id} comments={comments} users={users} />
      </View>

      <Text style={styles.releaseNote}>{t("mobile.work.releaseNote")}</Text>

      {isAdmin && (
        <TechLevel
          repositories={ticket.repositories.map((repo) => ({ repositoryId: repo.repositoryId, branch: repo.branch }))}
          log={latestJob?.log ?? ""}
        />
      )}

      {/*
        In FONDO, dopo tutto il resto: sono le sole azioni irreversibili della
        schermata, e non devono stare sul percorso del pollice che scorre il
        piano e i commenti (design §4).
      */}
      <View style={styles.destructiveRow}>
        <DestructiveActions
          ticketId={ticket.id}
          hasDesign={ticket.originContent !== null}
          hasPlan={ticket.implementationPlan !== null}
        />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  // Task 7: niente più `paddingHorizontal`/`paddingTop` propri — vivono in
  // `body` (vedi il commento gemello in `ProjectDetailScreen.tsx`).
  // Fix di review (Task 2, 11 set 2026): `headerRow` è ora ANCORATA
  // (`stickyHeaderIndices` sullo `ScrollView` sopra) e porta anche
  // l'avatar — `backgroundColor` opaco necessario, o il contenuto sotto
  // l'attraverserebbe scorrendo.
  headerRow: {
    alignItems: "center",
    backgroundColor: colors.ink950,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingBottom: 12,
    paddingTop: 56,
  },
  backRow: {},
  back: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 12,
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
  body: {
    gap: 4,
    padding: 20,
    paddingBottom: 40,
  },
  metaRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    marginTop: 6,
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
    marginTop: 10,
  },
  bodyMarkdown: {
    marginTop: 10,
  },
  workingPillRow: {
    marginTop: 10,
  },
  questionRow: {
    marginTop: 16,
  },
  planRow: {
    marginTop: 16,
  },
  runRow: {
    marginTop: 16,
  },
  fieldsRow: {
    marginTop: 16,
  },
  timelineRow: {
    marginTop: 20,
  },
  commentsRow: {
    marginTop: 20,
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
