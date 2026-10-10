import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { ApiError, isAgentSessionsUnavailable } from "@stubwise/api-client";
import { useIsMutating } from "@tanstack/react-query";
import { buildTranscript, elapsedParts, INTERACTIVE_SEGMENTS, isUnknown, type TranscriptItem } from "@stubwise/shared";
import type { TFunction } from "i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { RootStackParamList } from "../../app/navigation";
import { AgentComposer, type AgentComposerField, UnsentMessage } from "../../components/agents/AgentComposer";
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
import { agentSessionKeys } from "../../lib/query-keys";
import { colors, pillRadius } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

type Props = NativeStackScreenProps<RootStackParamList, "AgentSession">;

/**
 * Oltre quanti punti dal fondo compare il «↓» (lista INVERTITA: l'offset 0 è
 * il fondo). Poco più di uno schermo di testo: qualche riga sopra il fondo non
 * merita un bottone sopra il campo.
 */
const SCROLL_BOTTOM_THRESHOLD = 240;

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
 * - Sta sul ROOT stack, fuori dalle schede (9 ott 2026, Task A1): niente barra
 *   in basso. Il link al ticket apre `Ticket` sul root stack, sopra la
 *   sessione: indietro torna qui.
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
 * - Composer DOCKED (Task A2): il campo arrotondato sta fisso in fondo e la
 *   lista invertita si accorcia sopra di lui. Al suo posto, quando non si
 *   scrive, una barra sottile della stessa altezza (niente salti): «Sessione
 *   conclusa», «solo un maintainer», o «si può solo guardare». Lontano dal
 *   fondo (offset oltre {@link SCROLL_BOTTOM_THRESHOLD}) un «↓» tondo, appena
 *   sopra il campo, riporta in fondo. «Rimanda» su un intervento non
 *   consegnato rimette il testo nel campo e ci mette il focus: non invia.
 * - Tastiera: campo FISSO in fondo, quindi `TabScreenKeyboardAvoider` come le
 *   due chat (backlog e «Chiedi al progetto»), non le prop della pagina che
 *   scorre. Fuori dalle schede la sua altezza «della barra» è l'inset in basso
 *   (`useBottomTabBarHeightSafe`), la stessa del `paddingBottom` del campo: lo
 *   scostamento toglie ciò che il campo già porta, e il campo si ferma appena
 *   sopra la tastiera.
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
  const fieldRef = useRef<AgentComposerField>(null);
  // Il «↓»: lo stato cambia solo attraversando la soglia, non a ogni evento di scorrimento.
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const away = event.nativeEvent.contentOffset.y > SCROLL_BOTTOM_THRESHOLD;
    setAwayFromBottom((previous) => (previous === away ? previous : away));
  }, []);
  // «Rimanda» (fix della review): non cancella ciò che si stava scrivendo —
  // lo AGGIUNGE dopo una riga vuota — e porta focus e cursore in fondo DOPO
  // che il valore nuovo è nel campo (il contatore fa scattare l'effetto anche
  // se il testo risultante è uguale a prima). Spento durante un invio: al suo
  // successo il campo si svuota, e il testo rimandato sparirebbe.
  const sending = useIsMutating({ mutationKey: agentSessionKeys.send(id) }) > 0;
  const [resendTick, setResendTick] = useState(0);
  const resend = useCallback((text: string) => {
    setDraft((previous) => (previous.trim().length > 0 ? `${previous}\n\n${text}` : text));
    setResendTick((n) => n + 1);
  }, []);
  const draftLength = draft.length;
  useEffect(() => {
    if (resendTick === 0) return;
    const field = fieldRef.current;
    field?.focus();
    // `setSelection` c'è sul TextInput vero; nei doppi può mancare.
    (field as { setSelection?: (start: number, end: number) => void } | null)?.setSelection?.(
      draftLength,
      draftLength,
    );
    // Solo al «Rimanda»: scrivere non deve spostare il cursore.
  }, [resendTick]);
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
    // «Rimanda» solo se c'è un campo in cui rimettere il testo (la stessa regola che lo monta).
    const onResend = composerMounted(detail) ? resend : undefined;
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
                    <TranscriptItemView item={item} live={live} onResend={onResend} resendDisabled={sending} />
                  )}
                </View>
              )}
              keyboardShouldPersistTaps="handled"
              onScroll={onScroll}
              scrollEventThrottle={32}
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
          {awayFromBottom && (
            <View pointerEvents="box-none" style={styles.fabRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("mobile.agents.scrollToBottom")}
                onPress={() => listRef.current?.scrollToOffset({ offset: 0, animated: true })}
                style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
                testID="agent-session-scroll-bottom"
              >
                <Text style={styles.fabGlyph}>↓</Text>
              </Pressable>
            </View>
          )}
        </View>
        <View style={[styles.bottom, { paddingBottom: 12 + tabBarHeight }]} testID="agent-session-bottom">
          <ComposerArea
            sessionId={id}
            detail={detail}
            draft={draft}
            onDraftChange={setDraft}
            sendError={sendError}
            onSendErrorChange={setSendError}
            fieldRef={fieldRef}
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
 * Il campo è MONTATO con `canWrite`, o con `canIntervene` a sessione `working`
 * (fra un segmento e l'altro: resta montato, spento, per non perdere la
 * tastiera). Una regola sola: la usano il campo e «Rimanda».
 */
function composerMounted(detail: SessionDetail): boolean {
  return (detail.canWrite ?? false) || ((detail.canIntervene ?? false) && detail.state === "working");
}

/**
 * Il campo, o la barra che dice perché non c'è (gemello di `ComposerArea` del
 * web). Permessi tutti dal server: il campo è montato secondo
 * {@link composerMounted}, scrivibile solo con `canWrite` — spento, il perché
 * è il suo segnaposto. Senza campo, una barra sottile della stessa altezza:
 * «Sessione conclusa», «si può solo guardare» su un passo vivo non
 * interattivo, «solo un maintainer» su un passo vivo interattivo.
 */
function ComposerArea({
  sessionId,
  detail,
  draft,
  onDraftChange,
  sendError,
  onSendErrorChange,
  fieldRef,
}: {
  sessionId: string;
  detail: SessionDetail;
  draft: string;
  onDraftChange: (text: string) => void;
  sendError: string | null;
  onSendErrorChange: (error: string | null) => void;
  fieldRef: React.RefObject<AgentComposerField | null>;
}) {
  const { t } = useTranslation();
  const canWrite = detail.canWrite ?? false;
  const canIntervene = detail.canIntervene ?? false;
  const activeSegment = detail.activeSegment ?? null;
  const watchOnly = isWatchOnlyStep(activeSegment);

  if (composerMounted(detail)) {
    return (
      <AgentComposer
        sessionId={sessionId}
        canInterrupt={detail.canInterrupt ?? false}
        enabled={canWrite}
        readOnlyNote={
          watchOnly ? t("mobile.agents.composer.readOnly") : t("mobile.agents.composer.between")
        }
        text={draft}
        onTextChange={onDraftChange}
        error={sendError}
        onErrorChange={onSendErrorChange}
        fieldRef={fieldRef}
      />
    );
  }
  let bar: string;
  if (detail.state === "ended") bar = t("mobile.agents.composer.ended");
  else if (watchOnly) bar = t("mobile.agents.composer.readOnly");
  else if (!canIntervene && isInteractiveStep(activeSegment)) bar = t("mobile.agents.composer.maintainerOnly");
  // Niente salti: ogni altro stato senza campo (fermo, in coda, in attesa
  // dell'approvazione, fra due passi senza poter intervenire…) ha la sua barra,
  // con lo stato della sessione nelle parole che l'intestazione usa già.
  else bar = t("mobile.agents.composer.unavailable", { state: t(`mobile.agents.state.${key(detail.state)}`) });
  return (
    <>
      {sendError !== null && draft.trim().length > 0 && <UnsentMessage text={draft} error={sendError} />}
      <View style={styles.bar} testID="agent-composer-bar">
        <Text style={styles.readOnly}>{bar}</Text>
      </View>
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
  readOnly: { color: colors.faint, fontFamily: fontFamily.mono, fontSize: 12, textAlign: "center" },
  // La barra al posto del campo: la stessa altezza minima, niente salti.
  bar: {
    alignItems: "center",
    borderColor: colors.line,
    borderRadius: pillRadius,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 14,
  },
  // Il «↓»: tondo, centrato, appena sopra il campo (dentro la trascrizione, in basso).
  fabRow: { alignItems: "center", bottom: 10, left: 0, position: "absolute", right: 0 },
  fab: {
    alignItems: "center",
    backgroundColor: colors.ink850,
    borderColor: colors.lineStrong,
    borderRadius: 18,
    borderWidth: 1,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  fabPressed: { backgroundColor: colors.ink800 },
  fabGlyph: { color: colors.fg, fontFamily: fontFamily.sans, fontSize: 18, lineHeight: 20 },
  older: { alignItems: "center", gap: 8, paddingVertical: 8 },
  centered: { alignItems: "center", gap: 12, paddingVertical: 32 },
  skeleton: { gap: 8, padding: 16 },
  note: { color: colors.muted, fontFamily: fontFamily.sans, fontSize: 14, padding: 16, textAlign: "center" },
  empty: { color: colors.faint, fontFamily: fontFamily.mono, fontSize: 12, padding: 16 },
});
