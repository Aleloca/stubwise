import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, type ScrollViewInstance, StyleSheet, Text, TextInput, View } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import { ScreenHeader } from "../../components/ScreenHeader";
import { TabScreenKeyboardAvoider } from "../../components/TabScreenKeyboardAvoider";
import { useWisey } from "../../components/wisey/WiseyProvider";
import { WiseySprite } from "../../components/wisey/WiseySprite";
import { useScreenFocused } from "../../lib/use-screen-focused";
import { colors, radii } from "../../theme/tokens";
import { fontFamily } from "../../theme/typography";

/** Lo stesso margine del campo delle altre chat (`AskProjectScreen`, `BacklogChatScreen`). */
const COMPOSER_BASE_BOTTOM_PADDING = 12;

const SUGGESTION_KEYS = [
  "mobile.wisey.suggestions.waiting",
  "mobile.wisey.suggestions.backlog",
  "mobile.wisey.suggestions.status",
] as const;

/**
 * WISEY («Wisey, anteprima nell'app», 25 set 2026, design §4-§6): l'agente
 * con cui si parlerà a tutta l'istanza. Questa è l'ANTEPRIMA — il posto
 * nell'app, la faccia e le animazioni, con risposte finte (`lib/wisey-mock`)
 * che dicono cosa Wisey FARÀ e dove si fa oggi. Nessuna chiamata al server.
 *
 * Dall'alto: intestazione con «Preview»; il gufo grande (2×) FISSO in testa
 * per tutta la conversazione, con sotto la riga di stato; i messaggi, che
 * sono la sola cosa che scorre; il campo in fondo, sopra la tastiera.
 *
 * ⚠️ Il gufo NON si rimpicciolisce più alla prima domanda, e non sta dentro
 * lo scorrimento (design §10, dopo la prova sul telefono): era così nella
 * prima versione, e il maintainer l'ha cambiato.
 *
 * ⚠️ Lo STATO non vive qui: sta in `WiseyProvider`, sopra il navigator, che
 * lo condivide con l'icona della barra e fa avanzare la risposta anche fuori
 * dalla tab (design §10). Questa schermata lo legge, e gli dice quando la tab
 * è a fuoco — è ciò che decide se un «fatto» è stato visto.
 *
 * ⚠️ UN solo gufo nella pagina: le risposte di Wisey si riconoscono dalla
 * bolla e da un'etichetta mono «WISEY», non da un gufo accanto (§10).
 *
 * La conversazione sopravvive al cambio di tab e sparisce alla chiusura
 * dell'app (o al logout, che smonta il provider).
 */
export function WiseyScreen() {
  const { t } = useTranslation();
  const tabBarHeight = useBottomTabBarHeight();
  const wisey = useWisey();
  const { messages, phase, draft, canSend, setDraft, setInputFocused, send, setTabFocused } = wisey;
  const focused = useScreenFocused();
  const scroll = useRef<ScrollViewInstance>(null);

  // La tab a fuoco è ciò che rende «visto» un «fatto» arrivato mentre si era
  // altrove: lo store lo deve sapere.
  useEffect(() => {
    setTabFocused(focused);
  }, [focused, setTabFocused]);

  const started = messages.length > 0;

  return (
    <TabScreenKeyboardAvoider style={styles.container}>
      <ScreenHeader title={t("mobile.wisey.title")} badge={t("mobile.wisey.badge")} />

      <View style={styles.owl}>
        <WiseySprite phase={phase} size="large" />
        <Text style={styles.status} testID="wisey-status">
          {t(`mobile.wisey.status.${phase}`)}
        </Text>
      </View>

      <ScrollView
        ref={scroll}
        testID="wisey-messages"
        style={styles.messages}
        contentContainerStyle={styles.messagesContent}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
      >
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
          const text = wisey.visibleText(index);
          return message.role === "user" ? (
            <View key={index} style={[styles.bubble, styles.bubbleUser]} testID={`wisey-message-user-${index}`}>
              <Text style={styles.bubbleText} testID={`wisey-message-text-${index}`}>
                {text}
              </Text>
            </View>
          ) : (
            <View key={index} style={[styles.bubble, styles.bubbleWisey]} testID={`wisey-message-wisey-${index}`}>
              <Text style={styles.bubbleLabel} testID={`wisey-message-label-${index}`}>
                {t("mobile.wisey.title")}
              </Text>
              <Text style={styles.bubbleText} testID={`wisey-message-text-${index}`}>
                {text}
              </Text>
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
    gap: 8,
    paddingBottom: 8,
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
    alignSelf: "flex-start",
    backgroundColor: colors.ink900,
    borderColor: colors.line,
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
