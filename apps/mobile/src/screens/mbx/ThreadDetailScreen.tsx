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
import type { MailThreadReproposal, Reader } from "@stubwise/shared";
import { useMailThread, useRepropose } from "../../lib/mail-mutations";
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
  const { threadId, highlightMessageId } = route.params;

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
              <View
                key={message.id}
                style={[styles.message, message.id === highlightMessageId && styles.messageMatched]}
                testID={`thread-message-${message.id}`}
              >
                <View style={styles.messageHeader}>
                  <Text style={styles.from} numberOfLines={1}>
                    {message.from}
                  </Text>
                  <Text style={styles.time}>{timeLabel(message.receivedAt, t)}</Text>
                </View>
                {/*
                 * Il messaggio che ha fatto comparire questa conversazione
                 * nella ricerca (15 set 2026, design §3). Il bordo da solo è
                 * un segno che si può non vedere: chi arriva dalla ricerca
                 * deve LEGGERE perché è questo.
                 */}
                {message.id === highlightMessageId && (
                  <Text style={styles.matched} testID={`thread-message-matched-${message.id}`}>
                    {t("mobile.search.matched")}
                  </Text>
                )}
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
                {/*
                 * «Riproponi», sul MESSAGGIO: l'unica via di recupero da una
                 * proposta fallita o ignorata per sbaglio. Quali siano
                 * possibili lo dice il SERVER — qui non si rivaluta nessuno
                 * stato, e l'array vuoto (nessuna azione) è il caso normale.
                 */}
                {message.reproposals.map((action) => (
                  <ReproposeButton key={`${action.source}-${action.id}`} action={action} />
                ))}
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

/**
 * Una riproposizione sola, con la sua PROPRIA mutazione: condividerne una
 * lascerebbe lo stato «in corso» su tutte le altre dello stesso messaggio.
 *
 * `source` arriva da un `Reader`, che gli enum li apre (CLAUDE.md, "solo
 * cambi additivi"): un valore che questa build non conosce viene dal server
 * di domani e non si disegna, invece di finire nell'URL di una rotta.
 */
function ReproposeButton({ action }: { action: Reader<MailThreadReproposal> }) {
  const { t } = useTranslation();
  // La forma stretta serve a TypeScript: con un booleano a parte il tipo di
  // `action.source` non si restringe, e l'ignoto finirebbe nell'URL.
  const source = action.source === "email" || action.source === "email_triage" ? action.source : null;
  // L'hook si chiama SEMPRE (regole dei hook); è il disegno che si ferma.
  const repropose = useRepropose(source ?? "email", action.id);

  if (source === null) return null;

  // La conversazione si rilegge da sé (la mutazione invalida `mailKeys`) e
  // l'azione sparisce: senza una riga esplicita il tap non lascerebbe
  // traccia, e sembrerebbe non aver fatto niente.
  if (repropose.isSuccess) {
    return <Text style={styles.reproposeDone}>{t("mobile.mbx.list.reproposeSuccess")}</Text>;
  }

  return (
    <View style={styles.reproposeRow}>
      <GhostButton
        label={
          repropose.isPending
            ? t("mobile.mbx.list.repropose")
            : action.projectName
              ? `${t("mobile.mbx.list.repropose")} · ${action.projectName}`
              : t("mobile.mbx.list.repropose")
        }
        onPress={() => repropose.mutate()}
        disabled={repropose.disabled}
        testID={`thread-repropose-${action.id}`}
      />
      {repropose.errorMessage !== null && (
        <Text style={styles.reproposeError}>{repropose.errorMessage}</Text>
      )}
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
  messageMatched: {
    borderColor: colors.signal,
  },
  matched: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 0.6,
    marginTop: 6,
    textTransform: "uppercase",
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
  reproposeRow: {
    alignItems: "flex-start",
    marginTop: 10,
  },
  reproposeDone: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    marginTop: 10,
  },
  reproposeError: {
    color: colors.danger,
    fontFamily: fontFamily.sans,
    fontSize: 12,
    marginTop: 4,
  },
});
