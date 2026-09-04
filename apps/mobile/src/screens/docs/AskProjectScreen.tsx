import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { DocsChatSource, Reader } from "@stubwise/shared";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { DocsStackParamList } from "../../app/navigation";
import { PulseIndicator } from "../../components/PulseIndicator";
import { useAskProjectChat } from "../../lib/docs-mutations";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

interface ChatBubble {
  id: string;
  role: "user" | "assistant";
  text: string;
  sources: Reader<DocsChatSource>[];
}

/**
 * «Chiedi al progetto» (canvas `3f`): chat RAG CROSS-REPO di progetto
 * (`client.docs.projectChat`, `?stream=false` — fase 4 mobile), non la chat
 * per-repository (`client.docs.chat`, che vuole un `repositoryId` e non è
 * quella che questo screen usa). CORREZIONE al testo del piano (righe
 * 765-777): descrive un «picker progetto/repo», ma la rotta server
 * (`POST /api/projects/:projectId/docs/chat`, `apps/server/src/routes/
 * project-docs.ts`) prende SOLO `projectId` — il retrieval è cross-repo
 * (`retrieveChunksForProject`), nessun repository da scegliere qui. Il
 * progetto arriva già scelto da `DocsScreen` (route param `projectId` +
 * `projectName`, per la testata): niente picker proprio su questo screen,
 * stessa scelta di `BacklogChatScreen` (riceve `id` dai `route.params`,
 * nessun secondo selettore).
 *
 * MULTI-TURNO: a differenza di `useSendBacklogChatMessage` (backlog:
 * `sessionId` = l'id della voce, il client non lo tocca mai) qui il server
 * apre una VERA sessione (`doc_chat_sessions`, project-level) e la restituisce
 * in `sessionId` — lo screen la tiene in stato locale e la ripassa al turno
 * successivo, così i messaggi restano nella stessa conversazione invece di
 * aprirne una nuova a ogni invio. Nessuna cronologia precedente viene
 * ricaricata all'apertura (a differenza di `BacklogChatScreen`, che semina da
 * `itemQuery.data.messages`): ogni visita parte da una conversazione vuota —
 * scelta deliberata per restare nello scope di questo task (nessun mockup
 * mostra un "riprendi conversazione precedente").
 */
export function AskProjectScreen({ navigation, route }: NativeStackScreenProps<DocsStackParamList, "Ask">) {
  const { t } = useTranslation();
  const { projectId, projectName } = route.params;

  const send = useAskProjectChat();
  const [bubbles, setBubbles] = useState<ChatBubble[]>([]);
  const [draft, setDraft] = useState("");
  const sessionId = useRef<string | undefined>(undefined);
  const bubbleId = useRef(0);

  function nextLocalId(): string {
    bubbleId.current += 1;
    return `local-${bubbleId.current}`;
  }

  function handleSend(): void {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || send.disabled) return;
    setBubbles((current) => [...current, { id: nextLocalId(), role: "user", text: trimmed, sources: [] }]);
    setDraft("");
    send.mutate(
      { projectId, message: trimmed, sessionId: sessionId.current },
      {
        onSuccess: (result) => {
          sessionId.current = result.sessionId;
          setBubbles((current) => [
            ...current,
            { id: nextLocalId(), role: "assistant", text: result.answer, sources: result.sources },
          ]);
        },
      },
    );
  }

  const canSend = draft.trim().length > 0 && !send.disabled;

  return (
    <View style={styles.container}>
      <Pressable onPress={() => navigation.goBack()} testID="ask-project-back" style={styles.backRow}>
        <Text style={styles.back}>{t("mobile.docs.ask.back")}</Text>
      </Pressable>

      <Text style={styles.title} numberOfLines={2}>
        {t("mobile.docs.ask.sectionLabel")}
      </Text>
      <Text style={styles.subtitle}>{projectName}</Text>

      <ScrollView style={styles.messages} contentContainerStyle={styles.messagesContent}>
        {bubbles.length === 0 && !send.isPending && <Text style={styles.emptyHint}>{t("mobile.docs.ask.empty")}</Text>}
        {bubbles.map((bubble) => (
          <View
            key={bubble.id}
            style={[styles.bubble, bubble.role === "user" ? styles.bubbleUser : styles.bubbleAgent]}
            testID={`ask-project-bubble-${bubble.id}`}
          >
            <Text style={styles.bubbleText}>{bubble.text}</Text>
            {bubble.sources.length > 0 && (
              <View style={styles.sourcesRow}>
                <Text style={styles.sourcesLabel}>{t("mobile.docs.ask.sourcesLabel")}</Text>
                {bubble.sources.map((source, index) => (
                  <View key={`${source.repositoryId}-${source.slug}`} style={styles.sourceItem}>
                    <Pressable
                      onPress={() => navigation.navigate("Page", { repositoryId: source.repositoryId, slug: source.slug })}
                      testID={`ask-project-source-${source.repositoryId}-${source.slug}`}
                    >
                      <Text style={styles.sourceLink}>{source.title}</Text>
                    </Pressable>
                    {index < bubble.sources.length - 1 && <Text style={styles.sourceSeparator}> · </Text>}
                  </View>
                ))}
              </View>
            )}
          </View>
        ))}
        {send.isPending && (
          <View style={styles.thinkingRow} testID="ask-project-thinking">
            <PulseIndicator tone="sky" text={t("mobile.docs.ask.thinking")} />
          </View>
        )}
      </ScrollView>

      {send.errorMessage !== null && (
        <Text accessibilityLiveRegion="polite" style={styles.errorText} testID="ask-project-send-error">
          {send.errorMessage}
        </Text>
      )}

      <View style={styles.composer}>
        <TextInput
          accessibilityLabel={t("mobile.docs.ask.placeholder")}
          value={draft}
          onChangeText={setDraft}
          editable={!send.disabled}
          placeholder={t("mobile.docs.ask.placeholder")}
          placeholderTextColor={colors.faint}
          style={styles.input}
          testID="ask-project-input"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("mobile.docs.ask.send")}
          accessibilityState={{ disabled: !canSend }}
          disabled={!canSend}
          onPress={handleSend}
          style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
          testID="ask-project-send"
        >
          <Text style={styles.sendButtonLabel}>↑</Text>
        </Pressable>
      </View>
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
  title: {
    color: colors.fg,
    fontSize: 20,
    fontWeight: "700",
    lineHeight: 25,
    marginTop: 8,
    paddingHorizontal: 20,
  },
  subtitle: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    marginTop: 4,
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
  emptyHint: {
    color: colors.faint,
    fontSize: 13,
    lineHeight: 19,
    paddingHorizontal: 4,
  },
  bubble: {
    borderRadius: radii.card,
    borderWidth: 1,
    maxWidth: "88%",
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
  bubbleText: {
    color: colors.fg,
    fontSize: 14,
    lineHeight: 20,
  },
  sourcesRow: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: 8,
  },
  sourcesLabel: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    marginRight: 4,
  },
  sourceItem: {
    alignItems: "center",
    flexDirection: "row",
  },
  sourceLink: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: 11,
  },
  sourceSeparator: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 11,
  },
  thinkingRow: {
    paddingHorizontal: 4,
  },
  errorText: {
    color: colors.danger,
    fontSize: 13,
    marginHorizontal: 16,
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
