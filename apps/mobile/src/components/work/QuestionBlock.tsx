import type { Reader, TicketQuestion } from "@stubwise/shared";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import { QuestionForm } from "../inbox/QuestionForm";
import { useAnswerQuestion } from "../../lib/work-mutations";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

export interface QuestionBlockProps {
  ticketId: string;
  /** La domanda APERTA del job corrente. */
  question: Reader<TicketQuestion>;
  /**
   * Chi guarda può rispondere: un maintainer, o chi ha chiesto il run. È la
   * stessa regola di `actorAllows` lato server, dove resta l'AUTORITÀ — qui si
   * decide solo cosa mostrare, e se le due divergessero sarebbe l'errore del
   * server ad avere ragione.
   */
  canAnswer: boolean;
}

/**
 * La domanda aperta dell'agente, con le sue opzioni, dentro la schermata
 * Lavoro.
 *
 * ⚠️ **Prima di questo blocco una domanda aperta non si vedeva affatto
 * nell'app.** Le domande erano già caricate, ma `buildTimeline` legge solo
 * quelle RISPOSTE (`answeredAt !== null`) e le usa per datare un passo: di una
 * domanda ancora in attesa non restava traccia in nessun punto della
 * schermata. Un job fermo qui restava fermo finché qualcuno non apriva il web,
 * o finché la notifica era ancora in inbox.
 *
 * Sta appena sotto lo stato e sopra il piano — il posto dove la domanda SI
 * VEDE — e non dietro un menu: chi la legge deve poter rispondere lì.
 *
 * `QuestionForm` è lo stesso componente della card d'inbox e della chat del
 * backlog: le invarianti che contano (bail-out totale sulle opzioni senza
 * etichetta, consigliata mai preselezionata, indici mai compattati) sono lì,
 * una volta sola, e non vanno riscritte qui.
 */
export function QuestionBlock({ ticketId, question, canAnswer }: QuestionBlockProps) {
  const { t } = useTranslation();
  const answer = useAnswerQuestion(ticketId);

  return (
    <View style={styles.card} testID="work-question">
      <Text style={styles.eyebrow}>{t("mobile.work.question.title")}</Text>
      {canAnswer ? (
        <QuestionForm
          question={question}
          onSubmit={(body) => answer.mutate({ questionId: question.questionId, answer: body })}
          pending={answer.isPending}
          disabled={answer.disabled}
          online={answer.online}
          errorMessage={answer.errorMessage}
          testIDPrefix="work-question"
        />
      ) : (
        <>
          <Text style={styles.question} testID="work-question-text">
            {question.question}
          </Text>
          <Text style={styles.readOnly} testID="work-question-read-only">
            {t("mobile.work.question.readOnly")}
          </Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.ink900,
    borderColor: colors.signalDim,
    borderRadius: radii.card,
    borderWidth: 1,
    gap: 8,
    padding: 14,
  },
  eyebrow: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  question: {
    color: colors.fg,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.body,
    lineHeight: 20,
  },
  readOnly: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
});
