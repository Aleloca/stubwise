import { ApiError, isAgentSessionsUnavailable, type StubwiseClient } from "@stubwise/api-client";
import type { BacklogItemDetail, Reader } from "@stubwise/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import type { BacklogItemScreenProps } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
import { PrimaryButton } from "../../components/PrimaryButton";
import { PulseIndicator } from "../../components/PulseIndicator";
import { ScreenHeader } from "../../components/ScreenHeader";
import { SafeMarkdown } from "../../components/SafeMarkdown";
import { SheetModal } from "../../components/SheetModal";
import { Skeleton } from "../../components/Skeleton";
import { agentSessionQueryOptions } from "../../lib/agent-sessions-queries";
import { describeAgentSessionError } from "../../lib/agent-session-errors";
import { openAgentSession } from "../../lib/open-agent-session";
import { agentSessionKeys } from "../../lib/query-keys";
import {
  backlogKeys,
  backlogMetaParts,
  backlogStatusLabelKey,
  backlogDocumentBody,
  backlogStatusTone,
  navigateToTicketWork,
  useConvertBacklogItem,
} from "../../lib/backlog-mutations";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";
import { usePullToRefresh } from "../../components/PullToRefresh";

/** Vedi `InboxScreen.tsx` per il perché di una costante invece di leggere `styles.body.paddingBottom`. */
const CONTENT_BASE_BOTTOM_PADDING = 40;

/** Lo stesso tetto di `startRefineSessionInputSchema.message` lato server. */
const FIRST_MESSAGE_MAX = 4000;

/**
 * Dettaglio di sola lettura di una voce (canvas: nessun mockup dedicato —
 * `3a`/`3b`/`3c` coprono lista/cattura/chat, non un "dettaglio"). Raggiunta
 * da `BacklogScreen` SOLO per le voci `converted`/`archived` (chip "Tutti"):
 * sono le uniche card senza azioni proprie in lista (niente Procedi, niente
 * Raffina — vedi il commento su `BacklogListCard`), quindi la card INTERA è
 * lì cliccabile verso questo screen invece che verso un bottone.
 *
 * Lo screen resta comunque completo (documento, metadati, ticket collegati,
 * e — se lo stato lo permette — Procedi/Raffina) e non assume che l'unico
 * modo di arrivarci sia da una voce chiusa: un futuro deep link o un'altra
 * lista potrebbero puntare qui su una voce ancora attiva.
 */
export function BacklogItemScreen({ navigation, route }: BacklogItemScreenProps) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const tabBarHeight = useBottomTabBarHeight();
  const { id } = route.params;
  // Il server non ha la funzione (404 SENZA `code` all'avvio, design §6.2):
  // l'app non può saperlo prima — `readerSchema` dà `refineSession: null` a un
  // dettaglio che non lo porta — quindi lo impara al primo tentativo. In
  // memoria della schermata, mai persistito: un server aggiornato lo rende
  // vero alla prossima apertura.
  const [refineUnavailable, setRefineUnavailable] = useState(false);
  const onOpenSession = useCallback((sessionId: string) => openAgentSession(navigation, { id: sessionId }), [navigation]);
  const onRefineUnavailable = useCallback(() => setRefineUnavailable(true), []);

  const itemQuery = useQuery({
    queryKey: backlogKeys.item(id),
    queryFn: () => {
      if (!client) throw new Error("BacklogItemScreen richiede un client autenticato");
      return client.backlog.get(id);
    },
    enabled: client !== null,
    staleTime: 10_000,
  });

  const convert = useConvertBacklogItem();

  const notFound = itemQuery.isError && itemQuery.error instanceof ApiError && itemQuery.error.status === 404;

  // Task 7 (App M1+M2, 11 set 2026): un solo `ScrollView`, il link
  // "indietro" come primo figlio — stesso schema di `InboxScreen.tsx`.
  // Fix di review (Task 2, 11 set 2026): l'avatar, mancante del tutto su
  // questo screen, ora c'è sulla stessa riga — ancorata
  // (`stickyHeaderIndices`, vedi `ScreenHeader.tsx`).
  //
  // 16 set 2026: ed è lo STESSO `ScreenHeader` del resto dell'app, col TITOLO
  // dentro — non più un'intestazione costruita a mano con il solo «indietro»
  // e l'avatar, col titolo nel corpo che scorre via. Stesso trattamento del
  // dettaglio di una email: scorrendo un documento lungo si continua a vedere
  // di quale voce si sta leggendo.
  // Con una sessione di refinement attiva si rilegge anche il suo stato.
  const activeRefineId = refineSessionId(itemQuery.data);
  const refreshControl = usePullToRefresh(
    [backlogKeys.item(id), ...(activeRefineId !== null ? [agentSessionKeys.detail(activeRefineId)] : [])],
    "backlog-item-refresh",
  );

  return (
    <View style={styles.container}>
      <ScrollView
        refreshControl={refreshControl}
        contentContainerStyle={[styles.body, { paddingBottom: CONTENT_BASE_BOTTOM_PADDING + tabBarHeight }]}
        stickyHeaderIndices={[0]}
      >
        <ScreenHeader
          title={itemQuery.data?.title ?? t("mobile.backlog.item.fallbackTitle")}
          onBack={() => navigation.goBack()}
          backLabel={t("mobile.backlog.item.back")}
          titleNumberOfLines={3}
        />

        {itemQuery.isPending ? (
          <View style={styles.skeletonList} testID="backlog-item-skeleton">
            <Skeleton height={28} width="70%" />
            <Skeleton height={90} />
            <Skeleton height={140} />
          </View>
        ) : notFound ? (
          <View style={styles.centered} testID="backlog-item-not-found">
            <Text style={styles.errorTitle}>{t("mobile.backlog.item.notFound.title")}</Text>
            <Text style={styles.errorBody}>{t("mobile.backlog.item.notFound.body")}</Text>
          </View>
        ) : itemQuery.isError ? (
          <View style={styles.centered} testID="backlog-item-error">
            <Text style={styles.errorTitle}>{t("mobile.backlog.item.loadError.title")}</Text>
            <GhostButton label={t("mobile.backlog.item.loadError.retry")} onPress={() => void itemQuery.refetch()} testID="backlog-item-retry" />
          </View>
        ) : (
          <ItemBody
            item={itemQuery.data!}
            onProceed={() =>
              convert.mutate(id, {
                onSuccess: (result) => navigateToTicketWork(navigation, result.ticketId),
              })
            }
            proceedPending={convert.isPending}
            convertErrorMessage={convert.errorMessage}
            onRefine={() => navigation.navigate("Chat", { id })}
            onOpenTicket={(ticketId) => navigateToTicketWork(navigation, ticketId)}
            refineUnavailable={refineUnavailable}
            onOpenSession={onOpenSession}
            onRefineUnavailable={onRefineUnavailable}
          />
        )}
      </ScrollView>
    </View>
  );
}

function ItemBody({
  item,
  onProceed,
  proceedPending,
  convertErrorMessage,
  onRefine,
  onOpenTicket,
  refineUnavailable,
  onOpenSession,
  onRefineUnavailable,
}: {
  item: Reader<BacklogItemDetail>;
  onProceed: () => void;
  proceedPending: boolean;
  convertErrorMessage: string | null;
  onRefine: () => void;
  onOpenTicket: (ticketId: string) => void;
  refineUnavailable: boolean;
  onOpenSession: (sessionId: string) => void;
  onRefineUnavailable: () => void;
}) {
  const { t } = useTranslation();
  // Il dettaglio (`BacklogItemDetail`) non porta `ticketCount` come la lista
  // (`BacklogItem`) — porta `tickets`, l'elenco intero: `.length` è
  // l'equivalente qui.
  const metaText = backlogMetaParts({ ...item, ticketCount: item.tickets.length })
    .map((part) => t(part.key, part.params))
    .join(" · ");
  const isReady = item.status === "ready";
  const canRefine = item.status !== "converted" && item.status !== "archived";

  // Task 7 (App M1+M2, 11 set 2026): non più il proprio `ScrollView` — è
  // già dentro quello di `BacklogItemScreen`, che ora avvolge anche il link
  // "indietro" sopra di lui.
  return (
    <>
      {/*
        La pallina dello stato su una riga SUA (16 set 2026): stava accanto ai
        metadati in una riga sola, e il testo le si avvolgeva intorno uscendo
        dal bordo destro — «rischio medio» finiva tagliato a metà. Qui lo
        spazio verticale c'è, e due righe che non si contendono la larghezza
        si leggono meglio di una che sborda.
      */}
      <View style={styles.statusRow}>
        <PulseIndicator tone={backlogStatusTone(item.status)} text={t(backlogStatusLabelKey(item.status))} />
      </View>
      <Text style={styles.meta}>{metaText}</Text>

      {item.document.trim() === "" ? (
        <Text style={styles.document}>{t("mobile.backlog.item.noDocument")}</Text>
      ) : (
        /*
         * Il documento di una voce di backlog È markdown — spesso un design
         * doc salvato per intero — e fino al 16 set 2026 arrivava a schermo
         * come testo grezzo, cancelletti e asterischi compresi: illeggibile.
         * Il renderer e il tema esistono già e li usano le pagine Docs, il
         * piano di un ticket e il dettaglio progetto; qui mancava e basta.
         *
         * ⚠️ Questo NON contraddice la regola del corpo delle email, che
         * resta testo letterale: lì il markup lo scriverebbe un estraneo e
         * reinterpretarlo sarebbe sbagliato. Qui il documento è materiale
         * nostro o passato dall'intake.
         *
         * `onLinkPress` con l'allowlist condivisa (`isSafeWebUrl`): il
         * renderer, lasciato a sé, aprirebbe QUALUNQUE href — e una voce di
         * backlog può nascere anche da testo che non abbiamo scritto noi.
         */
        <SafeMarkdown>{backlogDocumentBody(item.document, item.title)}</SafeMarkdown>
      )}

      {(isReady || canRefine) && (
        <View style={styles.actions}>
          {isReady && (
            <View style={styles.proceedButton}>
              <PrimaryButton label={t("mobile.backlog.actions.proceed")} onPress={onProceed} disabled={proceedPending} testID="backlog-item-proceed" />
            </View>
          )}
          {canRefine && (
            <View style={styles.refineButton}>
              <GhostButton besidePrimary label={t("mobile.backlog.actions.refineInChat")} onPress={onRefine} testID="backlog-item-refine" />
            </View>
          )}
        </View>
      )}

      {refineUnavailable ? (
        canRefine && (
          <Text style={styles.refineNote} testID="backlog-item-refine-unavailable">
            {t("mobile.backlog.refineSession.unavailable")}
          </Text>
        )
      ) : (
        <RefineSessionControls
          item={item}
          locked={!canRefine}
          onOpenSession={onOpenSession}
          onUnavailable={onRefineUnavailable}
        />
      )}

      {convertErrorMessage !== null && (
        <Text accessibilityLiveRegion="polite" style={styles.errorText} testID="backlog-item-convert-error">
          {convertErrorMessage}
        </Text>
      )}

      {item.tickets.length > 0 && (
        <View style={styles.ticketsBlock}>
          <Text style={styles.ticketsTitle}>{t("mobile.backlog.item.linkedTickets")}</Text>
          {item.tickets.map((ticket) => (
            <Pressable
              key={ticket.id}
              onPress={() => onOpenTicket(ticket.id)}
              style={styles.ticketRow}
              testID={`backlog-item-ticket-${ticket.id}`}
            >
              <Text style={styles.ticketNumber}>#{ticket.number}</Text>
              <Text style={styles.ticketTitle} numberOfLines={1}>
                {ticket.title}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </>
  );
}

/** L'id della sessione di refinement ATTIVA della voce, se c'è. */
function refineSessionId(item: Reader<BacklogItemDetail> | undefined): string | null {
  const refine = item?.refineSession ?? null;
  return refine !== null && refine.status === "active" ? refine.agentSessionId : null;
}

/**
 * La sessione di refinement dalla pagina della voce (design 2026-10-14 §6.2,
 * gemello di `RefineSessionCard` del web). Senza sessione o a sessione chiusa:
 * «Inizia sessione» / «Riprendi sessione», che apre un foglio col primo
 * messaggio facoltativo e «Avvia». Con una sessione attiva: lo stato (letto
 * dal dettaglio della SESSIONE, mai dedotto dalla voce) e «Apri la sessione».
 *
 * ⚠️ IL FOGLIO PORTA A UN'ALTRA SCHERMATA, quindi chiudere, smontare, POI
 * navigare (invariante dell'app, 5 ott 2026, `GlobalSearchSheet` +
 * `ScreenHeader`): l'avvio riuscito chiude solo il PANNELLO (`sheetOpen`
 * falso), il foglio si smonta in `onDidDismiss` (`sheetMounted` falso), e
 * l'apertura della sessione la fa un effetto DOPO il commit che l'ha tolto.
 * Lo stesso vale per il 404 senza `code`: nascondere i controlli smonterebbe
 * il foglio ancora presentato, quindi anche quello aspetta lo smontaggio.
 * Per la stessa ragione il foglio resta montato anche quando la voce diventa
 * chiusa sotto di lui (un 409 `item_closed` rilegge la voce): `locked` toglie
 * i bottoni, non il foglio. ⚠️ Il mock Jest del foglio chiude in modo
 * sincrono: la verifica vera è sul telefono.
 */
function RefineSessionControls({
  item,
  locked,
  onOpenSession,
  onUnavailable,
}: {
  item: Reader<BacklogItemDetail>;
  locked: boolean;
  onOpenSession: (sessionId: string) => void;
  onUnavailable: () => void;
}) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const refine = item.refineSession ?? null;
  const activeId = refineSessionId(item);
  const [sheetMounted, setSheetMounted] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [message, setMessage] = useState("");
  const afterDismiss = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (sheetMounted) return;
    const run = afterDismiss.current;
    afterDismiss.current = null;
    run?.();
  }, [sheetMounted]);

  const session = useQuery({
    ...agentSessionQueryOptions(client as StubwiseClient, activeId ?? ""),
    // La pagina della voce non segue la sessione dal vivo: lo stato si legge
    // all'apertura (e col pull-to-refresh), lo stream è della sua schermata.
    refetchInterval: false,
    enabled: client !== null && activeId !== null && !locked,
  });

  const start = useMutation({
    mutationFn: (firstMessage: string | undefined) => {
      if (!client) return Promise.reject(new Error("RefineSessionControls richiede un client autenticato"));
      return client.backlogRefine.start(item.id, firstMessage !== undefined ? { message: firstMessage } : {});
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: backlogKeys.item(item.id) });
      afterDismiss.current = () => onOpenSession(result.agentSessionId);
      setSheetOpen(false);
    },
    onError: (error) => {
      if (isAgentSessionsUnavailable(error)) {
        afterDismiss.current = onUnavailable;
        setSheetOpen(false);
        return;
      }
      // La voce è stata chiusa nel frattempo: la si rilegge, e i bottoni spariscono.
      if (error instanceof ApiError && error.code === "item_closed") {
        void queryClient.invalidateQueries({ queryKey: backlogKeys.item(item.id) });
      }
    },
  });

  function openSheet(): void {
    start.reset();
    setMessage("");
    setSheetMounted(true);
    setSheetOpen(true);
  }

  function launch(): void {
    const trimmed = message.trim();
    // Un primo messaggio vuoto non si manda: la sessione parte senza.
    start.mutate(trimmed.length > 0 ? trimmed : undefined);
  }

  const errorText =
    start.error === null
      ? null
      : start.error instanceof ApiError && start.error.code === "item_closed"
        ? t("mobile.backlog.refineSession.itemClosed")
        : t("mobile.backlog.refineSession.error", { reason: describeAgentSessionError(start.error, t) });

  const state = session.data?.state;
  const activeText =
    state === "working" || state === "queued"
      ? t("mobile.backlog.refineSession.working")
      : state === "idle"
        ? t("mobile.backlog.refineSession.ready")
        : t("mobile.backlog.refineSession.active");

  return (
    <>
      {!locked && activeId !== null && (
        <View style={styles.refineSession}>
          <Text style={styles.refineNote} testID="backlog-item-refine-session-state">
            {activeText}
          </Text>
          <GhostButton
            label={t("mobile.backlog.refineSession.open")}
            onPress={() => onOpenSession(activeId)}
            testID="backlog-item-open-session"
          />
        </View>
      )}
      {!locked && activeId === null && (
        <View style={styles.refineSession}>
          <GhostButton
            label={refine === null ? t("mobile.backlog.refineSession.start") : t("mobile.backlog.refineSession.resume")}
            onPress={openSheet}
            disabled={start.isPending}
            testID="backlog-item-refine-session"
          />
        </View>
      )}
      {sheetMounted && (
        <SheetModal
          open={sheetOpen}
          onClose={() => {
            setSheetOpen(false);
            setSheetMounted(false);
          }}
          dismissible={!start.isPending}
          testID="refine-session-sheet"
        >
          <Text accessibilityRole="header" style={styles.sheetTitle}>
            {t("mobile.backlog.refineSession.title")}
          </Text>
          <Text style={styles.sheetLabel}>{t("mobile.backlog.refineSession.firstMessage")}</Text>
          <TextInput
            accessibilityLabel={t("mobile.backlog.refineSession.firstMessage")}
            value={message}
            onChangeText={setMessage}
            editable={!start.isPending}
            multiline
            maxLength={FIRST_MESSAGE_MAX}
            placeholder={t("mobile.backlog.refineSession.firstMessageHint")}
            placeholderTextColor={colors.faint}
            style={styles.sheetInput}
            testID="refine-session-first-message"
          />
          {errorText !== null && (
            <Text accessibilityLiveRegion="polite" style={styles.errorText} testID="refine-session-error">
              {errorText}
            </Text>
          )}
          <View style={styles.actions}>
            <View style={styles.proceedButton}>
              <PrimaryButton
                label={
                  start.isPending ? t("mobile.backlog.refineSession.launching") : t("mobile.backlog.refineSession.launch")
                }
                onPress={launch}
                pending={start.isPending}
                disabled={locked}
                testID="refine-session-launch"
              />
            </View>
            <View style={styles.refineButton}>
              <GhostButton
                besidePrimary
                label={t("mobile.backlog.refineSession.cancel")}
                onPress={() => setSheetOpen(false)}
                disabled={start.isPending}
                testID="refine-session-cancel"
              />
            </View>
          </View>
        </SheetModal>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  // Task 7: niente più `paddingHorizontal`/`paddingTop` propri — vivono in
  // `body` (vedi il commento gemello in `ProjectDetailScreen.tsx`).
  // Fix di review (Task 2, 11 set 2026): `headerRow` è ora ANCORATA
  // (`stickyHeaderIndices` sullo `ScrollView` sopra) e porta anche
  // l'avatar — `backgroundColor` opaco necessario, o il contenuto sotto
  // l'attraverserebbe scorrendo.
  headerRow: {
    alignItems: "center",
    backgroundColor: colors.ink950,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingBottom: 12,
    paddingTop: 56,
  },
  backRow: {},
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
    gap: 8,
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  errorTitle: {
    color: colors.fg,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 15,
    fontWeight: "600",
    textAlign: "center",
  },
  errorBody: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 14,
    textAlign: "center",
  },
  body: {
    gap: 4,
    padding: 20,
    paddingBottom: 40,
  },
  statusRow: {
    alignItems: "flex-start",
    flexDirection: "row",
    marginTop: 8,
  },
  meta: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  document: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.body,
    lineHeight: 20,
    marginTop: 14,
  },
  actions: {
    flexDirection: "row",
    gap: 8,
    marginTop: 18,
  },
  proceedButton: {
    flex: 1.6,
  },
  refineButton: {
    flex: 1,
  },
  refineSession: {
    gap: 8,
    marginTop: 10,
  },
  refineNote: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    marginTop: 10,
  },
  sheetTitle: {
    color: colors.fg,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 16,
    fontWeight: "600",
  },
  sheetLabel: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    marginTop: 14,
  },
  sheetInput: {
    backgroundColor: colors.ink950,
    borderColor: colors.line,
    borderRadius: radii.control,
    borderWidth: 1,
    color: colors.fg,
    fontFamily: fontFamily.sans,
    fontSize: 14,
    marginTop: 6,
    maxHeight: 160,
    minHeight: 88,
    padding: 10,
    textAlignVertical: "top",
  },
  errorText: {
    color: colors.danger,
    fontFamily: fontFamily.sans,
    fontSize: 13,
    marginTop: 10,
  },
  ticketsBlock: {
    marginTop: 22,
  },
  ticketsTitle: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 1,
    marginBottom: 6,
    textTransform: "uppercase",
  },
  ticketRow: {
    alignItems: "center",
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.control,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    marginTop: 6,
    minHeight: 44,
    paddingHorizontal: 12,
  },
  ticketNumber: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  ticketTitle: {
    color: colors.fg,
    flexShrink: 1,
    fontFamily: fontFamily.sans,
    fontSize: 14,
  },
});
