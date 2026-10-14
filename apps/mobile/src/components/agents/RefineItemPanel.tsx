import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../app/providers";
import { backlogDocumentBody, backlogMetaParts } from "../../lib/backlog-mutations";
import { backlogKeys } from "../../lib/query-keys";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";
import { SafeMarkdown } from "../SafeMarkdown";

/** Quanto è alta, al massimo, una sezione aperta: la chat sotto deve restare. */
const SECTION_MAX_HEIGHT = 240;

/**
 * La voce di una sessione di refinement (design 2026-10-14 §6.2), gemella di
 * `RefineItemPanel` del web: titolo, metadati, design e piano ATTUALI.
 *
 * Si rilegge quando l'agente SCRIVE, non a ogni dettaglio della sessione: lo
 * stream rimanda il dettaglio a ogni giro anche quando non è cambiato niente,
 * mentre una scrittura dell'agente (`set_design`, `set_plan`, `update_item`)
 * è un tool_use/tool_result, quindi sposta `lastEventAt`. `refreshKey` è quel
 * valore: il primo giro dell'effetto si salta (la query ha appena letto la
 * voce), ogni cambio dopo invalida la voce.
 *
 * La chiave è `backlogKeys.item`, la stessa di `BacklogItemScreen`: la voce
 * del backlog è già persistita per l'uso offline, e la regola di
 * `shouldPersistQuery` riguarda le SESSIONI, non il backlog.
 *
 * Differenza voluta dal web: design e piano partono CHIUSI, e aperti
 * scorrono in un'altezza massima. Sopra la chat di un telefono un documento
 * intero aperto toglierebbe lo spazio alla conversazione.
 *
 * Una voce che non si carica è una riga, mai la schermata: la sessione si
 * guarda e si scrive anche senza.
 */
export function RefineItemPanel({ itemId, refreshKey }: { itemId: string; refreshKey: string | null }) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const item = useQuery({
    queryKey: backlogKeys.item(itemId),
    queryFn: () => {
      if (!client) throw new Error("RefineItemPanel richiede un client autenticato");
      return client.backlog.get(itemId);
    },
    enabled: client !== null,
    staleTime: 10_000,
  });

  const lastKey = useRef(refreshKey);
  useEffect(() => {
    if (lastKey.current === refreshKey) return;
    lastKey.current = refreshKey;
    void queryClient.invalidateQueries({ queryKey: backlogKeys.item(itemId) });
  }, [queryClient, itemId, refreshKey]);

  if (item.data === undefined) {
    return item.isError ? (
      <Text style={styles.faint} testID="refine-item-panel-error">
        {t("mobile.agents.refineItem.loadError")}
      </Text>
    ) : null;
  }
  const data = item.data;
  const meta = backlogMetaParts({ ...data, ticketCount: data.tickets.length })
    .map((part) => t(part.key, part.params))
    .join(" · ");
  const riskNote = data.riskNote !== null && data.riskNote.trim() !== "" ? data.riskNote : null;
  const plan = data.implementationPlan ?? null;

  return (
    <View style={styles.panel} testID="refine-item-panel">
      <Text style={styles.eyebrow}>{t("mobile.agents.refineItem.label")}</Text>
      <Text style={styles.title} numberOfLines={2}>
        {data.title}
      </Text>
      {meta !== "" && <Text style={styles.meta}>{meta}</Text>}
      {riskNote !== null && (
        <Text style={styles.meta}>{t("mobile.agents.refineItem.riskNote", { note: riskNote })}</Text>
      )}
      <Section
        title={t("mobile.agents.refineItem.design")}
        empty={t("mobile.agents.refineItem.noDesign")}
        body={data.document.trim() === "" ? null : backlogDocumentBody(data.document, data.title)}
        testID="refine-item-design"
      />
      <Section
        title={t("mobile.agents.refineItem.plan")}
        empty={t("mobile.agents.refineItem.noPlan")}
        body={plan === null || plan.trim() === "" ? null : plan}
        testID="refine-item-plan"
      />
    </View>
  );
}

function Section({ title, empty, body, testID }: { title: string; empty: string; body: string | null; testID: string }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.section}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={styles.sectionHeader}
        testID={`${testID}-toggle`}
      >
        <Text style={styles.sectionTitle}>{`${open ? "▾" : "▸"} ${title}`}</Text>
        {body === null && <Text style={styles.faint}>{empty}</Text>}
      </Pressable>
      {open && body !== null && (
        <ScrollView style={styles.sectionBody} nestedScrollEnabled testID={`${testID}-body`}>
          <SafeMarkdown>{body}</SafeMarkdown>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.control,
    borderWidth: 1,
    gap: 4,
    marginHorizontal: 16,
    marginVertical: 4,
    padding: 12,
  },
  eyebrow: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  title: { color: colors.fg, fontFamily: fontFamily.sansSemiBold, fontSize: 14, fontWeight: "600" },
  meta: { color: colors.muted, fontFamily: fontFamily.mono, fontSize: fontSize.label },
  section: { marginTop: 4 },
  sectionHeader: { alignItems: "center", flexDirection: "row", gap: 8, minHeight: 32 },
  sectionTitle: { color: colors.fg, fontFamily: fontFamily.mono, fontSize: 12 },
  sectionBody: { maxHeight: SECTION_MAX_HEIGHT },
  faint: { color: colors.faint, fontFamily: fontFamily.mono, fontSize: 12 },
});
