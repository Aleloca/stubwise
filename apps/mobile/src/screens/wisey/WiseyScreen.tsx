import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LayoutAnimation, Pressable, ScrollView, type ScrollViewInstance, StyleSheet, Text, TextInput, View } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import { ScreenHeader } from "../../components/ScreenHeader";
import { TabScreenKeyboardAvoider } from "../../components/TabScreenKeyboardAvoider";
import { WiseySprite } from "../../components/wisey/WiseySprite";
import { mockReply } from "../../lib/wisey-mock";
import { WISEY_STAGE_MS, WISEY_WORD_MS, wiseyPhase, type WiseyStage } from "../../lib/wisey-phase";
import { colors, radii } from "../../theme/tokens";
import { fontFamily } from "../../theme/typography";

/** Lo stesso margine del campo delle altre chat (`AskProjectScreen`, `BacklogChatScreen`). */
const COMPOSER_BASE_BOTTOM_PADDING = 12;

const SUGGESTION_KEYS = [
  "mobile.wisey.suggestions.waiting",
  "mobile.wisey.suggestions.backlog",
  "mobile.wisey.suggestions.status",
] as const;

interface Message {
  role: "user" | "wisey";
  text: string;
}

/**
 * WISEY («Wisey, anteprima nell'app», 25 set 2026, design §4-§6): l'agente
 * con cui si parlerà a tutta l'istanza. Questa è l'ANTEPRIMA — il posto
 * nell'app, la faccia e le animazioni, con risposte finte (`lib/wisey-mock`)
 * che dicono cosa Wisey FARÀ e dove si fa oggi. Nessuna chiamata al server.
 *
 * Dall'alto: intestazione con «Preview»; il gufo, grande e centrato finché la
 * conversazione è vuota, piccolo in testa quando comincia (una transizione,
 * non uno scatto: `LayoutAnimation`), con sotto la riga di stato; i messaggi;
 * il campo in fondo, sopra la tastiera.
 *
 * ⚠️ La FASE del gufo non si sceglie qui: la decide `wiseyPhase` dallo stato
 * (lo `stage` della risposta, il fuoco e il testo del campo). Questa
 * schermata fa avanzare lo stage a tempo; quando Wisey parlerà con un job
 * vero, cambierà chi lo fa avanzare, non le regole.
 *
 * ⚠️ UN solo gufo animato: quello in testa. I gufi accanto alle risposte
 * restano fermi al primo fotogramma (regola del design).
 *
 * La conversazione vive nello stato del componente: le schede restano
 * montate, quindi sopravvive al cambio di tab e sparisce alla chiusura
 * dell'app.
 */
export function WiseyScreen() {
  const { t } = useTranslation();
  const tabBarHeight = useBottomTabBarHeight();
  const [messages, setMessages] = useState<Message[]>([]);
  const [stage, setStage] = useState<WiseyStage>("idle");
  const [draft, setDraft] = useState("");
  const [inputFocused, setInputFocused] = useState(false);
  const [shownWords, setShownWords] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const scroll = useRef<ScrollViewInstance>(null);

  // Nessun timer sopravvive alla schermata.
  useEffect(
    () => () => {
      for (const timer of timers.current) clearTimeout(timer);
    },
    [],
  );

  function later(ms: number, run: () => void) {
    timers.current.push(setTimeout(run, ms));
  }

  const busy = stage !== "idle";
  const canSend = draft.trim().length > 0 && !busy;
  const phase = wiseyPhase({ stage, inputFocused, hasText: draft.length > 0 });

  function answer(text: string) {
    const words = text.split(" ");
    setMessages((current) => [...current, { role: "wisey", text }]);
    setShownWords(1);
    setStage("answering");
    // A scatti, a tempo col becco: una parola per fotogramma di «ti risponde».
    for (let index = 2; index <= words.length; index += 1) {
      later(WISEY_WORD_MS * (index - 1), () => setShownWords(index));
    }
    later(WISEY_WORD_MS * words.length, () => {
      setStage("done");
      // «Fatto» fa un giro solo, poi il gufo torna a riposo.
      later(WISEY_STAGE_MS.done, () => setStage("idle"));
    });
  }

  function send(question: string) {
    const text = question.trim();
    if (text.length === 0 || busy) return;
    if (messages.length === 0) LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setMessages((current) => [...current, { role: "user", text }]);
    setDraft("");
    setStage("thinking");
    const reply = mockReply(text);
    const replyText = t(reply.textKey);
    later(WISEY_STAGE_MS.thinking, () => {
      if (reply.kind === "action") {
        setStage("working");
        later(WISEY_STAGE_MS.working, () => answer(replyText));
      } else {
        answer(replyText);
      }
    });
  }

  const started = messages.length > 0;
  const lastIndex = messages.length - 1;

  return (
    <TabScreenKeyboardAvoider style={styles.container}>
      <ScreenHeader title={t("mobile.wisey.title")} badge={t("mobile.wisey.badge")} />

      <ScrollView
        ref={scroll}
        style={styles.messages}
        contentContainerStyle={styles.messagesContent}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
      >
        <View style={[styles.owl, started && styles.owlCompact]}>
          <WiseySprite phase={phase} size={started ? "small" : "large"} />
          <Text style={styles.status} testID="wisey-status">
            {t(`mobile.wisey.status.${phase}`)}
          </Text>
        </View>

        {!started && (
          <View style={styles.welcome} testID="wisey-welcome">
            <Text style={styles.welcomeText}>{t("mobile.wisey.welcome")}</Text>
            <View style={styles.suggestions}>
              {SUGGESTION_KEYS.map((key) => (
                <Pressable
                  key={key}
                  accessibilityRole="button"
                  onPress={() => send(t(key))}
                  style={styles.suggestion}
                  testID={`wisey-suggestion-${key.split(".").pop()}`}
                >
                  <Text style={styles.suggestionText}>{t(key)}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        {messages.map((message, index) => {
          const text =
            message.role === "wisey" && index === lastIndex && stage === "answering"
              ? message.text.split(" ").slice(0, shownWords).join(" ")
              : message.text;
          return message.role === "user" ? (
            <View key={index} style={[styles.bubble, styles.bubbleUser]} testID={`wisey-message-user-${index}`}>
              <Text style={styles.bubbleText} testID={`wisey-message-text-${index}`}>
                {text}
              </Text>
            </View>
          ) : (
            <View key={index} style={[styles.bubble, styles.bubbleWisey]} testID={`wisey-message-wisey-${index}`}>
              <WiseySprite phase="rest" size="small" animated={false} />
              <View style={styles.bubbleBody}>
                <Text style={styles.bubbleLabel}>{t("mobile.wisey.title")}</Text>
                <Text style={styles.bubbleText} testID={`wisey-message-text-${index}`}>
                  {text}
                </Text>
              </View>
            </View>
          );
        })}
      </ScrollView>

      <View style={[styles.composerRow, { paddingBottom: COMPOSER_BASE_BOTTOM_PADDING + tabBarHeight }]}>
        <View style={styles.composer}>
          <TextInput
            accessibilityLabel={t("mobile.wisey.placeholder")}
            value={draft}
            onChangeText={setDraft}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            onSubmitEditing={() => send(draft)}
            placeholder={t("mobile.wisey.placeholder")}
            placeholderTextColor={colors.faint}
            returnKeyType="send"
            style={styles.input}
            testID="wisey-input"
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("mobile.wisey.send")}
            accessibilityState={{ disabled: !canSend }}
            disabled={!canSend}
            onPress={() => send(draft)}
            style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
            testID="wisey-send"
          >
            <Text style={styles.sendButtonLabel}>↑</Text>
          </Pressable>
        </View>
      </View>
    </TabScreenKeyboardAvoider>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  messages: {
    flex: 1,
  },
  messagesContent: {
    gap: 10,
    padding: 16,
    paddingBottom: 24,
  },
  owl: {
    alignItems: "center",
    gap: 10,
    paddingVertical: 24,
  },
  owlCompact: {
    flexDirection: "row",
    gap: 12,
    paddingVertical: 4,
  },
  // Riga di stato: mono, maiuscolo, ambra — come le etichette delle fasi nel design (5a).
  status: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 1.1,
    textTransform: "uppercase",
  },
  welcome: {
    gap: 14,
  },
  welcomeText: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  suggestions: {
    gap: 8,
  },
  suggestion: {
    borderColor: colors.lineStrong,
    borderRadius: radii.control,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  suggestionText: {
    color: colors.fg,
    fontFamily: fontFamily.sans,
    fontSize: 14,
  },
  // Bolle dal design (5b): bordo `line`, fondo `ink900`, raggio 10, testo 13.
  bubble: {
    borderRadius: 10,
    borderWidth: 1,
    maxWidth: "88%",
    padding: 14,
  },
  bubbleUser: {
    alignSelf: "flex-end",
    backgroundColor: "rgba(245,166,35,0.08)",
    borderColor: colors.signalDim,
  },
  bubbleWisey: {
    alignItems: "flex-start",
    alignSelf: "flex-start",
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    flexDirection: "row",
    gap: 12,
  },
  bubbleBody: {
    flexShrink: 1,
  },
  bubbleLabel: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  bubbleText: {
    color: colors.fg,
    fontFamily: fontFamily.sans,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 4,
  },
  composerRow: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  // Il campo del design (5b): pillola, bordo `lineStrong`, fondo semitrasparente.
  composer: {
    alignItems: "center",
    backgroundColor: "rgba(10,13,16,0.7)",
    borderColor: colors.lineStrong,
    borderRadius: 26,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  input: {
    color: colors.fg,
    flex: 1,
    fontFamily: fontFamily.sans,
    fontSize: 13,
    paddingVertical: 6,
  },
  sendButton: {
    alignItems: "center",
    backgroundColor: colors.signal,
    borderRadius: 14,
    height: 28,
    justifyContent: "center",
    width: 28,
  },
  sendButtonDisabled: {
    opacity: 0.35,
  },
  sendButtonLabel: {
    color: colors.ink950,
    fontFamily: fontFamily.mono,
    fontSize: 12,
    fontWeight: "600",
  },
});
