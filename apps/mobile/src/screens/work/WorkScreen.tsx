import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { ApiError } from "@stubwise/api-client";
import { isUnknown } from "@stubwise/shared";
import type { AiJob, Reader, TicketDetail, TicketQuestion } from "@stubwise/shared";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ProjectsStackParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
import { Skeleton } from "../../components/Skeleton";
import { PlanSection } from "../../components/work/PlanSection";
import { StatusBadge } from "../../components/work/StatusBadge";
import { TechLevel } from "../../components/work/TechLevel";
import { Timeline } from "../../components/work/Timeline";
import { WorkingPill } from "../../components/work/WorkingPill";
import { buildTimeline, resolveWorkState } from "../../lib/timeline";
import { workKeys } from "../../lib/work-mutations";
import { colors } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

/**
 * Schermata Lavoro (canvas `2c`/`2d`): timeline in parole per tutti, piano +
 * approvazione + livello tecnico solo per un maintainer. Monta sotto
 * `ProjectsStack` come screen `Ticket` (era il placeholder del Task 15).
 *
 * Tre query in parallelo sulla STESSA chiave radice (`workKeys.all(id)`, così
 * `useApprovePlan`/`useRejectPlan` — dentro `PlanSection` — le invalidano
 * tutte insieme dopo una decisione): dettaglio ticket (titolo, descrizione,
 * piano), job (la storia del lavoro) e domande dell'agente. Solo `jobs[0]` —
 * l'ultimo job — decide badge/pillola/timeline/gate di approvazione: vedi il
 * commento su questa stessa scelta in `lib/timeline.ts`.
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
  }

  const isAdmin = user !== null && !isUnknown(user.role) && user.role === "admin";

  return (
    <View style={styles.container}>
      <Pressable onPress={() => navigation.goBack()} testID="work-back" style={styles.backRow}>
        <Text style={styles.back}>{t("mobile.work.back")}</Text>
      </Pressable>

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
        <WorkBody ticket={ticketQuery.data!} jobs={jobsQuery.data!} questions={questionsQuery.data!} isAdmin={isAdmin} />
      )}
    </View>
  );
}

function WorkBody({
  ticket,
  jobs,
  questions,
  isAdmin,
}: {
  ticket: Reader<TicketDetail>;
  jobs: Reader<AiJob>[];
  questions: Reader<TicketQuestion>[];
  isAdmin: boolean;
}) {
  const { t } = useTranslation();
  const latestJob = jobs[0];
  const workState = resolveWorkState(latestJob);
  const steps = buildTimeline({ ticket, jobs, questions });
  const canDecide = isAdmin && latestJob !== undefined && !isUnknown(latestJob.status) && latestJob.status === "awaiting_plan_approval";
  const isWorking =
    latestJob !== undefined && !isUnknown(latestJob.status) && latestJob.status === "fixing" && latestJob.startedAt !== null;

  return (
    <ScrollView contentContainerStyle={styles.body}>
      <Text style={styles.title}>{ticket.title}</Text>
      <View style={styles.metaRow}>
        <StatusBadge state={workState} />
        <Text style={styles.ticketNumber}>{t("mobile.work.ticketNumber", { number: ticket.number })}</Text>
      </View>

      <Text style={styles.description}>{ticket.body.trim() === "" ? t("mobile.work.noDescription") : ticket.body}</Text>

      {isWorking && (
        <View style={styles.workingPillRow}>
          <WorkingPill startedAt={latestJob!.startedAt!} />
        </View>
      )}

      <View style={styles.planRow}>
        <PlanSection ticketId={ticket.id} ticketTitle={ticket.title} plan={ticket.implementationPlan} canDecide={canDecide} />
      </View>

      <View style={styles.timelineRow}>
        <Timeline steps={steps} />
      </View>
      <Text style={styles.releaseNote}>{t("mobile.work.releaseNote")}</Text>

      {isAdmin && <TechLevel branches={ticket.repositories.map((repo) => repo.branch)} log={latestJob?.log ?? ""} />}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  backRow: {
    paddingHorizontal: 20,
    paddingTop: 56,
  },
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
    fontSize: 15,
    fontWeight: "600",
    textAlign: "center",
  },
  notFoundBody: {
    color: colors.muted,
    fontSize: 14,
    textAlign: "center",
  },
  body: {
    gap: 4,
    padding: 20,
    paddingBottom: 40,
  },
  title: {
    color: colors.fg,
    fontSize: fontSize.title,
    fontWeight: "700",
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
    fontSize: fontSize.body,
    lineHeight: 20,
    marginTop: 10,
  },
  workingPillRow: {
    marginTop: 10,
  },
  planRow: {
    marginTop: 16,
  },
  timelineRow: {
    marginTop: 20,
  },
  releaseNote: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 11,
  },
});
