import { useNavigation, type NavigationProp } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { InboxItem, Reader } from "@stubwise/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import type { ProposalParamList, RootStackParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
import { PrimaryButton } from "../../components/PrimaryButton";
import { ScreenHeader } from "../../components/ScreenHeader";
import { SectionLabel } from "../../components/SectionLabel";
import { Skeleton } from "../../components/Skeleton";
import { relativeTimeCompact } from "../../lib/format";
import { inboxKeys, useAnswer } from "../../lib/inbox-mutations";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

/** Vedi `InboxScreen.tsx` per il perché di una costante invece di leggere lo stile. */
const CONTENT_BASE_BOTTOM_PADDING = 40;

/**
 * LA PAGINA DOVE SI DECIDE su una proposta nata dalla posta o dal calendario
 * (16 set 2026).
 *
 * Scelta del maintainer: la decisione non si prende da un bottone in mezzo a
 * un elenco. Confermare qui crea roba vera — una milestone, una voce di
 * backlog, un commento su un ticket — e chi decide deve prima vedere da chi
 * arriva, cosa dice e cosa comporta ogni scelta.
 *
 * ⚠️ **Le scelte arrivano dal server come SOLO TIPO**, senza il loro payload
 * (quale progetto, quale ticket, che testo): è deliberato, ed è scritto nel
 * docblock di `inboxGoogleActionSchema` in `@stubwise/shared`. Mandarlo al
 * client vorrebbe dire che una superficie potrebbe rimandarlo modificato, e a
 * quel punto la conferma non sarebbe più «esegui la proposta che hai letto»
 * ma «esegui quello che il client dice». Quello che viaggia verso il server è
 * l'INDICE scelto, esattamente come per la domanda dell'agente.
 *
 * Ne discende cosa questa pagina può e non può promettere: ogni riga dice che
 * TIPO di cosa succederà («crea una milestone»), mai il dettaglio di cosa
 * verrà creato. Il dettaglio vive nel testo della proposta, sopra.
 *
 * ⚠️ **Registrata in DUE stack** dal 22 set 2026 (INB e Projects): ci si
 * arriva dall'inbox generale e dall'inbox di un progetto, e da entrambe
 * l'indietro deve tornare dove si era. Per questo è tipata su
 * `ProposalParamList` e non su uno stack intero — non sa, e non deve sapere,
 * in quale sta girando.
 *
 * ⚠️ **Il salto a MBX di «apri la mail d'origine» resta, ed è un'altra cosa**:
 * quello che il 22 settembre si è chiuso è l'INGRESSO in questa pagina, non le
 * sue destinazioni interne. La conversazione vive in MBX, ha già la sua
 * schermata, e mandarci chi legge è deliberato — non una svista sfuggita a
 * quel giro.
 */
export function GoogleProposalScreen({
  route,
  navigation,
}: NativeStackScreenProps<ProposalParamList, "Proposal">) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const tabBarHeight = useBottomTabBarHeight();
  const { id } = route.params;
  const answer = useAnswer();

  // Dalla LISTA, come fa `InboxCardScreen`: non esiste una rotta per id, e
  // inventarne una qui vorrebbe dire una superficie server nuova per leggere
  // qualcosa che è già in cache.
  const query = useQuery({
    queryKey: inboxKeys.list(),
    queryFn: () => {
      if (!client) throw new Error("GoogleProposalScreen richiede un client autenticato");
      return client.inbox.list();
    },
    enabled: client !== null,
    staleTime: 10_000,
  });
  const item = query.data?.items.find((row) => row.id === id);

  return (
    <View style={styles.container} testID="google-proposal-screen">
      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: CONTENT_BASE_BOTTOM_PADDING + tabBarHeight }]}
        stickyHeaderIndices={[0]}
      >
        <ScreenHeader
          title={item?.google?.subject ?? t("mobile.inbox.google.fallbackTitle")}
          onBack={() => navigation.goBack()}
          backLabel={t("mobile.inbox.google.back")}
          titleNumberOfLines={3}
        />

        {query.isPending ? (
          <View style={styles.skeletonList} testID="google-proposal-skeleton">
            <Skeleton height={18} width="60%" />
            <Skeleton height={80} />
            <Skeleton height={120} />
          </View>
        ) : query.isError ? (
          <View style={styles.centered} testID="google-proposal-error">
            <Text style={styles.errorTitle}>{t("mobile.inbox.google.loadError")}</Text>
            <GhostButton
              label={t("mobile.inbox.loadError.retry")}
              onPress={() => void query.refetch()}
              testID="google-proposal-retry"
            />
          </View>
        ) : item === undefined ? (
          // Sparita dalla lista mentre la si guardava: qualcuno l'ha decisa
          // altrove. Non un errore — una cosa che è successa.
          <View style={styles.centered} testID="google-proposal-gone">
            <Text style={styles.errorTitle}>{t("mobile.inbox.google.gone")}</Text>
            <GhostButton
              label={t("mobile.inbox.google.backToInbox")}
              onPress={() => navigation.goBack()}
              testID="google-proposal-gone-back"
            />
          </View>
        ) : (
          <ProposalBody item={item} answer={answer} onDone={() => navigation.goBack()} />
        )}
      </ScrollView>
    </View>
  );
}

function ProposalBody({
  item,
  answer,
  onDone,
}: {
  item: Reader<InboxItem>;
  answer: ReturnType<typeof useAnswer>;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const google = item.google;
  // «Sposta su un altro progetto» (17 set 2026): l'UNICA scelta di questa
  // pagina che ha bisogno di un dato in più — quale progetto — e quindi
  // l'unica che non esegue al tocco. Il tocco APRE l'elenco; è il tocco su un
  // progetto a confermare. Nessuno stato nuovo nell'enum che l'app legge:
  // quando la conferma parte, la card sparisce come per ogni altra azione.
  const reassignIndex =
    google?.actions.findIndex((action) => action.type === "reassign_project") ?? -1;
  const [pickingProject, setPickingProject] = useState(false);
  // Stessa chiave e stesso `staleTime` di `InboxCardScreen`: una richiesta
  // sola. `enabled` la tiene spenta finché questa proposta non offre davvero
  // la riattribuzione.
  const projectsQuery = useQuery({
    queryKey: ["projects", "list"],
    queryFn: () => {
      if (!client) throw new Error("GoogleProposalScreen richiede un client autenticato");
      return client.projects.list();
    },
    enabled: client !== null && reassignIndex >= 0,
    staleTime: 60_000,
  });
  // Il progetto CORRENTE è escluso: spostarla dov'è già non è una scelta, e
  // il server la rifiuterebbe.
  const reassignTargets = (projectsQuery.data ?? []).filter(
    (project) => project.id !== item.projectId,
  );
  const relative = relativeTimeCompact(item.createdAt);
  const when =
    relative.kind === "now"
      ? t("mobile.inbox.time.now")
      : t(`mobile.inbox.time.${relative.kind}`, { count: relative.count });

  // Una proposta già decisa (da qui, da un'altra superficie o da un collega)
  // non offre più scelte: il server toglie le azioni, e mostrare bottoni che
  // daranno «proposta non più disponibile» sarebbe peggio di non mostrarli.
  // Le OPZIONI, non i tipi d'azione: la proposta porta un blocco `question`
  // con etichetta e CONSEGUENZA di ciascuna scelta («Aggiungi al backlog» →
  // «Nuova voce su Portale B2B»), ed è quello che serve a chi decide. Sui
  // dati veri del maintainer ce l'hanno tutte e 33 le proposte aperte; il
  // ripiego sui tipi copre una riga scritta da un server più vecchio, e dice
  // comunque che COSA succederà, solo senza il dettaglio.
  const options = item.question?.options ?? [];
  const fallback = google?.actions ?? [];
  const choices = options.length > 0 ? options : fallback;

  // PIÙ AZIONI INSIEME (26 set 2026, design §5): le azioni del modello che si
  // sommano diventano caselle, tutte spuntate, con un bottone «Crea N»; le
  // altre righe («Sposta», «Non fare nulla») agiscono al tocco come prima.
  // Quali si sommano lo dice il SERVER (`multiSelectIndices`, derivato a
  // lettura): l'app non ricalcola la regola, perché una sua copia starebbe
  // dalla parte che non possiamo aggiornare. Un indice fuori dalle scelte
  // mostrate non diventa una casella.
  const multiIndices = (google?.multiSelectIndices ?? []).filter(
    (index) => Number.isInteger(index) && index >= 0 && index < choices.length,
  );
  const multiSet = new Set(multiIndices);
  const [checked, setChecked] = useState<ReadonlySet<number>>(() => new Set(multiIndices));
  const checkedIndices = multiIndices.filter((index) => checked.has(index));
  const toggle = (index: number) =>
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  return (
    <>
      {google !== undefined && (
        <View style={styles.context}>
          <Text style={styles.from}>
            {t("mobile.inbox.google.fromLine", { from: google.from, when })}
          </Text>
          <Text style={styles.signal}>
            {t(`mobile.inbox.google.source.${google.source}`)} ·{" "}
            {t(`mobile.inbox.google.signal.${google.signal}`)}
          </Text>
        </View>
      )}

      <Text style={styles.text}>{item.text}</Text>

      {/*
        LA FONTE: il testo che la CLASSIFICAZIONE ha letto, sopra le scelte —
        perché è ciò che permette di dire «sì, l'ha capita» o «no, ha
        frainteso» prima di decidere, non dopo.
      */}
      <ProposalSource sourceProposalId={google?.sourceProposalId ?? null} />

      {choices.length > 0 ? (
        <>
          {multiIndices.length > 0 && (
            <>
              <SectionLabel style={styles.sectionLabel}>{t("mobile.inbox.google.multiTitle")}</SectionLabel>
              <View style={styles.card}>
                {multiIndices.map((index, position) => {
                  const choice = choices[index]!;
                  const isChecked = checked.has(index);
                  return (
                    <Pressable
                      key={index}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: isChecked, disabled: answer.disabled }}
                      disabled={answer.disabled}
                      onPress={() => toggle(index)}
                      style={[styles.row, position > 0 && styles.rowDivided, answer.disabled && styles.rowDisabled]}
                      testID={`google-multi-${index}`}
                    >
                      <View style={[styles.checkbox, isChecked && styles.checkboxOn]}>
                        {isChecked && <Text style={styles.checkmark}>✓</Text>}
                      </View>
                      <View style={styles.rowText}>
                        <Text style={styles.rowLabel}>
                          {"label" in choice ? choice.label : t(`mobile.inbox.google.actions.${choice.type}`)}
                        </Text>
                        {"consequence" in choice && choice.consequence !== null && (
                          <Text style={styles.rowConsequence}>{choice.consequence}</Text>
                        )}
                      </View>
                    </Pressable>
                  );
                })}
              </View>
              <View style={styles.doneWrap}>
                <PrimaryButton
                  label={t("mobile.inbox.google.createN", { count: checkedIndices.length })}
                  disabled={answer.disabled || checkedIndices.length === 0}
                  onPress={() => {
                    if (checkedIndices.length > 0) {
                      answer.mutate({ id: item.id, body: { optionIndices: checkedIndices } });
                    }
                  }}
                  testID="google-multi-submit"
                />
              </View>
            </>
          )}
          <SectionLabel style={styles.sectionLabel}>{t("mobile.inbox.google.whatToDo")}</SectionLabel>
          <View style={styles.card}>
            {choices.map((choice, index) =>
              // Le caselle stanno sopra: qui restano le altre, con l'INDICE
              // ORIGINALE — è quello che viaggia fino al server.
              multiSet.has(index) ? null : (
              <Pressable
                key={index}
                accessibilityRole="button"
                disabled={answer.disabled}
                onPress={() =>
                  index === reassignIndex
                    ? setPickingProject(true)
                    : answer.mutate({ id: item.id, body: { optionIndex: index } })
                }
                style={[styles.row, index > 0 && styles.rowDivided, answer.disabled && styles.rowDisabled]}
                testID={`google-action-${index}`}
              >
                <View style={styles.rowText}>
                  <Text style={styles.rowLabel}>
                    {"label" in choice ? choice.label : t(`mobile.inbox.google.actions.${choice.type}`)}
                  </Text>
                  {"consequence" in choice && choice.consequence !== null && (
                    <Text style={styles.rowConsequence}>{choice.consequence}</Text>
                  )}
                </View>
                <Text style={styles.chevron}>›</Text>
              </Pressable>
              ),
            )}
          </View>
          {pickingProject && reassignIndex >= 0 && (
            <>
              <SectionLabel style={styles.sectionLabel}>
                {t("mobile.inbox.google.reassignTitle")}
              </SectionLabel>
              {reassignTargets.length === 0 ? (
                <Text style={styles.note} testID="google-reassign-empty">
                  {t("mobile.inbox.google.reassignEmpty")}
                </Text>
              ) : (
                <View style={styles.card}>
                  {reassignTargets.map((project, index) => (
                    <Pressable
                      key={project.id}
                      accessibilityRole="button"
                      disabled={answer.disabled}
                      onPress={() =>
                        answer.mutate({
                          id: item.id,
                          body: { optionIndex: reassignIndex, projectId: project.id },
                        })
                      }
                      style={[
                        styles.row,
                        index > 0 && styles.rowDivided,
                        answer.disabled && styles.rowDisabled,
                      ]}
                      testID={`google-reassign-project-${project.id}`}
                    >
                      <View style={styles.rowText}>
                        <Text style={styles.rowLabel}>{project.name}</Text>
                      </View>
                      <Text style={styles.chevron}>›</Text>
                    </Pressable>
                  ))}
                </View>
              )}
              <View style={styles.doneWrap}>
                <GhostButton
                  label={t("mobile.inbox.google.reassignCancel")}
                  onPress={() => setPickingProject(false)}
                  testID="google-reassign-cancel"
                />
              </View>
            </>
          )}
          {!answer.online && <Text style={styles.note}>{t("mobile.inbox.offlineAction")}</Text>}
        </>
      ) : (
        <Text style={styles.note} testID="google-proposal-decided">
          {t("mobile.inbox.google.alreadyDecided")}
        </Text>
      )}

      {answer.errorMessage !== null && (
        <Text accessibilityLiveRegion="polite" style={styles.error} testID="google-proposal-answer-error">
          {answer.errorMessage}
        </Text>
      )}

      <View style={styles.doneWrap}>
        <GhostButton label={t("mobile.inbox.google.backToInbox")} onPress={onDone} testID="google-proposal-done" />
      </View>
    </>
  );
}

/**
 * «Cosa ha letto Stubwise»: l'ESTRATTO passato alla classificazione, non
 * l'email come si vede in Gmail (design §2).
 *
 * La distinzione è il valore di questo blocco, non un dettaglio: l'estratto è
 * troncato, e di un thread la classificazione guarda l'ultimo messaggio
 * ammesso. Quando i suggerimenti sembrano fuori bersaglio, è spesso la fonte a
 * spiegarlo — il modello ha letto meno di quanto c'è. Mostrare l'email intera
 * nasconderebbe proprio questo; per il resto c'è «apri la conversazione».
 *
 * ⚠️ **Il degrado non tocca mai le scelte.** Id assente (calendario,
 * smistamento, card che il server non sa risolvere), rotta che fallisce,
 * estratto vuoto: il blocco non compare e basta. Non sapere cosa ha letto il
 * modello è un peccato; non poter decidere è un guasto — e questo componente
 * sta in un ramo suo apposta, così un suo errore non può portarsi via i
 * bottoni.
 *
 * ⚠️ Il testo è **NON FIDATO** (lo scrive chi manda l'email): esce da un
 * `<Text>`, mai da niente che interpreti markup.
 */
function ProposalSource({ sourceProposalId }: { sourceProposalId: string | null }) {
  const { t } = useTranslation();
  const { client } = useAuth();
  // Tipata sul ROOT: da qui si esce dallo stack Inbox per andare su MBX,
  // stessa forma di `GlobalSearchSheet`.
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const [expanded, setExpanded] = useState(false);

  const query = useQuery({
    queryKey: ["mail", "detail", "email", sourceProposalId],
    queryFn: () => {
      if (!client) throw new Error("ProposalSource richiede un client autenticato");
      // `source: "email"` vuole `email_proposals.id` — che è esattamente ciò
      // che il server deriva a lettura in `sourceProposalId`.
      return client.mail.get("email", sourceProposalId!);
    },
    // Chiesto SOLO qui, quando la schermata è aperta: una lista d'inbox con 30
    // card non deve trasportare 30 estratti per mostrarne uno.
    //
    // ⚠️ **Qui è immediato, sul WEB si chiede al click, e la differenza è
    // deliberata** — chi guarda i due componenti affiancati vede
    // un'incoerenza, e non lo è. Dipende dalla forma delle due superfici: qui
    // il dettaglio è una SCHERMATA, una proposta alla volta, quindi la
    // richiesta è una; sul web la card d'inbox è già espansa DENTRO l'elenco,
    // quindi un caricamento automatico ne farebbe una per ogni proposta
    // visibile. Uniformarle peggiorerebbe una delle due: il ragionamento per
    // esteso sta nel docblock di `ProposalSource` in
    // `apps/web/src/components/inbox-item.tsx`.
    enabled: client !== null && sourceProposalId !== null,
    staleTime: 60_000,
  });

  if (sourceProposalId === null) return null;

  if (query.isPending) {
    return (
      <>
        <SectionLabel style={styles.sectionLabel}>
          {t("mobile.inbox.google.sourceTitle")}
        </SectionLabel>
        {/* Uno scheletro, non un salto della pagina. */}
        <Skeleton height={64} />
      </>
    );
  }

  const excerpt = query.data?.textExcerpt ?? null;
  if (query.isError || excerpt === null || excerpt.trim() === "") return null;

  return (
    <>
      <SectionLabel style={styles.sectionLabel}>
        {t("mobile.inbox.google.sourceTitle")}
      </SectionLabel>
      <View style={styles.sourceCard}>
        <Text
          style={styles.sourceText}
          {...(expanded ? {} : { numberOfLines: 6 })}
          testID="google-proposal-source-text"
        >
          {excerpt}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => setExpanded((open) => !open)}
          testID="google-proposal-source-toggle"
        >
          <Text style={styles.sourceLink}>
            {t(expanded ? "mobile.inbox.google.sourceLess" : "mobile.inbox.google.sourceMore")}
          </Text>
        </Pressable>
      </View>
      {/*
        Il resto della conversazione ha già la sua schermata: non si duplica
        qui la lettura completa, si passa la mano a MBX.
      */}
      <Pressable
        accessibilityRole="button"
        onPress={() =>
          navigation.navigate("Main", {
            screen: "Mbx",
            params: { screen: "MailDetail", params: { source: "email", id: sourceProposalId } },
          })
        }
        testID="google-proposal-source-open"
      >
        <Text style={styles.sourceLink}>{t("mobile.inbox.google.sourceOpen")}</Text>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: colors.ink950, flex: 1 },
  body: { paddingHorizontal: 20 },
  skeletonList: { gap: 10, marginTop: 12 },
  centered: { alignItems: "center", gap: 12, paddingVertical: 48 },
  errorTitle: { color: colors.fg, fontFamily: fontFamily.sansSemiBold, fontSize: 16, fontWeight: "600" },
  context: { gap: 2, marginTop: 4 },
  from: { color: colors.muted, fontFamily: fontFamily.sans, fontSize: 14 },
  signal: { color: colors.faint, fontFamily: fontFamily.mono, fontSize: fontSize.label },
  text: { color: colors.fg, fontFamily: fontFamily.sans, fontSize: 15, lineHeight: 22, marginTop: 14 },
  sectionLabel: { marginBottom: 8, marginTop: 24 },
  card: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.control,
    borderWidth: 1,
    overflow: "hidden",
  },
  row: { alignItems: "center", flexDirection: "row", gap: 10, paddingHorizontal: 14, paddingVertical: 15 },
  rowDivided: { borderTopColor: colors.line, borderTopWidth: 1 },
  rowDisabled: { opacity: 0.5 },
  rowText: { flex: 1, gap: 2 },
  // Casella delle azioni sommabili: stessa lingua del resto (bordo, ambra
  // quando è spuntata), niente componente di libreria.
  checkbox: {
    alignItems: "center",
    borderColor: colors.lineStrong,
    borderRadius: radii.control,
    borderWidth: 1,
    height: 22,
    justifyContent: "center",
    width: 22,
  },
  checkboxOn: { backgroundColor: colors.signal, borderColor: colors.signal },
  checkmark: { color: colors.ink950, fontFamily: fontFamily.mono, fontSize: 13 },
  rowLabel: { color: colors.fg, fontFamily: fontFamily.sans, fontSize: 15 },
  rowConsequence: { color: colors.faint, fontFamily: fontFamily.sans, fontSize: 12 },
  chevron: { color: colors.faint, fontFamily: fontFamily.sans, fontSize: 20 },
  note: { color: colors.muted, fontFamily: fontFamily.sans, fontSize: 13, marginTop: 12 },
  sourceCard: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.control,
    borderWidth: 1,
    gap: 8,
    padding: 14,
  },
  sourceText: { color: colors.muted, fontFamily: fontFamily.sans, fontSize: 14, lineHeight: 21 },
  sourceLink: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    marginTop: 10,
  },
  error: { color: colors.danger, fontFamily: fontFamily.sans, fontSize: 13, marginTop: 10 },
  doneWrap: { alignItems: "center", marginTop: 28 },
});
