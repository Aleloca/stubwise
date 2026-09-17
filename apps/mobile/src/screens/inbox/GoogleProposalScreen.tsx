import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { InboxItem, Reader } from "@stubwise/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import type { InboxStackParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
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
 */
export function GoogleProposalScreen({
  route,
  navigation,
}: NativeStackScreenProps<InboxStackParamList, "Proposal">) {
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

      {options.length > 0 || fallback.length > 0 ? (
        <>
          <SectionLabel style={styles.sectionLabel}>{t("mobile.inbox.google.whatToDo")}</SectionLabel>
          <View style={styles.card}>
            {(options.length > 0 ? options : fallback).map((choice, index) => (
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
            ))}
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
  rowLabel: { color: colors.fg, fontFamily: fontFamily.sans, fontSize: 15 },
  rowConsequence: { color: colors.faint, fontFamily: fontFamily.sans, fontSize: 12 },
  chevron: { color: colors.faint, fontFamily: fontFamily.sans, fontSize: 20 },
  note: { color: colors.muted, fontFamily: fontFamily.sans, fontSize: 13, marginTop: 12 },
  error: { color: colors.danger, fontFamily: fontFamily.sans, fontSize: 13, marginTop: 10 },
  doneWrap: { alignItems: "center", marginTop: 28 },
});
