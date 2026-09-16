import type { Reader, SearchResults } from "@stubwise/shared";
import { useNavigation } from "@react-navigation/native";
import type { NavigationProp } from "@react-navigation/native";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useAuth } from "../app/providers";
import type { RootStackParamList } from "../app/navigation";
import { SectionLabel } from "./SectionLabel";
import { Skeleton } from "./Skeleton";
import { colors, radii } from "../theme/tokens";
import { fontFamily, fontSize } from "../theme/typography";

/**
 * LA RICERCA GLOBALE dell'app (15 set 2026, design §3, Task 10).
 *
 * ⚠️ **È un'AZIONE, non un posto.** Le cinque destinazioni
 * (INB/PRJ/BLG/DOC/MBX) sono decise per tutte le fasi
 * (`docs/plans/2026-09-11-app-navigation-architecture-design.md`): la ricerca
 * non ne aggiunge una sesta. Vive nell'intestazione di schermata — quella che
 * già porta titolo e avatar — ed è quindi raggiungibile da ovunque quella
 * intestazione esista, senza rubare uno slot alla tab bar.
 *
 * ## Quali gruppi, e perché NON tutti quelli del web
 *
 * Ticket, progetti, documentazione e posta. **I repository no**: l'app non ha
 * una schermata dei repository, quindi un risultato lì sarebbe una riga che
 * non porta da nessuna parte — e «premibile solo se c'è davvero un dettaglio
 * da aprire» è la regola che questa app segue già altrove (vedi `EventRow` in
 * `CalendarPanel`). Mostrare un risultato inerte è peggio che non mostrarlo:
 * chi lo tocca pensa che l'app sia rotta.
 *
 * ## La posta
 *
 * Porta alla CONVERSAZIONE (`ThreadDetail`), non al messaggio, e passa
 * `highlightMessageId` per segnare quello che ha combaciato. Il server la
 * filtra sul proprietario della casella: non c'è niente da filtrare qui, e
 * non va aggiunto — la privacy della posta non è una scelta del client.
 */

/** Debounce dell'input: lo stesso di `DocsScreen`, per coerenza di percezione. */
const SEARCH_DEBOUNCE_MS = 250;

export function GlobalSearchSheet({
  visible,
  onRequestClose,
}: {
  visible: boolean;
  onRequestClose: () => void;
}) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();

  const [raw, setRaw] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(raw), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [raw]);

  // Chiudendo il foglio si riparte puliti: riaprirlo sui risultati di una
  // ricerca di dieci minuti fa sarebbe una schermata che mente su cosa si
  // stava cercando.
  useEffect(() => {
    if (!visible) {
      setRaw("");
      setDebounced("");
    }
  }, [visible]);

  const query = debounced.trim();
  const results = useQuery({
    queryKey: ["search", "global", query],
    queryFn: () => {
      if (!client) throw new Error("GlobalSearchSheet richiede un client autenticato");
      return client.search.global(query);
    },
    enabled: visible && client !== null && query.length > 0,
    staleTime: 10_000,
  });

  function go(run: () => void): void {
    onRequestClose();
    run();
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onRequestClose} testID="global-search-sheet">
      <View style={styles.screen}>
        <View style={styles.header}>
          <Text style={styles.title}>{t("mobile.search.title")}</Text>
          <Pressable accessibilityRole="button" onPress={onRequestClose} testID="global-search-close">
            <Text style={styles.close}>{t("mobile.search.close")}</Text>
          </Pressable>
        </View>

        <TextInput
          accessibilityLabel={t("mobile.search.placeholder")}
          autoFocus
          value={raw}
          onChangeText={setRaw}
          placeholder={t("mobile.search.placeholder")}
          placeholderTextColor={colors.faint}
          style={styles.input}
          testID="global-search-input"
        />

        <ScrollView contentContainerStyle={styles.results} keyboardShouldPersistTaps="handled">
          {query.length === 0 ? (
            <Text style={styles.hint}>{t("mobile.search.hint")}</Text>
          ) : results.isPending ? (
            <View style={styles.skeletons} testID="global-search-skeleton">
              <Skeleton height={56} />
              <Skeleton height={56} />
            </View>
          ) : results.isError ? (
            <Text style={styles.hint}>{t("mobile.search.error")}</Text>
          ) : (
            <Groups data={results.data} onNavigate={go} navigation={navigation} />
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

function Groups({
  data,
  onNavigate,
  navigation,
}: {
  data: Reader<SearchResults> | undefined;
  onNavigate: (run: () => void) => void;
  navigation: NavigationProp<RootStackParamList>;
}) {
  const { t } = useTranslation();
  // ⚠️ `?? []` anche qui, benché l'app PARSI davvero la risposta
  // (`packages/api-client` usa `readerSchema(...).parse`, quindi i
  // `.default()` girano): il costo è nullo e il giorno in cui questo
  // componente venisse riusato dietro un percorso che non parsa, la difesa
  // c'è già. La fixture dei test lo omette apposta.
  const tickets = data?.tickets?.items ?? [];
  const projects = data?.projects?.items ?? [];
  const docs = data?.docs?.items ?? [];
  const mail = data?.mail?.items ?? [];

  if (tickets.length === 0 && projects.length === 0 && docs.length === 0 && mail.length === 0) {
    return <Text style={styles.hint}>{t("mobile.search.empty")}</Text>;
  }

  return (
    <>
      {tickets.length > 0 && (
        <View style={styles.group}>
          <SectionLabel>{t("mobile.search.groups.tickets")}</SectionLabel>
          {tickets.map((hit) => (
            <Row
              key={hit.id}
              testID={`global-search-ticket-${hit.id}`}
              title={`#${hit.number} ${hit.title}`}
              subtitle={hit.projectName}
              onPress={() =>
                onNavigate(() =>
                  navigation.navigate("Main", {
                    screen: "Projects",
                    params: { screen: "Ticket", params: { id: hit.id } },
                  }),
                )
              }
            />
          ))}
        </View>
      )}

      {projects.length > 0 && (
        <View style={styles.group}>
          <SectionLabel>{t("mobile.search.groups.projects")}</SectionLabel>
          {projects.map((hit) => (
            <Row
              key={hit.id}
              testID={`global-search-project-${hit.id}`}
              title={hit.name}
              subtitle={hit.slug}
              onPress={() =>
                onNavigate(() =>
                  navigation.navigate("Main", {
                    screen: "Projects",
                    params: { screen: "Detail", params: { id: hit.id } },
                  }),
                )
              }
            />
          ))}
        </View>
      )}

      {docs.length > 0 && (
        <View style={styles.group}>
          <SectionLabel>{t("mobile.search.groups.docs")}</SectionLabel>
          {docs.map((hit) => (
            <Row
              key={`${hit.repositoryId}-${hit.slug}`}
              testID={`global-search-doc-${hit.slug}`}
              title={hit.title}
              subtitle={hit.repositoryName}
              onPress={() =>
                onNavigate(() =>
                  navigation.navigate("Main", {
                    screen: "Docs",
                    params: {
                      screen: "Page",
                      params: { repositoryId: hit.repositoryId, slug: hit.slug },
                    },
                  }),
                )
              }
            />
          ))}
        </View>
      )}

      {mail.length > 0 && (
        <View style={styles.group}>
          <SectionLabel>{t("mobile.search.groups.mail")}</SectionLabel>
          {mail.map((hit) => (
            <Row
              key={`${hit.accountId}-${hit.threadId}`}
              testID={`global-search-mail-${hit.threadId}`}
              // NON FIDATO: l'oggetto lo scrive chi manda l'email. `<Text>`
              // di React Native non interpreta markup, quindi non c'è niente
              // da escapare — ma resta testo di un estraneo.
              title={hit.subject ?? hit.from}
              subtitle={`${hit.from} · ${hit.accountEmail}`}
              onPress={() =>
                onNavigate(() =>
                  navigation.navigate("Main", {
                    screen: "Mbx",
                    params: {
                      screen: "ThreadDetail",
                      params: { threadId: hit.threadId, highlightMessageId: hit.matchedMessageId },
                    },
                  }),
                )
              }
            />
          ))}
        </View>
      )}
    </>
  );
}

function Row({
  title,
  subtitle,
  onPress,
  testID,
}: {
  title: string;
  subtitle: string | null;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.row} testID={testID}>
      <Text style={styles.rowTitle} numberOfLines={1}>
        {title}
      </Text>
      {subtitle !== null && (
        <Text style={styles.rowSubtitle} numberOfLines={1}>
          {subtitle}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: colors.ink950,
    flex: 1,
    paddingTop: 56,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 20,
  },
  title: {
    color: colors.fg,
    fontFamily: fontFamily.sansBold,
    fontSize: 20,
    fontWeight: "700",
  },
  close: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 12,
  },
  input: {
    backgroundColor: colors.ink900,
    borderColor: colors.lineStrong,
    borderRadius: radii.control,
    borderWidth: 1,
    color: colors.fg,
    fontFamily: fontFamily.sans,
    fontSize: 15,
    marginHorizontal: 20,
    marginTop: 14,
    minHeight: 44,
    paddingHorizontal: 12,
  },
  results: {
    paddingBottom: 40,
    paddingHorizontal: 20,
    paddingTop: 18,
  },
  skeletons: {
    gap: 10,
  },
  hint: {
    color: colors.faint,
    fontFamily: fontFamily.sans,
    fontSize: 14,
    lineHeight: 20,
  },
  group: {
    marginBottom: 22,
  },
  row: {
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
    justifyContent: "center",
    minHeight: 56,
    paddingVertical: 8,
  },
  rowTitle: {
    color: colors.fg,
    fontFamily: fontFamily.sans,
    fontSize: 15,
  },
  rowSubtitle: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    marginTop: 3,
  },
});
