import type { Reader, SearchResults } from "@stubwise/shared";
import { isUnknown, searchSnippetSegments } from "@stubwise/shared";
import { useNavigation } from "@react-navigation/native";
import type { NavigationProp } from "@react-navigation/native";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useAuth } from "../app/providers";
import type { RootStackParamList } from "../app/navigation";
import { SectionLabel } from "./SectionLabel";
import { Skeleton } from "./Skeleton";
import { searchMailTime } from "../lib/format";
import { othersThan, summarizeAddresses } from "../lib/search-recipients";
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
  // La scheda attiva (16 set 2026, richiesta del maintainer): «tutto» e poi
  // una per tipo. È un filtro sul RISULTATO, non sulla query: il server
  // cerca sempre ovunque, quindi cambiare scheda non costa una chiamata e i
  // conteggi restano veri anche mentre guardi un tipo solo.
  const [filter, setFilter] = useState<SearchFilter>("all");
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
            <>
              <SearchFilters data={results.data} filter={filter} onChange={setFilter} />
              <Groups data={results.data} filter={filter} onNavigate={go} navigation={navigation} />
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

function Groups({
  data,
  filter,
  onNavigate,
  navigation,
}: {
  data: Reader<SearchResults> | undefined;
  filter: SearchFilter;
  onNavigate: (run: () => void) => void;
  navigation: NavigationProp<RootStackParamList>;
}) {
  const { t } = useTranslation();
  // ⚠️ `?? []` anche qui, benché l'app PARSI davvero la risposta
  // (`packages/api-client` usa `readerSchema(...).parse`, quindi i
  // `.default()` girano): il costo è nullo e il giorno in cui questo
  // componente venisse riusato dietro un percorso che non parsa, la difesa
  // c'è già. La fixture dei test lo omette apposta.
  const show = (group: SearchFilter) => filter === "all" || filter === group;
  const tickets = show("tickets") ? (data?.tickets?.items ?? []) : [];
  const projects = show("projects") ? (data?.projects?.items ?? []) : [];
  const docs = show("docs") ? (data?.docs?.items ?? []) : [];
  const mail = show("mail") ? (data?.mail?.items ?? []) : [];

  if (tickets.length === 0 && projects.length === 0 && docs.length === 0 && mail.length === 0) {
    return <Text style={styles.hint}>{t("mobile.search.empty")}</Text>;
  }

  return (
    <>
      {tickets.length > 0 && (
        <View style={styles.group}>
          <SectionLabel>{t("mobile.search.groups.tickets")}</SectionLabel>
          {tickets.map((hit) => (
            <TicketRow
              key={hit.id}
              hit={hit}
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
            <ProjectRow
              key={hit.id}
              hit={hit}
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
            <DocRow
              key={`${hit.repositoryId}-${hit.slug}`}
              hit={hit}
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
            <MailRow
              key={`${hit.accountId}-${hit.threadId}`}
              hit={hit}
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

/**
 * QUATTRO RIGHE, non una (16 set 2026, design §3).
 *
 * Prima c'era un `Row` generico — titolo + sottotitolo, entrambi troncati a
 * una riga — per posta, ticket, Docs e progetti insieme. Ognuno dei quattro
 * perdeva per strada esattamente ciò che lo rende riconoscibile: la posta la
 * data, il ticket numero e stato, la pagina Docs il repository. Non è che i
 * dati mancassero: il server ne mandava già la maggior parte, e la riga li
 * scartava per mancanza di posto.
 *
 * ⚠️ Gli `testID` NON sono cambiati (`global-search-mail-<threadId>`,
 * `global-search-ticket-<id>`, …): ci sono sopra i test della navigazione, ed
 * è la parte che non deve muoversi mentre la forma cambia.
 *
 * ⚠️ Tutto ciò che viene dall'email — oggetto, mittente, destinatari, copia —
 * è testo NON FIDATO, e lo `snippet` porta i marcatori **`<b>`** di
 * `ts_headline` (non `<mark>`: era un errore del design, corretto guardando
 * cosa arriva davvero) più il markdown del corpo da cui è ritagliato.
 * `searchSnippetSegments` (`@stubwise/shared`) toglie entrambi e dice quale
 * pezzo era marcato, così si rende in grassetto invece di stamparlo com'è —
 * il difetto che il maintainer ha visto il 16 set 2026. `<Text>` di React
 * Native non interpreta markup, quindi non c'è niente da escapare e non si
 * apre nessuna strada di rendering nuova.
 */

/**
 * L'estratto, con in grassetto il pezzo che ha fatto comparire il risultato.
 *
 * Il grassetto NON è decorazione: in un elenco dice perché quella riga è lì,
 * soprattutto quando il termine cercato è sepolto nell'estratto e non sta né
 * nell'oggetto né nel titolo. La palette del web invece lo appiattisce
 * (`plainSearchSnippet`), perché lì la riga è una sola.
 */
function SnippetText({ snippet }: { snippet: string | null }) {
  if (snippet === null || snippet === "") return null;
  const segments = searchSnippetSegments(snippet);
  if (segments.length === 0) return null;
  return (
    <Text style={styles.snippet} numberOfLines={2}>
      {segments.map((segment, index) => (
        <Text key={index} style={segment.highlighted ? styles.snippetMatch : undefined}>
          {segment.text}
        </Text>
      ))}
    </Text>
  );
}

/** Il guscio comune: l'area premibile e lo snippet in fondo. Il resto lo mette ogni riga. */
function RowShell({
  onPress,
  testID,
  snippet,
  children,
}: {
  onPress: () => void;
  testID: string;
  snippet: string | null;
  children: ReactNode;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.row} testID={testID}>
      {children}
      <SnippetText snippet={snippet} />
    </Pressable>
  );
}

/**
 * POSTA: mittente e quando in cima sulla stessa riga, poi l'oggetto, poi chi
 * altro c'è, poi l'estratto.
 */
function MailRow({
  hit,
  onPress,
}: {
  hit: Reader<SearchResults>["mail"]["items"][number];
  onPress: () => void;
}) {
  const { t } = useTranslation();
  // ⚠️ La casella di chi cerca esce dagli elenchi: «a: a.locatelli» quando
  // a.locatelli è chi sta cercando non è informazione. Se non resta nessuno,
  // la riga dei destinatari non compare affatto — mai un «a: —».
  const to = summarizeAddresses(othersThan(hit.to ?? [], hit.accountEmail));
  const cc = summarizeAddresses(othersThan(hit.cc ?? [], hit.accountEmail));

  return (
    <RowShell onPress={onPress} testID={`global-search-mail-${hit.threadId}`} snippet={hit.snippet}>
      <View style={styles.mailTop}>
        <Text style={styles.mailFrom} numberOfLines={1}>
          {hit.from}
        </Text>
        <Text style={styles.mailWhen}>{searchMailTime(hit.receivedAt)}</Text>
      </View>
      <Text style={styles.rowTitle} numberOfLines={1}>
        {hit.subject ?? t("mobile.mbx.noSubject")}
      </Text>
      {(to !== null || cc !== null) && (
        <Text style={styles.rowSubtitle} numberOfLines={1} testID={`global-search-mail-people-${hit.threadId}`}>
          {[to === null ? null : `${t("mobile.search.to")} ${to}`, cc === null ? null : `${t("mobile.search.cc")} ${cc}`]
            .filter((part): part is string => part !== null)
            .join("  ")}
        </Text>
      )}
    </RowShell>
  );
}

/** TICKET: numero e stato in cima, il titolo sotto. */
function TicketRow({
  hit,
  onPress,
}: {
  hit: Reader<SearchResults>["tickets"]["items"][number];
  onPress: () => void;
}) {
  const { t } = useTranslation();
  // `Reader` apre gli enum: uno stato che questa build non conosce arriva
  // come segnaposto, e si dice «sconosciuto» invece di stampare il valore
  // grezzo o di far saltare la `t()`.
  const status = isUnknown(hit.status) ? "unknown" : hit.status;

  return (
    <RowShell onPress={onPress} testID={`global-search-ticket-${hit.id}`} snippet={hit.snippet}>
      <View style={styles.mailTop}>
        <Text style={styles.ticketNumber}>#{hit.number}</Text>
        <Text style={styles.ticketMeta} numberOfLines={1}>
          {t(`mobile.search.ticketStatus.${status}`)} · {hit.projectName}
        </Text>
      </View>
      <Text style={styles.rowTitle} numberOfLines={2}>
        {hit.title}
      </Text>
    </RowShell>
  );
}

/** DOCS: titolo, poi da dove viene (repository e tipo di pagina). */
function DocRow({
  hit,
  onPress,
}: {
  hit: Reader<SearchResults>["docs"]["items"][number];
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const kind = isUnknown(hit.kind) ? "unknown" : hit.kind;

  return (
    <RowShell onPress={onPress} testID={`global-search-doc-${hit.slug}`} snippet={hit.snippet}>
      <Text style={styles.rowTitle} numberOfLines={2}>
        {hit.title}
      </Text>
      <Text style={styles.rowSubtitle} numberOfLines={1}>
        {hit.repositoryName} · {t(`mobile.search.docKinds.${kind}`)}
      </Text>
    </RowShell>
  );
}

/**
 * PROGETTI: restano com'erano — nome e descrizione sono tutto ciò che un
 * progetto ha, e la riga generica già li mostrava bene. Cambia solo che
 * smettono di condividere il componente con gli altri tre, così una modifica
 * a una delle altre righe non li tocca più.
 */
function ProjectRow({
  hit,
  onPress,
}: {
  hit: Reader<SearchResults>["projects"]["items"][number];
  onPress: () => void;
}) {
  return (
    <RowShell onPress={onPress} testID={`global-search-project-${hit.id}`} snippet={null}>
      <Text style={styles.rowTitle} numberOfLines={1}>
        {hit.name}
      </Text>
      <Text style={styles.rowSubtitle} numberOfLines={2}>
        {hit.snippet ?? hit.slug}
      </Text>
    </RowShell>
  );
}

const styles = StyleSheet.create({
  filterRow: {
    flexDirection: "row",
    gap: 8,
    paddingBottom: 14,
  },
  filterChip: {
    borderColor: colors.lineStrong,
    borderRadius: radii.control,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  filterChipActive: {
    borderColor: colors.signalDim,
  },
  filterLabel: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 12,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  filterLabelActive: {
    color: colors.signal,
  },
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
  snippet: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 5,
  },
  /**
   * Il pezzo che ha combaciato. Peso E colore: l'estratto è `colors.muted`, e
   * su un fondo scuro il solo grassetto si distingue poco — portare la parola
   * trovata al colore del testo pieno la stacca senza aggiungere un accento
   * che competerebbe con `colors.signal`, che in questa app vuol dire «serve
   * una tua decisione».
   */
  snippetMatch: {
    color: colors.fg,
    fontFamily: fontFamily.sansSemiBold,
    fontWeight: "600",
  },
  mailTop: {
    alignItems: "baseline",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
  },
  mailFrom: {
    color: colors.muted,
    flexShrink: 1,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  mailWhen: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  ticketNumber: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  ticketMeta: {
    color: colors.faint,
    flexShrink: 1,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
});

/**
 * Le schede della ricerca: «tutto» e una per tipo (16 set 2026, richiesta del
 * maintainer).
 *
 * ⚠️ Scorrono in ORIZZONTALE e non si stringono per stare in una riga: sono
 * cinque, e cinque etichette compresse su un telefono diventano illeggibili
 * prima che una in più le rompa. È lo stesso gesto dei chip del backlog —
 * quella forma esiste già in quest'app e regge una voce nuova senza
 * ridisegnare niente.
 *
 * ⚠️ Una scheda VUOTA non si mostra (richiesta del maintainer, poche ore dopo
 * la prima stesura). Avevo argomentato il contrario — «nasconderla farebbe
 * ballare la riga a ogni carattere digitato» — e l'argomento era sbagliato:
 * i conteggi cambiano solo quando la ricerca si ASSESTA (la query è
 * `debounced`), non a ogni tasto, quindi la riga si ridisegna poche volte per
 * ricerca. Restava vero solo il fastidio opposto: «Ticket · 0» è rumore.
 *
 * Il caso vero da gestire è un altro, ed è gestito qui sotto: se la scheda
 * ATTIVA si svuota mentre scrivi, sparirebbe sotto il dito lasciando un
 * filtro applicato e nessuna scheda accesa. Si ricade su «tutto».
 */
const SEARCH_FILTERS: SearchFilter[] = ["all", "mail", "tickets", "docs", "projects"];

export type SearchFilter = "all" | "mail" | "tickets" | "docs" | "projects";

function SearchFilters({
  data,
  filter,
  onChange,
}: {
  data: Reader<SearchResults> | undefined;
  filter: SearchFilter;
  onChange: (filter: SearchFilter) => void;
}) {
  const { t } = useTranslation();
  const counts: Record<SearchFilter, number> = {
    mail: data?.mail?.items.length ?? 0,
    tickets: data?.tickets?.items.length ?? 0,
    docs: data?.docs?.items.length ?? 0,
    projects: data?.projects?.items.length ?? 0,
    all: 0,
  };
  counts.all = counts.mail + counts.tickets + counts.docs + counts.projects;

  const visible = SEARCH_FILTERS.filter((option) => option === "all" || counts[option] > 0);

  // La scheda attiva si è svuotata mentre si scriveva: si torna su «tutto»,
  // altrimenti resterebbe un filtro applicato senza nessuna scheda accesa —
  // uno schermo vuoto senza un modo ovvio di uscirne.
  useEffect(() => {
    if (!visible.includes(filter)) onChange("all");
  }, [visible, filter, onChange]);

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.filterRow}
      keyboardShouldPersistTaps="handled"
      testID="global-search-filters"
    >
      {visible.map((option) => {
        const active = option === filter;
        return (
          <Pressable
            key={option}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(option)}
            style={[styles.filterChip, active && styles.filterChipActive]}
            testID={`global-search-filter-${option}`}
          >
            <Text style={[styles.filterLabel, active && styles.filterLabelActive]}>
              {t(`mobile.search.filters.${option}`, { count: counts[option] })}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
