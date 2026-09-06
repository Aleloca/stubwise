import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import type { ProjectsStackParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
import { PulseRow } from "../../components/projects/PulseRow";
import { Skeleton } from "../../components/Skeleton";
import { colors } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

/** Chiave di query condivisa col dettaglio (`ProjectDetailScreen`): STESSA cache, un solo fetch. */
export const projectsPulseKey = ["projects", "pulse"] as const;

/**
 * Schermata Progetti (canvas `2a`): un polso per riga — nome, tono e testo
 * di `pulseLineFor`, conteggi sotto — nell'ORDINE che il server già decide
 * (`GET /api/projects/pulse`, vedi `pulseOrder` lato server): niente
 * ri-ordinamento qui, la lista è quella che arriva. Un tap apre il dettaglio.
 *
 * Guidata interamente da `client.projects.pulse()`: ogni riepilogo porta già
 * `projectId`/`projectName`, quindi non serve un secondo fetch a
 * `client.projects.list()` solo per i nomi (a differenza dell'Inbox, che
 * incrocia due liste). Per un `member` la lista è già filtrata sui progetti
 * SEGUITI; una lista vuota è quindi "nessun progetto seguito", non "nessun
 * progetto esiste" — da cui lo stato vuoto "Scegli cosa seguire".
 */
export function ProjectsScreen({ navigation }: NativeStackScreenProps<ProjectsStackParamList, "List">) {
  const { t } = useTranslation();
  const { client, user } = useAuth();

  const query = useQuery({
    queryKey: projectsPulseKey,
    queryFn: () => {
      if (!client) throw new Error("ProjectsScreen richiede un client autenticato");
      return client.projects.pulse();
    },
    enabled: client !== null,
    staleTime: 10_000,
  });

  const summaries = query.data ?? [];
  const waitingProjects = summaries.filter((summary) => summary.waitingForYou.length > 0).length;
  const subtitle = query.isPending
    ? t("mobile.projects.header.loading")
    : waitingProjects > 0
      ? t("mobile.projects.header.subtitleWaiting", { count: summaries.length, waiting: waitingProjects })
      : t("mobile.projects.header.subtitle", { count: summaries.length });

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>{t("mobile.tabs.projects")}</Text>
        {!query.isError && <Text style={styles.subtitle}>{subtitle}</Text>}
      </View>

      {query.isPending ? (
        <View style={styles.skeletonList} testID="projects-skeleton">
          <Skeleton height={90} width="45%" />
          <Skeleton height={110} />
          <Skeleton height={110} />
          <Skeleton height={110} />
        </View>
      ) : query.isError ? (
        <View style={styles.centered}>
          <Text style={styles.errorTitle}>{t("mobile.projects.loadError.title")}</Text>
          <GhostButton
            label={t("mobile.projects.loadError.retry")}
            onPress={() => void query.refetch()}
            testID="projects-retry"
          />
        </View>
      ) : summaries.length === 0 ? (
        <View style={styles.emptyState} testID="projects-empty">
          <Text style={styles.emptyEyebrow}>{t("mobile.projects.empty.eyebrow")}</Text>
          <Text style={styles.emptyTitle}>{t("mobile.projects.empty.title")}</Text>
          <Text style={styles.emptyBody}>{t("mobile.projects.empty.body")}</Text>
          {/*
           * "Scegli progetti" apre le impostazioni dei progetti seguiti — ma
           * il Task 20 (Impostazioni) non è ancora implementato: nessuna
           * schermata reale a cui puntare. Bottone disabilitato con l'hint
           * mono sotto, invece di un `onPress` a vuoto o una destinazione
           * fabbricata: la scelta è documentata, non silenziosa (vedi il
           * report del Task 15).
           */}
          <View style={styles.emptyCta}>
            <GhostButton label={t("mobile.projects.empty.cta")} onPress={() => {}} disabled testID="projects-empty-cta" />
          </View>
          <Text style={styles.emptyCtaHint}>{t("mobile.projects.empty.ctaHint")}</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scrollContent}>
          {summaries.map((summary) => (
            <PulseRow
              key={summary.projectId}
              summary={summary}
              viewerId={user?.id ?? ""}
              onPress={() => navigation.navigate("Detail", { id: summary.projectId })}
            />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 56,
  },
  title: {
    color: colors.fg,
    fontSize: fontSize.title,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  subtitle: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 12,
    marginTop: 2,
  },
  skeletonList: {
    gap: 8,
    padding: 16,
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
  scrollContent: {
    gap: 8,
    padding: 16,
    paddingBottom: 40,
  },
  emptyState: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  emptyEyebrow: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 12,
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  emptyTitle: {
    color: colors.fg,
    fontSize: 17,
    fontWeight: "600",
    marginTop: 12,
  },
  emptyBody: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 6,
    textAlign: "center",
  },
  emptyCta: {
    marginTop: 20,
  },
  emptyCtaHint: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    marginTop: 10,
  },
});
