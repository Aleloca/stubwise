import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { isUnknown } from "@stubwise/shared";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import type { ProjectsStackParamList } from "../../../app/navigation";
import { useAuth } from "../../../app/providers";
import { docsKeys } from "../../../lib/docs-mutations";
import { activeAutomationCount, type MonitorAlert } from "../../../lib/project-hub";
import { milestoneKeys, projectKeys } from "../../../lib/query-keys";
import { colors } from "../../../theme/tokens";
import { fontFamily } from "../../../theme/typography";
import { HubCard, HubRow, MonitorBanner } from "./hub-ui";
import { monitorLine } from "./NowTab";

type Navigation = NativeStackScreenProps<ProjectsStackParamList, "Detail">["navigation"];

/**
 * Il riassunto a destra di una riga: niente finché la lettura non è arrivata
 * (invece di un numero provvisorio), «—» se è fallita.
 */
type Summary = { kind: "pending" } | { kind: "failed" } | { kind: "ready"; text: string; danger?: boolean };

function summaryOf<T>(
  query: { isPending: boolean; isError: boolean; data: T | undefined },
  render: (data: T) => { text: string; danger?: boolean },
): Summary {
  if (query.isError) return { kind: "failed" };
  if (query.data === undefined) return { kind: "pending" };
  return { kind: "ready", ...render(query.data) };
}

/**
 * TAB «PROGETTO» (28 set 2026, dettaglio progetto v3 §7): DI COSA È FATTO il
 * progetto e com'è configurato. Una scheda sola, cinque righe; ognuna porta
 * alla schermata che l'hub apriva già prima (nessuna rotta nuova).
 *
 * Ogni riassunto è una lettura ACCESSORIA, FUORI da ogni gate: se fallisce la
 * riga dice «—» e resta premibile — la schermata dietro ha il suo errore e il
 * suo «Riprova». Le chiavi sono le stesse delle schermate di destinazione,
 * quindi aprirle non rilegge niente.
 *
 * I server NON si leggono qui: li legge la schermata (pallino sulla tab,
 * banner di Adesso) e li passa, così la lettura è una sola.
 */
export function ProjectTab({
  projectId,
  projectName,
  servers,
  alert,
  navigation,
}: {
  projectId: string;
  projectName: string;
  servers: { isPending: boolean; isError: boolean; data: readonly unknown[] | undefined };
  alert: MonitorAlert | null;
  navigation: Navigation;
}) {
  const { t } = useTranslation();
  const { client } = useAuth();

  // `projects.get` porta sia i repository sia gli interruttori: UNA lettura
  // per due righe, con la chiave della schermata impostazioni — che la
  // invalida al salvataggio, così tornando qui il conteggio è già nuovo.
  const project = useQuery({
    queryKey: projectKeys.detail(projectId),
    queryFn: () => {
      if (!client) throw new Error("ProjectTab richiede un client autenticato");
      return client.projects.get(projectId);
    },
    enabled: client !== null,
    staleTime: 60_000,
  });

  const docs = useQuery({
    queryKey: docsKeys.spaces(projectId),
    queryFn: () => {
      if (!client) throw new Error("ProjectTab richiede un client autenticato");
      return client.docs.projectSpaces(projectId);
    },
    enabled: client !== null,
    staleTime: 60_000,
  });

  const milestones = useQuery({
    queryKey: milestoneKeys.forProject(projectId),
    queryFn: () => {
      if (!client) throw new Error("ProjectTab richiede un client autenticato");
      return client.projects.milestones(projectId);
    },
    enabled: client !== null,
    staleTime: 60_000,
  });

  const params = { projectId, projectName };

  const rows: { key: string; label: string; summary: Summary; onPress: () => void }[] = [
    {
      key: "repositories",
      label: t("mobile.projects.detail.project.repositories"),
      summary: summaryOf(project, (data) => ({
        text:
          data.repositories.length === 0
            ? t("mobile.projects.detail.project.repositoriesNone")
            : data.repositories.map((repository) => repository.name).join(" · "),
      })),
      onPress: () => navigation.navigate("ProjectRepositories", params),
    },
    {
      key: "docs",
      label: t("mobile.projects.detail.project.documentation"),
      summary: summaryOf(docs, (spaces) => ({
        text: `${t("mobile.projects.detail.project.docsSpaces", { count: spaces.length })} · ${t(
          "mobile.projects.detail.project.docsPages",
          { count: spaces.reduce((sum, space) => sum + space.pageCount, 0) },
        )}`,
      })),
      onPress: () => navigation.navigate("ProjectDocs", params),
    },
    {
      key: "roadmap",
      label: t("mobile.projects.detail.project.roadmap"),
      // Le APERTE, non tutte: di una roadmap interessa quanto manca.
      summary: summaryOf(milestones, (list) => ({
        text: t("mobile.projects.detail.project.roadmapOpen", {
          count: list.filter((milestone) => !isUnknown(milestone.status) && milestone.status === "open").length,
        }),
      })),
      onPress: () => navigation.navigate("ProjectRoadmap", params),
    },
    {
      key: "monitor",
      label: t("mobile.projects.detail.project.monitor"),
      // Rosso SOLO quando qualcosa è davvero rotto (`monitorAlert`, la regola
      // del monitor): un monitor sempre un po' rosso smette di dire qualcosa.
      summary: summaryOf(servers, (list) => {
        const serverCount = t("mobile.projects.detail.project.monitorServers", { count: list.length });
        return alert !== null
          ? { text: `${serverCount} · ${t("mobile.projects.detail.project.monitorDown", { count: alert.brokenCount })}`, danger: true }
          : { text: serverCount };
      }),
      onPress: () => navigation.navigate("ProjectMonitor", params),
    },
    {
      key: "settings",
      label: t("mobile.projects.detail.project.settings"),
      summary: summaryOf(project, (data) => ({
        text: t("mobile.projects.detail.project.automations", { count: activeAutomationCount(data) }),
      })),
      onPress: () => navigation.navigate("ProjectSettings", params),
    },
  ];

  return (
    <View style={styles.column}>
      {alert !== null && (
        <MonitorBanner
          line={monitorLine(alert, t)}
          onPress={() => navigation.navigate("ProjectMonitor", params)}
          testID="hub-project-monitor-banner"
        />
      )}
      <HubCard>
        {rows.map((row, index) => (
          <HubRow key={row.key} first={index === 0} tall onPress={row.onPress} testID={`hub-project-${row.key}`}>
            <Text style={styles.label}>{row.label}</Text>
            {row.summary.kind !== "pending" && (
              <Text
                numberOfLines={1}
                style={[styles.summary, row.summary.kind === "ready" && row.summary.danger === true && styles.danger]}
              >
                {row.summary.kind === "failed" ? t("mobile.projects.detail.project.unavailable") : row.summary.text}
              </Text>
            )}
            <Text style={styles.chevron}>›</Text>
          </HubRow>
        ))}
      </HubCard>
    </View>
  );
}

const styles = StyleSheet.create({
  column: {
    gap: 24,
  },
  label: {
    color: colors.fg,
    flex: 1,
    fontFamily: fontFamily.sans,
    fontSize: 15,
  },
  summary: {
    color: colors.muted,
    flexShrink: 1,
    fontFamily: fontFamily.mono,
    fontSize: 12,
  },
  danger: {
    color: colors.danger,
  },
  chevron: {
    color: colors.faint,
    fontSize: 16,
  },
});
