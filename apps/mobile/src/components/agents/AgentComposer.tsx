import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ComponentRef, useRef } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { useAuth } from "../../app/auth-context";
import { describeAgentSessionError } from "../../lib/agent-session-errors";
import { useIsOnline } from "../../lib/inbox-mutations";
import { agentSessionKeys } from "../../lib/query-keys";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";
import { GhostButton } from "../GhostButton";
import { PrimaryButton } from "../PrimaryButton";

/** Il tetto del server (`sendAgentMessageInputSchema`): oltre, 400. */
const MAX_TEXT = 4000;

/**
 * Il campo per scrivere all'agente (piano C, Task 7), gemello di `Composer` in
 * `apps/web/src/components/agent-session/composer.tsx`. Chi lo monta lo fa SOLO
 * con `detail.canWrite` del server: qui non c'è nessuna regola di ruolo.
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
 * Senza rete i bottoni sono spenti e «Scrivi» dice il perché col testo che le
 * altre azioni dell'app usano già (`mobile.inbox.offlineAction`, come
 * `QuestionForm`).
 */
export function AgentComposer({
  sessionId,
  canInterrupt,
  text,
  onTextChange,
  error,
  onErrorChange,
}: {
  sessionId: string;
  canInterrupt: boolean;
  text: string;
  onTextChange: (text: string) => void;
  error: string | null;
  onErrorChange: (error: string | null) => void;
}) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const online = useIsOnline();
  const fieldRef = useRef<ComponentRef<typeof TextInput>>(null);

  const send = useMutation({
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

  const disabled = !online || text.trim().length === 0 || send.isPending;

  return (
    <View style={styles.container} testID="agent-composer">
      <TextInput
        ref={fieldRef}
        accessibilityLabel={t("mobile.agents.composer.placeholder")}
        value={text}
        onChangeText={onTextChange}
        // Durante l'invio (fino alla rilettura del dettaglio) il campo non si
        // modifica: a rilettura finita si svuota, e ciò che si scrive ora sparirebbe.
        editable={!send.isPending}
        maxLength={MAX_TEXT}
        multiline
        placeholder={t("mobile.agents.composer.placeholder")}
        placeholderTextColor={colors.faint}
        style={styles.input}
        testID="agent-composer-input"
      />
      <View style={styles.buttons}>
        <View style={styles.button}>
          <PrimaryButton
            label={online ? t("mobile.agents.composer.send") : t("mobile.inbox.offlineAction")}
            onPress={() => send.mutate(false)}
            disabled={disabled}
            pending={send.isPending && send.variables === false}
            testID="agent-composer-send"
          />
        </View>
        {canInterrupt && (
          <View style={styles.button}>
            <GhostButton
              label={t("mobile.agents.composer.interruptAndSend")}
              onPress={() => send.mutate(true)}
              disabled={disabled}
              besidePrimary
              testID="agent-composer-interrupt"
            />
          </View>
        )}
      </View>
      <Text style={styles.hint}>{t("mobile.agents.composer.hint")}</Text>
      {canInterrupt && <Text style={styles.hint}>{t("mobile.agents.composer.hintInterrupt")}</Text>}
      {error !== null && (
        <Text accessibilityLiveRegion="polite" accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
    </View>
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
  container: { gap: 8 },
  input: {
    backgroundColor: "rgba(10,13,16,0.7)",
    borderColor: colors.lineStrong,
    borderRadius: radii.control,
    borderWidth: 1,
    color: colors.fg,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.input,
    maxHeight: 140,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  buttons: { flexDirection: "row", gap: 8 },
  button: { flex: 1 },
  hint: { color: colors.faint, fontFamily: fontFamily.sans, fontSize: 12 },
  error: { color: colors.danger, fontFamily: fontFamily.mono, fontSize: 12 },
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
