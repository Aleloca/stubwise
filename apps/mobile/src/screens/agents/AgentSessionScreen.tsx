import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { ApiError, isAgentSessionsUnavailable } from "@stubwise/api-client";
import { buildTranscript, elapsedParts, INTERACTIVE_SEGMENTS, isUnknown, type TranscriptItem } from "@stubwise/shared";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import type { TicketParamList } from "../../app/navigation";
import { AgentComposer, UnsentMessage } from "../../components/agents/AgentComposer";
import { SessionQuestion } from "../../components/agents/SessionQuestion";
import { TranscriptItemView } from "../../components/agents/TranscriptItemView";
import { GhostButton } from "../../components/GhostButton";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Skeleton } from "../../components/Skeleton";
import { TabScreenKeyboardAvoider } from "../../components/TabScreenKeyboardAvoider";
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
 * - Scrivere all'agente (Task 7): si scrive SOLO con `detail.canWrite`,
 *   «Ferma e scrivi» solo con `canInterrupt` — li calcola il server, mai il
 *   ruolo. Il campo resta MONTATO anche con `canIntervene` a sessione
 *   `working` (fra un segmento e l'altro dello stesso run), in sola lettura e
 *   con la riga del perché, così non perde la tastiera (gemello del web). Su
 *   un passo interattivo vivo senza `canIntervene`: «solo un maintainer».
 *   Testo ed errore del campo vivono QUI, non in `AgentComposer`: un 409 che
 *   toglie il campo lascia visibile quello che si era scritto in `UnsentMessage`.
 * - Rispondere alle domande (Task 7): `SessionQuestion` dentro la lista, coi
 *   bottoni solo con `canAnswer`. Con `focus: "question"` (la push o l'«Apri»
 *   di una domanda) la lista scorre alla prima domanda APERTA, una volta sola,
 *   anche se arriva dopo il caricamento — come `#question` sul web.
 * - Tastiera: campo FISSO in fondo, quindi `TabScreenKeyboardAvoider` come le
 *   due chat (backlog e «Chiedi al progetto»), non le prop della pagina che scorre.
 */
export function AgentSessionScreen({ navigation, route }: Props) {
  // La chiave azzera lo stato (eventi, parziali, stream) cambiando sessione.
  return (
    <AgentSessionView
      key={route.params.id}
      id={route.params.id}
      focusQuestion={route.params.focus === "question"}
      navigation={navigation}
    />
  );
}

function AgentSessionView({
  id,
  focusQuestion,
  navigation,
}: {
  id: string;
  focusQuestion: boolean;
  navigation: Props["navigation"];
}) {
  const { t } = useTranslation();
  const now = useNow();
  const tabBarHeight = useBottomTabBarHeightSafe();
  const session = useAgentSession(id);
  const { detail, detailError } = session;
  // Testo e ultimo errore del campo vivono QUI, non in AgentComposer (vedi il docblock).
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const listRef = useRef<FlatList<TranscriptItem>>(null);
  const scrollRetried = useRef(false);
  // Il nuovo tentativo di scorrimento (sotto): cancellato se la schermata si smonta prima.
  const scrollRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (scrollRetryTimer.current !== null) clearTimeout(scrollRetryTimer.current);
    },
    [],
  );

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
  // La prima domanda aperta (in ordine di trascrizione), e dove sta nei dati invertiti.
  const openQuestionIndex = useMemo(() => {
    const first = items.find((item) => item.kind === "question" && !item.question.answered);
    return first === undefined ? -1 : reversed.indexOf(first);
  }, [items, reversed]);
  // Solo a prima pagina di eventi caricata: prima l'indice sarebbe quello di
  // una lista che sta per crescere attorno alla domanda.
  useScrollToQuestion(listRef, focusQuestion && session.eventsLoaded, openQuestionIndex);

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
          label={t("mobile.agents.retry")}
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
        <View style={styles.transcript}>
          {session.eventsError !== null ? (
            <Text style={styles.note}>{describeAgentSessionError(session.eventsError, t)}</Text>
          ) : session.eventsLoaded && items.length === 0 ? (
            <Text style={styles.empty}>{t("mobile.agents.noEvents")}</Text>
          ) : (
            <FlatList
              ref={listRef}
              inverted
              style={styles.list}
              data={reversed}
              keyExtractor={(item: TranscriptItem) => item.id}
              renderItem={({ item }) => (
                <View style={styles.item}>
                  {item.kind === "question" ? (
                    <SessionQuestion sessionId={id} item={item} live={live} />
                  ) : (
                    <TranscriptItemView item={item} live={live} />
                  )}
                </View>
              )}
              keyboardShouldPersistTaps="handled"
              // Invertita: il padding "in alto" del contenitore è il fondo a schermo
              // (lo spazio della barra delle schede lo porta il blocco in fondo).
              contentContainerStyle={{ paddingBottom: 16, paddingTop: 16 }}
              // La domanda può stare fuori dagli elementi già misurati: si scorre
              // alla stima e si riprova UNA volta, quando la lista li ha resi.
              onScrollToIndexFailed={(info) => {
                listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
                if (scrollRetried.current) return;
                scrollRetried.current = true;
                scrollRetryTimer.current = setTimeout(() => {
                  scrollRetryTimer.current = null;
                  listRef.current?.scrollToIndex({ index: info.index, viewPosition: 0.5 });
                }, 100);
              }}
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
        </View>
        <View style={[styles.bottom, { paddingBottom: 12 + tabBarHeight }]}>
          <ComposerArea
            sessionId={id}
            detail={detail}
            draft={draft}
            onDraftChange={setDraft}
            sendError={sendError}
            onSendErrorChange={setSendError}
          />
        </View>
      </>
    );
  }

  return (
    <TabScreenKeyboardAvoider style={styles.container}>
      <View style={styles.container} testID="agent-session-screen">
        <View style={styles.headerBox}>{header}</View>
        {body}
      </View>
    </TabScreenKeyboardAvoider>
  );
}

type SessionDetail = NonNullable<ReturnType<typeof useAgentSession>["detail"]>;

/**
 * Il campo e le righe che spiegano perché non si scrive (gemello di
 * `ComposerArea` del web). Permessi tutti dal server: il campo è montato con
 * `canWrite`, o con `canIntervene` a sessione `working`; scrivibile solo con
 * `canWrite`. Senza campo: «si può solo guardare» su un passo vivo non
 * interattivo, «solo un maintainer» su un passo vivo interattivo.
 */
function ComposerArea({
  sessionId,
  detail,
  draft,
  onDraftChange,
  sendError,
  onSendErrorChange,
}: {
  sessionId: string;
  detail: SessionDetail;
  draft: string;
  onDraftChange: (text: string) => void;
  sendError: string | null;
  onSendErrorChange: (error: string | null) => void;
}) {
  const { t } = useTranslation();
  const canWrite = detail.canWrite ?? false;
  const canIntervene = detail.canIntervene ?? false;
  const activeSegment = detail.activeSegment ?? null;
  const watchOnly = isWatchOnlyStep(activeSegment);

  if (canWrite || (canIntervene && detail.state === "working")) {
    return (
      <>
        <AgentComposer
          sessionId={sessionId}
          canInterrupt={detail.canInterrupt ?? false}
          enabled={canWrite}
          text={draft}
          onTextChange={onDraftChange}
          error={sendError}
          onErrorChange={onSendErrorChange}
        />
        {!canWrite && (
          <Text style={styles.readOnly}>
            {watchOnly ? t("mobile.agents.composer.readOnly") : t("mobile.agents.composer.between")}
          </Text>
        )}
      </>
    );
  }
  return (
    <>
      {sendError !== null && draft.trim().length > 0 && <UnsentMessage text={draft} error={sendError} />}
      {watchOnly && <Text style={styles.readOnly}>{t("mobile.agents.composer.readOnly")}</Text>}
      {!canIntervene && isInteractiveStep(activeSegment) && (
        <Text style={styles.readOnly}>{t("mobile.agents.composer.maintainerOnly")}</Text>
      )}
    </>
  );
}

/** Un segmento vivo fra quelli su cui si scrive (la costante condivisa). */
function isInteractiveStep(activeSegment: string | null): boolean {
  return activeSegment !== null && (INTERACTIVE_SEGMENTS as ReadonlySet<string>).has(activeSegment);
}

/**
 * R1 (come il web): la riga «si può solo guardare» c'è solo con un segmento
 * VIVO (il server valorizza `activeSegment` solo a segmento vivo e aperto) che
 * non è fra quelli interattivi — la costante condivisa, mai una copia. Un
 * segmento ignoto (segnaposto del reader) non è interattivo.
 */
function isWatchOnlyStep(activeSegment: string | null): boolean {
  if (activeSegment === null) return false;
  return !(INTERACTIVE_SEGMENTS as ReadonlySet<string>).has(activeSegment);
}

/**
 * Con `focus: "question"` la lista scorre alla prima domanda aperta, una volta
 * sola: appena compare (dettaglio ed eventi arrivano dopo il montaggio, e una
 * domanda può arrivare da un frame `session`). Dopo, chi legge si muove da sé.
 * L'INDICE è dei dati invertiti: per questo il chiamante aspetta la prima
 * pagina di eventi — sul web basta l'ancora, qui la posizione cambia con loro.
 */
function useScrollToQuestion(
  listRef: React.RefObject<FlatList<TranscriptItem> | null>,
  enabled: boolean,
  index: number,
) {
  const done = useRef(false);
  useEffect(() => {
    if (!enabled || done.current || index < 0) return;
    const list = listRef.current;
    if (list === null) return;
    done.current = true;
    list.scrollToIndex({ index, viewPosition: 0.5 });
  }, [listRef, enabled, index]);
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
  // Il blocco del campo resta in fondo anche con la trascrizione vuota.
  transcript: { flex: 1 },
  list: { flex: 1 },
  bottom: { gap: 8, paddingHorizontal: 16, paddingTop: 8 },
  readOnly: { color: colors.faint, fontFamily: fontFamily.mono, fontSize: 12 },
  older: { alignItems: "center", gap: 8, paddingVertical: 8 },
  centered: { alignItems: "center", gap: 12, paddingVertical: 32 },
  skeleton: { gap: 8, padding: 16 },
  note: { color: colors.muted, fontFamily: fontFamily.sans, fontSize: 14, padding: 16, textAlign: "center" },
  empty: { color: colors.faint, fontFamily: fontFamily.mono, fontSize: 12, padding: 16 },
});
