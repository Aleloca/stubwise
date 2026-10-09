import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { ApiError, isAgentSessionsUnavailable } from "@stubwise/api-client";
import { buildTranscript, elapsedParts, isUnknown, type TranscriptItem } from "@stubwise/shared";
import type { TFunction } from "i18next";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import type { TicketParamList } from "../../app/navigation";
import { TranscriptItemView } from "../../components/agents/TranscriptItemView";
import { GhostButton } from "../../components/GhostButton";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Skeleton } from "../../components/Skeleton";
import { describeAgentSessionError } from "../../lib/agent-session-errors";
import { useAgentSession } from "../../lib/agent-session-view";
import { useNow } from "../../lib/elapsed";
import { relativeTimeAgo } from "../../lib/format";
import { useBottomTabBarHeightSafe } from "../../lib/tab-bar-height-safe";
import { colors } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

type Props = NativeStackScreenProps<TicketParamList, "AgentSession">;

/** Chiave del catalogo per un valore di enum aperto da `readerSchema`: l'ignoto ha la sua voce. */
function key(value: string): string {
  return isUnknown(value) ? "unknown" : value;
}

/**
 * LA SESSIONE DI UN AGENTE, COME CHAT (piano C, Task 6): dal vivo o in replay.
 * Gemella di `apps/web/src/routes/agents/$id.tsx`; le regole dei dati stanno in
 * `useAgentSession` (`lib/agent-session-view.ts`), quelle della trascrizione in
 * `buildTranscript` di `@stubwise/shared`.
 *
 * - `FlatList` INVERTITA (design §8.3: «gli ultimi eventi, e il resto scorrendo
 *   all'indietro»): si parte dal fondo, e arrivando in cima `onEndReached`
 *   carica la pagina più vecchia — c'è anche il bottone, per chi non scorre.
 * - 404 senza `code` (server senza le rotte) → «non disponibile su questa
 *   istanza»; 404 con `code` → «non trovata». Nessun retry su un 4xx (opzioni
 *   della query).
 * - Il link al ticket apre `Ticket` NELLO STESSO stack: indietro torna qui.
 * - Scrivere all'agente e rispondere alle domande li aggiunge il Task 7, qui:
 *   testo e errore del campo staranno nella schermata, non nella lista.
 */
export function AgentSessionScreen({ navigation, route }: Props) {
  // La chiave azzera lo stato (eventi, parziali, stream) cambiando sessione.
  return <AgentSessionView key={route.params.id} id={route.params.id} navigation={navigation} />;
}

function AgentSessionView({ id, navigation }: { id: string; navigation: Props["navigation"] }) {
  const { t } = useTranslation();
  const now = useNow();
  const tabBarHeight = useBottomTabBarHeightSafe();
  const session = useAgentSession(id);
  const { detail, detailError } = session;

  const items = useMemo(
    () =>
      buildTranscript({
        events: session.events,
        partials: session.partials,
        inputs: detail?.inputs ?? [],
        questions: detail?.questions ?? [],
      }),
    [session.events, session.partials, detail?.inputs, detail?.questions],
  );
  // Invertita: il primo elemento dei dati è il più in basso.
  const reversed = useMemo(() => [...items].reverse(), [items]);

  const live = detail !== undefined && detail.state !== "ended";
  const subtitle = detail === undefined ? undefined : describeState(detail, now, t);
  const header = (
    <ScreenHeader
      title={detail?.title ?? t("mobile.agents.title")}
      titleNumberOfLines={2}
      subtitle={subtitle}
      onBack={() => navigation.goBack()}
      backLabel={t("mobile.agents.sessionBack")}
    />
  );

  let body: React.ReactNode;
  if (isAgentSessionsUnavailable(detailError)) {
    body = <Text style={styles.note}>{t("mobile.agents.unavailable")}</Text>;
  } else if (detailError instanceof ApiError && detailError.status === 404) {
    body = <Text style={styles.note}>{t("mobile.agents.notFound")}</Text>;
  } else if (detail === undefined && detailError !== null) {
    body = (
      <View style={styles.centered}>
        <Text style={styles.note}>{describeAgentSessionError(detailError, t)}</Text>
        <GhostButton
          label={t("mobile.mbx.list.loadError.retry")}
          onPress={() => void session.refetchDetail()}
          testID="agent-session-retry"
        />
      </View>
    );
  } else if (detail === undefined) {
    body = (
      <View style={styles.skeleton} testID="agent-session-skeleton">
        <Skeleton height={60} />
        <Skeleton height={60} />
      </View>
    );
  } else {
    const ticketId = detail.ticketId;
    body = (
      <>
        <View style={styles.meta}>
          <Text style={styles.kind}>{t(`mobile.agents.kind.${key(detail.kind)}`)}</Text>
          {detail.projectName !== null && <Text style={styles.metaText}>{detail.projectName}</Text>}
          {ticketId !== null && detail.ticketNumber !== null && (
            <Pressable
              accessibilityRole="link"
              onPress={() => navigation.navigate("Ticket", { id: ticketId, backLabel: t("mobile.agents.ticketBack") })}
              testID="agent-session-ticket"
            >
              <Text style={styles.link}>{`#${detail.ticketNumber}`}</Text>
            </Pressable>
          )}
        </View>
        {session.status === "reconnecting" && (
          <Text style={styles.status} accessibilityRole="alert">
            {t("mobile.agents.reconnecting")}
          </Text>
        )}
        {session.eventsError !== null ? (
          <Text style={styles.note}>{describeAgentSessionError(session.eventsError, t)}</Text>
        ) : session.eventsLoaded && items.length === 0 ? (
          <Text style={styles.empty}>{t("mobile.agents.noEvents")}</Text>
        ) : (
          <FlatList
            inverted
            data={reversed}
            keyExtractor={(item: TranscriptItem) => item.id}
            renderItem={({ item }) => (
              <View style={styles.item}>
                <TranscriptItemView item={item} live={live} />
              </View>
            )}
            // Invertita: il padding "in alto" del contenitore è il fondo a schermo.
            contentContainerStyle={{ paddingBottom: 16, paddingTop: 16 + tabBarHeight }}
            onEndReachedThreshold={0.3}
            onEndReached={() => {
              if (session.hasOlder && !session.loadingOlder && session.olderError === null) void session.loadOlder();
            }}
            // Invertita: il footer è IN CIMA, dove stanno gli eventi più vecchi.
            ListFooterComponent={
              <View style={styles.older}>
                {session.olderError !== null && (
                  <Text style={styles.note}>{describeAgentSessionError(session.olderError, t)}</Text>
                )}
                {session.loadingOlder ? (
                  <ActivityIndicator color={colors.muted} accessibilityLabel={t("mobile.agents.loadingOlder")} />
                ) : (
                  session.hasOlder && (
                    <GhostButton
                      label={t("mobile.agents.loadOlder")}
                      onPress={() => void session.loadOlder()}
                      testID="agent-session-load-older"
                    />
                  )
                )}
              </View>
            }
            testID="agent-session-transcript"
          />
        )}
      </>
    );
  }

  return (
    <View style={styles.container} testID="agent-session-screen">
      <View style={styles.headerBox}>{header}</View>
      {body}
    </View>
  );
}

/** Stato e durata (viva) o esito e quando (conclusa). La durata la conta il CLIENT da `startedAt`. */
function describeState(
  detail: { state: string; startedAt: string; lastEventAt: string | null; outcome?: string | null },
  now: number,
  t: TFunction,
): string {
  if (detail.state === "ended") {
    const outcome = detail.outcome ?? null;
    const label = outcome !== null ? t(`mobile.agents.outcome.${key(outcome)}`) : t("mobile.agents.state.ended");
    const when = relativeTimeAgo(detail.lastEventAt ?? detail.startedAt, t, now);
    return when !== null ? `${label} · ${when}` : label;
  }
  const elapsed = elapsedParts(detail.startedAt, now);
  const time =
    elapsed.hours > 0
      ? t("mobile.agents.elapsed", { hours: elapsed.hours, minutes: elapsed.minutes })
      : t("mobile.agents.elapsedMinutes", { minutes: elapsed.minutes });
  return `${t(`mobile.agents.state.${key(detail.state)}`)} · ${time}`;
}

const styles = StyleSheet.create({
  container: { backgroundColor: colors.ink950, flex: 1 },
  headerBox: { paddingHorizontal: 16, paddingTop: 16 },
  meta: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 10, paddingHorizontal: 16, paddingVertical: 8 },
  kind: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  metaText: { color: colors.muted, fontFamily: fontFamily.sans, fontSize: 12 },
  link: { color: colors.signal, fontFamily: fontFamily.mono, fontSize: 12 },
  status: { color: colors.faint, fontFamily: fontFamily.mono, fontSize: 12, paddingHorizontal: 16 },
  item: { paddingHorizontal: 16, paddingVertical: 6 },
  older: { alignItems: "center", gap: 8, paddingVertical: 8 },
  centered: { alignItems: "center", gap: 12, paddingVertical: 32 },
  skeleton: { gap: 8, padding: 16 },
  note: { color: colors.muted, fontFamily: fontFamily.sans, fontSize: 14, padding: 16, textAlign: "center" },
  empty: { color: colors.faint, fontFamily: fontFamily.mono, fontSize: 12, padding: 16 },
});
