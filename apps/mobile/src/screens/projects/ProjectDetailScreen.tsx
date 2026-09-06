import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { isUnknown } from "@stubwise/shared";
import type { ProjectPulseSummary, Reader } from "@stubwise/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Markdown from "react-native-markdown-display";
import type { ProjectsStackParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
import { PulseIndicator } from "../../components/PulseIndicator";
import { ProjectGroup } from "../../components/projects/ProjectGroup";
import { Skeleton } from "../../components/Skeleton";
import { pulseLineFor } from "../../lib/pulse-line";
import { projectsPulseKey } from "./ProjectsScreen";
import { MARKDOWN_STYLE } from "../../theme/markdown";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

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

  return (
    <View style={styles.container}>
      <Pressable onPress={() => navigation.navigate("List")} testID="project-detail-back" style={styles.backRow}>
        <Text style={styles.back}>{t("mobile.projects.detail.back")}</Text>
      </Pressable>

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

  const waitingRows = [
    ...summary.waitingForYou.map((item) => ({
      rowKey: `you-${item.ticketId}`,
      title: item.title,
      trailing: t("mobile.projects.detail.waitingYouArrow"),
      trailingTone: "amber" as const,
      onPress: () => navigation.navigate("Ticket", { id: item.ticketId }),
    })),
    ...summary.waitingForOthers.map((item) => ({
      rowKey: `other-${item.ticketId}`,
      title: item.title,
      trailing: t(whoArrowKey(item.who.kind)),
      trailingTone: "muted" as const,
      onPress: () => navigation.navigate("Ticket", { id: item.ticketId }),
    })),
  ];

  const runningRows = summary.running.map((item) => ({
    rowKey: `running-${item.ticketId}`,
    title: item.title,
    trailing: t("mobile.projects.detail.running"),
    trailingTone: "muted" as const,
    onPress: () => navigation.navigate("Ticket", { id: item.ticketId }),
  }));

  const backlogRows =
    summary.backlogReadyCount > 0
      ? [{ rowKey: "backlog-ready", title: t("mobile.projects.detail.backlogReadySummary", { count: summary.backlogReadyCount }) }]
      : [];

  return (
    <ScrollView contentContainerStyle={styles.body}>
      <Text style={styles.title}>{summary.projectName}</Text>
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
        <BriefRow projectId={summary.projectId} />
        {summary.lastReportDate !== null && <ReportRow projectId={summary.projectId} date={summary.lastReportDate} />}
      </View>
    </ScrollView>
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
            <Markdown style={MARKDOWN_STYLE}>{text}</Markdown>
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
    gap: 8,
    padding: 20,
    paddingBottom: 40,
  },
  title: {
    color: colors.fg,
    fontSize: fontSize.title,
    fontWeight: "700",
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
    fontSize: 14,
  },
  reportBody: {
    borderTopColor: colors.line,
    borderTopWidth: 1,
    padding: 16,
  },
  reportSummary: {
    color: colors.fg,
    fontSize: 14,
    lineHeight: 20,
  },
  reportMeta: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 12,
  },
});
