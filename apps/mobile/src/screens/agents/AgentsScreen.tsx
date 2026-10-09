import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { agentSessionOutcomeSchema } from "@stubwise/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../app/auth-context";
import type { AgentsStackParamList } from "../../app/navigation";
import { SessionRow } from "../../components/agents/SessionRow";
import { GhostButton } from "../../components/GhostButton";
import { usePullToRefresh } from "../../components/PullToRefresh";
import { ScreenHeader } from "../../components/ScreenHeader";
import { SectionLabel } from "../../components/SectionLabel";
import { Skeleton } from "../../components/Skeleton";
import { describeAgentSessionError } from "../../lib/agent-session-errors";
import { agentSessionsQueryOptions } from "../../lib/agent-sessions-queries";
import { useNow } from "../../lib/elapsed";
import { agentSessionKeys } from "../../lib/query-keys";
import { useBottomTabBarHeightSafe } from "../../lib/tab-bar-height-safe";
import { useScreenFocused } from "../../lib/use-screen-focused";
import { colors } from "../../theme/tokens";
import { fontFamily } from "../../theme/typography";
import { isAgentSessionsUnavailable } from "@stubwise/api-client";

const OUTCOMES = agentSessionOutcomeSchema.options;
const CONTENT_BASE_BOTTOM_PADDING = 40;

/**
 * LA TAB AGT (sessioni degli agenti, piano C): «Al lavoro ora» e «Concluse».
 * Gemella di `apps/web/src/routes/agents/index.tsx`.
 *
 * `useQuery` senza gate di suspense: un server senza le rotte risponde 404
 * senza `code` e deve dire «non disponibile su questa istanza» — né vuoto né
 * rotto (design §9). Niente retry e niente polling in quel caso (opzioni di
 * `agentSessionsQueryOptions`, M9); il polling a 5 s c'è solo a schermata a
 * fuoco. Il filtro progetto va al server (chiave diversa, `keepPreviousData`
 * per non svuotare la schermata mentre arriva la risposta); quello sull'esito
 * è sul client, sull'elenco ricevuto. L'errore si mostra solo SENZA dati: un
 * rinfresco fallito non cancella ciò che si vede.
 */
export function AgentsScreen({ navigation }: NativeStackScreenProps<AgentsStackParamList, "List">) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const focused = useScreenFocused();
  const now = useNow();
  const tabBarHeight = useBottomTabBarHeightSafe();
  const [projectId, setProjectId] = useState("");
  const [outcome, setOutcome] = useState("");

  const query = useQuery({
    ...agentSessionsQueryOptions(client!, projectId ? { projectId } : undefined, { focused }),
    enabled: client !== null,
    placeholderData: keepPreviousData,
  });
  const projectsQuery = useQuery({
    queryKey: ["projects", "list"],
    queryFn: () => client!.projects.list(),
    enabled: client !== null,
    staleTime: 60_000,
  });
  const refreshControl = usePullToRefresh([agentSessionKeys.all], "agents-refresh");

  const { data, error } = query;
  const unavailable = error !== null && isAgentSessionsUnavailable(error);
  const open = (id: string) => navigation.navigate("AgentSession", { id });
  const recent = (data?.recent ?? []).filter((s) => outcome === "" || (s.outcome ?? null) === outcome);

  return (
    <View style={styles.container} testID="agents-screen">
      <ScrollView
        refreshControl={refreshControl}
        contentContainerStyle={[styles.content, { paddingBottom: CONTENT_BASE_BOTTOM_PADDING + tabBarHeight }]}
        stickyHeaderIndices={[0]}
      >
        <ScreenHeader title={t("mobile.tabs.agents")} />

        {unavailable ? (
          <Text style={styles.note} testID="agents-unavailable">
            {t("mobile.agents.unavailable")}
          </Text>
        ) : data === undefined && error !== null ? (
          <View style={styles.centered} testID="agents-error">
            <Text style={styles.note}>{describeAgentSessionError(error, t)}</Text>
            <GhostButton label={t("mobile.mbx.list.loadError.retry")} onPress={() => void query.refetch()} testID="agents-retry" />
          </View>
        ) : data === undefined ? (
          <View style={styles.list} testID="agents-skeleton">
            <Skeleton height={80} />
            <Skeleton height={80} />
          </View>
        ) : (
          <>
            <SectionLabel>{t("mobile.agents.live")}</SectionLabel>
            {data.live.length === 0 ? (
              <Text style={styles.empty}>{t("mobile.agents.emptyLive")}</Text>
            ) : (
              <View style={styles.list}>
                {data.live.map((s) => (
                  <SessionRow key={s.id} session={s} now={now} live onPress={() => open(s.id)} />
                ))}
              </View>
            )}

            <SectionLabel>{t("mobile.agents.recent")}</SectionLabel>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              <Chip testID="agents-project-all" label={t("mobile.agents.filters.allProjects")} active={projectId === ""} onPress={() => setProjectId("")} />
              {(projectsQuery.data ?? []).map((p) => (
                <Chip key={p.id} testID={`agents-project-${p.id}`} label={p.name} active={projectId === p.id} onPress={() => setProjectId(p.id)} />
              ))}
            </ScrollView>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              <Chip testID="agents-outcome-all" label={t("mobile.agents.filters.allOutcomes")} active={outcome === ""} onPress={() => setOutcome("")} />
              {OUTCOMES.map((o) => (
                <Chip key={o} testID={`agents-outcome-${o}`} label={t(`mobile.agents.outcome.${o}`)} active={outcome === o} onPress={() => setOutcome(o)} />
              ))}
            </ScrollView>
            {recent.length === 0 ? (
              <Text style={styles.empty}>{t("mobile.agents.emptyRecent")}</Text>
            ) : (
              <View style={styles.list}>
                {recent.map((s) => (
                  <SessionRow key={s.id} session={s} now={now} live={false} onPress={() => open(s.id)} />
                ))}
              </View>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function Chip({ label, active, onPress, testID }: { label: string; active: boolean; onPress: () => void; testID: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.chip, active && styles.chipActive]}
      testID={testID}
    >
      <Text style={[styles.chipLabel, active && styles.chipLabelActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: colors.ink950, flex: 1 },
  content: { gap: 8, padding: 16 },
  list: { gap: 8 },
  centered: { alignItems: "center", gap: 12, paddingVertical: 32 },
  note: { color: colors.muted, fontFamily: fontFamily.sans, fontSize: 14, paddingVertical: 16, textAlign: "center" },
  empty: { color: colors.faint, fontFamily: fontFamily.mono, fontSize: 12 },
  chips: { gap: 8 },
  chip: { borderColor: colors.lineStrong, borderRadius: 16, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 5 },
  chipActive: { borderColor: colors.signalDim },
  chipLabel: { color: colors.muted, fontFamily: fontFamily.mono, fontSize: 11, letterSpacing: 0.6, textTransform: "uppercase" },
  chipLabelActive: { color: colors.signal },
});
