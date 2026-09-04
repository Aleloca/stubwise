import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { ApiError } from "@stubwise/api-client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { BacklogStackParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
import { PulseIndicator } from "../../components/PulseIndicator";
import { Skeleton } from "../../components/Skeleton";
import { backlogKeys, useSendBacklogChatMessage } from "../../lib/backlog-mutations";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

interface ChatBubble {
  id: string;
  role: "user" | "assistant";
  text: string;
}

/**
 * Chat di raffinamento (canvas `3c`), modalità TESTUALE — bolle utente/agente
 * e una sola risposta intera, non SSE: invia con `client.backlog.chatText`
 * (non `client.backlog.chat`, che il testo del Task 17 cita ma che è la
 * modalità 202/sessione-attiva del pacchetto reale — vedi il commento su
 * `useSendBacklogChatMessage` in `lib/backlog-mutations.ts`). Nessuna UI a
 * scelta multipla (il canvas ne mostra una come esempio, ma la modalità
 * "sessione di analisi sul codice" che la produce non è nello scope di questo
 * task — nessuna schermata mobile la avvia).
 *
 * L'indicatore «sta pensando» NON lampeggia (`PulseIndicator`, statico):
 * scelta deliberata, non una svista sul copy del canvas — `Skeleton.tsx`
 * documenta l'invariante di design «niente skeleton animati, transizioni
 * decorative» e `WorkingPill.tsx` applica la stessa scelta al pallino "sta
 * lavorando" per non tenere viva la suite Jest con un timer decorativo.
 *
 * ⚠️ GUARDIA `codeSession`: `chatText` fallisce con `invalid_response` se una
 * sessione di analisi sul codice è attiva sulla voce (avviata da web) — è il
 * CHIAMANTE a doverlo sapere PRIMA di scegliere `chatText`, non dopo (vedi il
 * commento su `chatText` in `packages/api-client/src/endpoints/backlog.ts`).
 * `BacklogItemDetail.codeSession` (già nel payload di `client.backlog.get`)
 * dice appunto questo: quando non è `null` il composer si disabilita con un
 * messaggio dedicato invece di lasciar fallire l'invio in modo opaco. Gestire
 * per intero la modalità CODE (bolle a bottoni, turni via job) resta FUORI
 * SCOPE per questo task — nessuna schermata mobile avvia una sessione di
 * analisi — questa è solo la guardia che evita la chiamata sbagliata.
 */
export function BacklogChatScreen({ navigation, route }: NativeStackScreenProps<BacklogStackParamList, "Chat">) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const { id } = route.params;

  const itemQuery = useQuery({
    queryKey: backlogKeys.item(id),
    queryFn: () => {
      if (!client) throw new Error("BacklogChatScreen richiede un client autenticato");
      return client.backlog.get(id);
    },
    enabled: client !== null,
    staleTime: 10_000,
  });

  const send = useSendBacklogChatMessage();
  const [bubbles, setBubbles] = useState<ChatBubble[]>([]);
  const [draft, setDraft] = useState("");
  const seeded = useRef(false);
  const bubbleId = useRef(0);

  // Semina la conversazione con la storia già persistita (`system` esclusi:
  // sono marker interni, non bolle da mostrare) SOLO la prima volta che il
  // dettaglio arriva — un refetch successivo (es. dopo l'invalidazione di
  // `useConvertBacklogItem` altrove) non deve azzerare le bolle già scambiate
  // in questa sessione di schermata.
  useEffect(() => {
    if (seeded.current || !itemQuery.data) return;
    seeded.current = true;
    setBubbles(
      itemQuery.data.messages
        .filter(
          (message): message is typeof message & { role: "user" | "assistant" } =>
            message.role === "user" || message.role === "assistant",
        )
        .map((message) => ({ id: message.id, role: message.role, text: message.content })),
    );
  }, [itemQuery.data]);

  function nextLocalId(): string {
    bubbleId.current += 1;
    return `local-${bubbleId.current}`;
  }

  function handleSend(): void {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || send.disabled || codeSessionActive) return;
    setBubbles((current) => [...current, { id: nextLocalId(), role: "user", text: trimmed }]);
    setDraft("");
    send.mutate(
      { id, message: trimmed },
      {
        onSuccess: (result) => {
          setBubbles((current) => [...current, { id: nextLocalId(), role: "assistant", text: result.answer }]);
        },
      },
    );
  }

  const notFound = itemQuery.isError && itemQuery.error instanceof ApiError && itemQuery.error.status === 404;
  // Sessione di analisi sul codice attiva (avviata da web): niente invio da
  // qui, vedi il commento in testa al file.
  const codeSessionActive = itemQuery.data?.codeSession != null;
  const canSend = draft.trim().length > 0 && !send.disabled && !codeSessionActive;

  return (
    <View style={styles.container}>
      <Pressable onPress={() => navigation.goBack()} testID="backlog-chat-back" style={styles.backRow}>
        <Text style={styles.back}>{t("mobile.backlog.chat.back")}</Text>
      </Pressable>

      {itemQuery.isPending ? (
        <View style={styles.skeletonList} testID="backlog-chat-skeleton">
          <Skeleton height={24} width="60%" />
          <Skeleton height={100} />
        </View>
      ) : notFound ? (
        <View style={styles.centered} testID="backlog-chat-not-found">
          <Text style={styles.errorTitle}>{t("mobile.backlog.item.notFound.title")}</Text>
          <Text style={styles.errorBody}>{t("mobile.backlog.item.notFound.body")}</Text>
        </View>
      ) : itemQuery.isError ? (
        <View style={styles.centered} testID="backlog-chat-error">
          <Text style={styles.errorTitle}>{t("mobile.backlog.item.loadError.title")}</Text>
          <GhostButton label={t("mobile.backlog.item.loadError.retry")} onPress={() => void itemQuery.refetch()} testID="backlog-chat-retry" />
        </View>
      ) : (
        <>
          <Text style={styles.title} numberOfLines={2}>
            {itemQuery.data!.title}
          </Text>

          <ScrollView style={styles.messages} contentContainerStyle={styles.messagesContent}>
            {bubbles.map((bubble) => (
              <View
                key={bubble.id}
                style={[styles.bubble, bubble.role === "user" ? styles.bubbleUser : styles.bubbleAgent]}
                testID={`backlog-chat-bubble-${bubble.id}`}
              >
                {bubble.role === "assistant" && <Text style={styles.bubbleLabel}>{t("mobile.backlog.chat.agent")}</Text>}
                <Text style={styles.bubbleText}>{bubble.text}</Text>
              </View>
            ))}
            {send.isPending && (
              <View style={styles.thinkingRow} testID="backlog-chat-thinking">
                <PulseIndicator tone="sky" text={t("mobile.backlog.chat.thinking")} />
              </View>
            )}
          </ScrollView>

          {send.errorMessage !== null && (
            <Text accessibilityLiveRegion="polite" style={styles.errorText} testID="backlog-chat-send-error">
              {send.errorMessage}
            </Text>
          )}

          {codeSessionActive && (
            <Text style={styles.notice} testID="backlog-chat-code-session-notice">
              {t("mobile.backlog.chat.codeSessionActive")}
            </Text>
          )}

          <View style={styles.composer}>
            <TextInput
              accessibilityLabel={t("mobile.backlog.chat.placeholder")}
              value={draft}
              onChangeText={setDraft}
              editable={!send.disabled && !codeSessionActive}
              placeholder={t("mobile.backlog.chat.placeholder")}
              placeholderTextColor={colors.faint}
              style={styles.input}
              testID="backlog-chat-input"
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("mobile.backlog.chat.send")}
              accessibilityState={{ disabled: !canSend }}
              disabled={!canSend}
              onPress={handleSend}
              style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
              testID="backlog-chat-send"
            >
              <Text style={styles.sendButtonLabel}>↑</Text>
            </Pressable>
          </View>
        </>
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
    gap: 8,
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  errorTitle: {
    color: colors.fg,
    fontSize: 15,
    fontWeight: "600",
    textAlign: "center",
  },
  errorBody: {
    color: colors.muted,
    fontSize: 14,
    textAlign: "center",
  },
  title: {
    color: colors.fg,
    fontSize: 20,
    fontWeight: "700",
    lineHeight: 25,
    marginTop: 8,
    paddingHorizontal: 20,
  },
  messages: {
    flex: 1,
    marginTop: 12,
  },
  messagesContent: {
    gap: 10,
    padding: 16,
    paddingBottom: 24,
  },
  bubble: {
    borderRadius: radii.card,
    borderWidth: 1,
    maxWidth: "85%",
    padding: 12,
  },
  bubbleAgent: {
    alignSelf: "flex-start",
    backgroundColor: colors.ink900,
    borderColor: colors.line,
  },
  bubbleUser: {
    alignSelf: "flex-end",
    backgroundColor: "rgba(245,166,35,0.08)",
    borderColor: "#b97d1a",
  },
  bubbleLabel: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1,
    marginBottom: 4,
    textTransform: "uppercase",
  },
  bubbleText: {
    color: colors.fg,
    fontSize: 14,
    lineHeight: 20,
  },
  thinkingRow: {
    paddingHorizontal: 4,
  },
  errorText: {
    color: colors.danger,
    fontSize: 13,
    marginHorizontal: 16,
  },
  notice: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    marginHorizontal: 16,
    marginTop: 4,
  },
  composer: {
    alignItems: "center",
    borderTopColor: colors.line,
    borderTopWidth: 1,
    flexDirection: "row",
    gap: 8,
    paddingBottom: 40,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  input: {
    backgroundColor: "rgba(10,13,16,0.7)",
    borderColor: "#2c3641",
    borderRadius: 20,
    borderWidth: 1,
    color: colors.fg,
    flex: 1,
    fontSize: fontSize.input,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  sendButton: {
    alignItems: "center",
    backgroundColor: colors.signal,
    borderRadius: 20,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  sendButtonDisabled: {
    opacity: 0.4,
  },
  sendButtonLabel: {
    color: colors.ink950,
    fontFamily: fontFamily.monoSemiBold,
    fontSize: 15,
    fontWeight: "600",
  },
});
