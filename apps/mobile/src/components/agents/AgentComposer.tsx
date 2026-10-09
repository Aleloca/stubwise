import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ComponentRef, type RefObject, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useAuth } from "../../app/auth-context";
import { describeAgentSessionError } from "../../lib/agent-session-errors";
import { useIsOnline } from "../../lib/inbox-mutations";
import { agentSessionKeys } from "../../lib/query-keys";
import { colors, pillRadius, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";
import { Glass } from "../Glass";

/** Il tetto del server (`sendAgentMessageInputSchema`): oltre, 400. */
const MAX_TEXT = 4000;

/** Interlinea del campo: il tetto d'altezza è cinque di queste, poi il campo scorre. */
const LINE_HEIGHT = 20;
const MAX_LINES = 5;
/** Il padding verticale VERO del campo (sopra e sotto): entra nel tetto d'altezza. */
const FIELD_PADDING_V = 8;
/** I bottoni tondi: un tocco comodo (44 pt è il minimo HIG). */
const ROUND = 36;

export type AgentComposerField = ComponentRef<typeof TextInput>;

/**
 * Il campo per scrivere all'agente (piano C, Task 7), gemello di `Composer` in
 * `apps/web/src/components/agent-session/composer.tsx`. Chi lo monta lo fa con
 * `detail.canWrite` del server, o con `detail.canIntervene` fra un segmento e
 * l'altro: qui non c'è nessuna regola di ruolo.
 *
 * `enabled` (= `canWrite`) falso lo mette in sola lettura SENZA smontarlo, e
 * SENZA spegnere `editable`: su iOS (UITextView non modificabile) e su Android
 * (`setEnabled(false)`) quello toglie il focus e chiude la tastiera, che è
 * esattamente ciò che il campo montato vuole evitare. Il campo ignora quindi
 * le modifiche (`onChangeText` non le inoltra: il valore controllato resta) e
 * i bottoni sono spenti.
 *
 * «Scrivi» manda `interrupt: false`; «Ferma e scrivi» (solo con `canInterrupt`)
 * `interrupt: true`, sempre con un testo non vuoto. Dopo il 202 si rilegge il
 * dettaglio e SOLO a rilettura finita il campo si svuota (e torna il focus):
 * la bolla compare da `detail.inputs` come «in consegna» e passa a
 * consegnata/non consegnata coi frame `session` dello stream — nessuna bolla
 * ottimistica, il messaggio non è mai «da nessuna parte».
 *
 * Testo ed errore sono del GENITORE (`text`/`error`): un 409
 * `session_ended`/`not_interactive` rilegge il dettaglio, il server lo riporta
 * con `canWrite: false` e questo campo si smonta. Se lo stato stesse qui,
 * quello che si è scritto e il perché non è partito sparirebbero con lui; la
 * schermata li mostra anche dopo ({@link UnsentMessage}).
 *
 * Senza rete i bottoni sono spenti e una riga piccola SOPRA il campo dice il
 * perché, col testo che le altre azioni dell'app usano già
 * (`mobile.inbox.offlineAction`, come `QuestionForm`).
 *
 * Forma (9 ott 2026, Task A2): un contenitore arrotondato in fondo, il campo
 * che cresce fino a ~5 righe e poi scorre, a destra il bottone TONDO «Invia»
 * (freccia su, accent solo con del testo) e — con `canInterrupt` E del testo —
 * il bottone tondo «Ferma e scrivi» (quadrato). Nessun suggerimento lungo sotto
 * il campo: il perché del campo spento sta nel SEGNAPOSTO (e nell'`accessibilityHint`),
 * l'errore o l'assenza di rete in UNA riga sopra il campo, solo quando servono.
 * `fieldRef` (facoltativo) è del genitore: «Rimanda» ci rimette il testo e il focus.
 *
 * Fondo di vetro (Task A3): il contenitore è un {@link Glass}, perché il campo
 * sta SOPRA la trascrizione e la lascia scorrere dietro di sé.
 */
export function AgentComposer({
  sessionId,
  canInterrupt,
  enabled = true,
  readOnlyNote,
  text,
  onTextChange,
  error,
  onErrorChange,
  fieldRef: externalFieldRef,
}: {
  sessionId: string;
  canInterrupt: boolean;
  /** `canWrite` del server: falso = campo in sola lettura, non smontato. */
  enabled?: boolean;
  /**
   * Perché il campo è in sola lettura (solo con `enabled` falso): diventa il
   * segnaposto del campo e il suo `accessibilityHint`. Con `editable` acceso
   * il lettore di schermo non saprebbe che il campo è spento: lo dicono
   * `accessibilityState.disabled` e questo suggerimento (gemello del web).
   */
  readOnlyNote?: string;
  text: string;
  onTextChange: (text: string) => void;
  error: string | null;
  onErrorChange: (error: string | null) => void;
  /** Il campo, per chi deve rimetterci il focus da fuori («Rimanda»). */
  fieldRef?: RefObject<AgentComposerField | null>;
}) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const online = useIsOnline();
  const ownFieldRef = useRef<AgentComposerField>(null);
  const fieldRef = externalFieldRef ?? ownFieldRef;

  const send = useMutation({
    // Sotto il prefisso delle sessioni: il testo scritto non va su AsyncStorage (`shouldPersistMutation`).
    mutationKey: agentSessionKeys.send(sessionId),
    mutationFn: (interrupt: boolean) => {
      if (!client) return Promise.reject(new Error("AgentComposer richiede un client autenticato"));
      return client.agentSessions.send(sessionId, { text: text.trim(), interrupt });
    },
    onMutate: () => onErrorChange(null),
    // La promessa tiene `isPending` acceso finché il dettaglio riletto (con la
    // bolla «in consegna») non è arrivato: niente doppio invio in quella finestra.
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: agentSessionKeys.detail(sessionId) });
      onTextChange("");
      fieldRef.current?.focus();
    },
    onError: (cause) => {
      onErrorChange(describeAgentSessionError(cause, t));
      // Un 409 dice che la sessione è cambiata (finita, passo diverso): il
      // dettaglio riletto toglie il campo se non si può più scrivere.
      void queryClient.invalidateQueries({ queryKey: agentSessionKeys.detail(sessionId) });
    },
  });

  const note = enabled ? undefined : readOnlyNote;
  const hasText = text.trim().length > 0;
  const disabled = !enabled || !online || !hasText || send.isPending;
  const sending = send.isPending && send.variables === false;
  const interrupting = send.isPending && send.variables === true;
  // Durante il proprio invio il bottone resta, anche se il testo è già sparito dal conto.
  const showInterrupt = canInterrupt && (hasText || interrupting);
  // UNA riga sopra il campo, solo quando serve: l'errore vince sull'assenza di rete.
  const line = error ?? (enabled && !online ? t("mobile.inbox.offlineAction") : null);

  return (
    <View style={styles.container} testID="agent-composer">
      {line !== null && (
        <Text
          accessibilityLiveRegion="polite"
          accessibilityRole={error !== null ? "alert" : undefined}
          style={error !== null ? styles.error : styles.note}
        >
          {line}
        </Text>
      )}
      <Glass style={styles.box} testID="agent-composer-box">
        <TextInput
          ref={fieldRef}
          accessibilityLabel={t("mobile.agents.composer.placeholder")}
          accessibilityState={{ disabled: !enabled }}
          accessibilityHint={note}
          value={text}
          onChangeText={(next) => {
            if (enabled) onTextChange(next);
          }}
          // Durante l'invio (fino alla rilettura del dettaglio) il campo non si
          // modifica: a rilettura finita si svuota, e ciò che si scrive ora sparirebbe.
          editable={!send.isPending}
          maxLength={MAX_TEXT}
          multiline
          scrollEnabled
          placeholder={note ?? t("mobile.agents.composer.placeholder")}
          placeholderTextColor={colors.faint}
          style={styles.input}
          testID="agent-composer-input"
        />
        {showInterrupt && (
          <RoundButton
            label={
              interrupting ? t("mobile.agents.composer.interrupting") : t("mobile.agents.composer.interruptAndSend")
            }
            onPress={() => send.mutate(true)}
            disabled={disabled}
            pending={interrupting}
            tone="ghost"
            testID="agent-composer-interrupt"
          >
            <View style={[styles.stopSquare, disabled && styles.stopOff]} />
          </RoundButton>
        )}
        <RoundButton
          label={t("mobile.agents.composer.send")}
          onPress={() => send.mutate(false)}
          disabled={disabled}
          pending={sending}
          tone={hasText && enabled && online ? "accent" : "off"}
          testID="agent-composer-send"
        >
          <Text style={[styles.arrow, disabled && styles.arrowOff]}>↑</Text>
        </RoundButton>
      </Glass>
    </View>
  );
}

/** Un bottone tondo del composer: il glifo dentro, il nome accessibile fuori, la rotellina mentre invia. */
function RoundButton({
  label,
  onPress,
  disabled,
  pending,
  tone,
  testID,
  children,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  pending: boolean;
  tone: "accent" | "off" | "ghost";
  testID: string;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy: pending }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [
        styles.round,
        tone === "accent" && styles.roundAccent,
        tone === "ghost" && styles.roundGhost,
        pressed && !disabled && (tone === "accent" ? styles.roundAccentPressed : styles.roundPressed),
      ]}
      testID={testID}
    >
      {pending ? (
        <ActivityIndicator
          size="small"
          color={tone === "accent" ? colors.ink950 : colors.muted}
          testID={`${testID}-spinner`}
        />
      ) : (
        children
      )}
    </Pressable>
  );
}

/**
 * Un messaggio che non è partito, mostrato quando il campo non c'è più (il
 * server ha tolto `canWrite` dopo il 409): il motivo e il testo, selezionabile,
 * così non si perde quello che si era scritto.
 */
export function UnsentMessage({ text, error }: { text: string; error: string }) {
  const { t } = useTranslation();
  return (
    <View accessibilityRole="alert" style={styles.unsent} testID="agent-composer-unsent">
      <Text style={styles.error}>{t("mobile.agents.composer.notSent", { reason: error })}</Text>
      <Text selectable style={styles.unsentText}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 6 },
  // Il fondo (vetro su iOS, ink900 all'~85% su Android) e il bordo li dà `Glass`.
  box: {
    alignItems: "flex-end",
    borderRadius: pillRadius,
    flexDirection: "row",
    gap: 6,
    minHeight: 44,
    paddingLeft: 14,
    paddingRight: 4,
    paddingVertical: 3,
  },
  input: {
    color: colors.fg,
    flex: 1,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.input,
    lineHeight: LINE_HEIGHT,
    // Cinque righe, poi scorre (con `scrollEnabled`).
    maxHeight: MAX_LINES * LINE_HEIGHT + 2 * FIELD_PADDING_V,
    minHeight: 36,
    paddingBottom: FIELD_PADDING_V,
    paddingTop: FIELD_PADDING_V,
    textAlignVertical: "top",
  },
  round: {
    alignItems: "center",
    backgroundColor: colors.ink800,
    borderRadius: ROUND / 2,
    height: ROUND,
    justifyContent: "center",
    width: ROUND,
  },
  roundAccent: { backgroundColor: colors.signal },
  roundAccentPressed: { backgroundColor: colors.signalDim },
  roundGhost: { backgroundColor: "transparent", borderColor: colors.lineStrong, borderWidth: 1 },
  roundPressed: { backgroundColor: colors.ink850 },
  arrow: { color: colors.ink950, fontFamily: fontFamily.sans, fontSize: 18, fontWeight: "700", lineHeight: 20 },
  stopSquare: { backgroundColor: colors.fg, borderRadius: 2, height: 12, width: 12 },
  arrowOff: { color: colors.faint },
  stopOff: { backgroundColor: colors.faint },
  note: { color: colors.faint, fontFamily: fontFamily.mono, fontSize: 12, paddingHorizontal: 4 },
  error: { color: colors.danger, fontFamily: fontFamily.mono, fontSize: 12, paddingHorizontal: 4 },
  unsent: {
    borderColor: colors.danger,
    borderRadius: radii.control,
    borderWidth: 1,
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  unsentText: { color: colors.fg, fontFamily: fontFamily.sans, fontSize: fontSize.body },
});
