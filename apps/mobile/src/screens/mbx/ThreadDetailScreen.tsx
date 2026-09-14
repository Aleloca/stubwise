import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { ApiError } from "@stubwise/api-client";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import type { MbxStackParamList } from "../../app/navigation";
import { GhostButton } from "../../components/GhostButton";
import { LinkedText } from "../../components/LinkedText";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Skeleton } from "../../components/Skeleton";
import { relativeTimeCompact } from "../../lib/format";
import { useMailThread } from "../../lib/mail-mutations";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

/** Vedi `InboxScreen.tsx` per il perché di una costante invece di leggere `styles.body.paddingBottom`. */
const CONTENT_BASE_BOTTOM_PADDING = 40;

/**
 * Una CONVERSAZIONE letta per intero («la posta si legge per conversazione»
 * §4, Task 15): i messaggi in ordine, ciascuno col suo mittente, la sua data
 * e il suo corpo.
 *
 * È ciò che dissolve il terzo sintomo da cui nasce tutto questo: prima, per
 * leggere lo scambio, l'unica strada era «Mostra l'originale» — che
 * restituisce il corpo grezzo con dentro tutta la catena citata, corretto ma
 * illeggibile, un blocco unico in cui non si capisce dove finisce una email e
 * comincia la precedente. Qui i messaggi arrivano già separati da Gmail, e
 * nessuno prova a spacchettare una citazione (design, «Cosa NON si fa»).
 *
 * ⚠️ **Il corpo resta TESTO, mai markdown**: `LinkedText` rende i link
 * toccabili (`http`/`https` soltanto) senza reinterpretare asterischi e
 * trattini di un'email scritta da un estraneo.
 */
export function ThreadDetailScreen({
  navigation,
  route,
}: NativeStackScreenProps<MbxStackParamList, "ThreadDetail">) {
  const { t } = useTranslation();
  const tabBarHeight = useBottomTabBarHeight();
  const { threadId } = route.params;

  const query = useMailThread(threadId);
  const notFound = query.isError && query.error instanceof ApiError && query.error.status === 404;

  return (
    <View style={styles.container} testID="thread-detail-screen">
      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: CONTENT_BASE_BOTTOM_PADDING + tabBarHeight }]}
        stickyHeaderIndices={[0]}
      >
        <ScreenHeader
          title={query.data?.subject ?? t("mobile.mbx.list.noSubject")}
          onBack={() => navigation.goBack()}
          backLabel={t("mobile.mbx.detail.back")}
          titleNumberOfLines={3}
        />

        {query.isPending ? (
          <View style={styles.skeletonList} testID="thread-detail-skeleton">
            <Skeleton height={80} />
            <Skeleton height={80} />
          </View>
        ) : notFound || query.isError ? (
          <View style={styles.centered} testID="thread-detail-error">
            <Text style={styles.errorTitle}>{t("mobile.mbx.thread.loadError.title")}</Text>
            {!notFound && (
              <GhostButton
                label={t("mobile.mbx.detail.loadError.retry")}
                onPress={() => void query.refetch()}
                testID="thread-detail-retry"
              />
            )}
          </View>
        ) : (
          <>
            <Text style={styles.meta}>
              {t("mobile.mbx.thread.messages", { count: query.data!.messages.length })} ·{" "}
              {query.data!.accountEmail}
            </Text>

            {query.data!.messages.map((message) => (
              <View key={message.id} style={styles.message} testID={`thread-message-${message.id}`}>
                <View style={styles.messageHeader}>
                  <Text style={styles.from} numberOfLines={1}>
                    {message.from}
                  </Text>
                  <Text style={styles.time}>{timeLabel(message.receivedAt, t)}</Text>
                </View>
                {/*
                 * Un messaggio di CONTESTO si dichiara: è entrato col thread
                 * di un ammesso e non produrrà mai una proposta. Senza,
                 * sembrerebbe uno che non ne ha ancora prodotta — due cose
                 * diverse.
                 */}
                {!message.admitted && (
                  <Text style={styles.context} testID={`thread-message-context-${message.id}`}>
                    {t("mobile.mbx.thread.context")}
                  </Text>
                )}
                {message.textExcerpt !== null ? (
                  <LinkedText style={styles.bodyText} text={message.textExcerpt} />
                ) : (
                  <Text style={styles.missing}>{t("mobile.mbx.detail.excerptMissing")}</Text>
                )}
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

/** La data di un messaggio nella forma compatta già usata dalla scheda. */
function timeLabel(iso: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const relative = relativeTimeCompact(iso);
  return relative.kind === "now"
    ? t("mobile.mbx.time.now")
    : t(`mobile.mbx.time.${relative.kind}`, { count: relative.count });
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  body: {
    gap: 4,
    padding: 20,
    paddingBottom: 40,
  },
  skeletonList: {
    gap: 12,
    marginTop: 12,
  },
  centered: {
    alignItems: "center",
    flex: 1,
    gap: 12,
    justifyContent: "center",
    paddingHorizontal: 32,
    paddingVertical: 48,
  },
  errorTitle: {
    color: colors.fg,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 15,
    fontWeight: "600",
    textAlign: "center",
  },
  meta: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    marginTop: 6,
  },
  message: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.control,
    borderWidth: 1,
    marginTop: 12,
    padding: 12,
  },
  messageHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    justifyContent: "space-between",
  },
  from: {
    color: colors.fg,
    flexShrink: 1,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 14,
    fontWeight: "600",
  },
  time: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  context: {
    color: colors.faint,
    fontFamily: fontFamily.sans,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 6,
  },
  bodyText: {
    color: colors.fg,
    fontFamily: fontFamily.sans,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 10,
  },
  missing: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 14,
    marginTop: 10,
  },
});
