import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BacklogItemDetail, Reader } from "@stubwise/shared";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../app/providers";
import { backlogDocumentBody, backlogMetaParts } from "../../lib/backlog-mutations";
import { backlogKeys } from "../../lib/query-keys";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";
import { SafeMarkdown } from "../SafeMarkdown";
import { SheetModal } from "../SheetModal";

/**
 * La voce di una sessione di refinement (design 2026-10-14 §6.2), gemella di
 * `RefineItemPanel` del web: titolo, metadati, design e piano ATTUALI.
 *
 * Sopra la trascrizione c'è UNA RIGA sola, «Voce di backlog · titolo ▸»; il
 * dettaglio sta in un foglio (`SheetModal`) che si apre toccandola, con design
 * e piano già aperti e lo scorrimento del foglio (nessuno scroll annidato).
 * Fino al 19 ott 2026 era un riquadro in linea con le sezioni da 240 pt: aperto
 * prendeva metà schermo, e la conversazione restava in una striscia.
 *
 * Si rilegge quando l'agente SCRIVE, non a ogni dettaglio della sessione: lo
 * stream rimanda il dettaglio a ogni giro anche quando non è cambiato niente,
 * mentre una scrittura dell'agente (`set_design`, `set_plan`, `update_item`)
 * è un tool_use/tool_result, quindi sposta `lastEventAt`. `refreshKey` è quel
 * valore: il primo giro dell'effetto si salta (la query ha appena letto la
 * voce), ogni cambio dopo invalida la voce. La query vive nella RIGA, sempre
 * montata: il foglio aperto si aggiorna con lei.
 *
 * La chiave è `backlogKeys.item`, la stessa di `BacklogItemScreen`: la voce
 * del backlog è già persistita per l'uso offline, e la regola di
 * `shouldPersistQuery` riguarda le SESSIONI, non il backlog.
 *
 * ⚠️ Il foglio è montato solo mentre serve, e il titolo che porta alla voce
 * segue l'invariante dei fogli nativi (`docs/invariants/mobile-app.md`):
 * chiude il pannello (`open` falso), lo smonta in `onDidDismiss` (`onClose`
 * di `SheetModal`) e naviga in un effetto DOPO il commit che l'ha tolto — la
 * forma di `GlobalSearchSheet` + `ScreenHeader`. Navigare verso la scheda
 * Backlog col foglio ancora presentato congelerebbe questa schermata.
 *
 * Una voce che non si carica è una riga, mai la schermata: la sessione si
 * guarda e si scrive anche senza.
 */
export function RefineItemRow({
  itemId,
  refreshKey,
  onOpenItem,
}: {
  itemId: string;
  refreshKey: string | null;
  /** Apre la pagina della voce (il titolo nel foglio è il link, come sul web). */
  onOpenItem: () => void;
}) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const item = useQuery({
    queryKey: backlogKeys.item(itemId),
    queryFn: () => {
      if (!client) throw new Error("RefineItemRow richiede un client autenticato");
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

  // `sheetMounted` resta vero finché il foglio non è sceso del tutto
  // (`onDidDismiss`): smontarlo ancora presentato lascia iOS bloccato.
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetMounted, setSheetMounted] = useState(false);
  const pendingNavigation = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (sheetMounted) return;
    const run = pendingNavigation.current;
    pendingNavigation.current = null;
    run?.();
  }, [sheetMounted]);

  if (item.data === undefined) {
    return item.isError ? (
      <Text style={[styles.faint, styles.rowInset]} testID="refine-item-panel-error">
        {t("mobile.agents.refineItem.loadError")}
      </Text>
    ) : null;
  }
  const data = item.data;

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("mobile.agents.refineItem.info", { title: data.title })}
        onPress={() => {
          setSheetMounted(true);
          setSheetOpen(true);
        }}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        testID="refine-item-row"
      >
        <Text style={styles.eyebrow}>{t("mobile.agents.refineItem.label")}</Text>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {data.title}
        </Text>
        <Text style={styles.chevron}>▸</Text>
      </Pressable>
      {sheetMounted && (
        <SheetModal
          open={sheetOpen}
          onClose={() => {
            setSheetOpen(false);
            setSheetMounted(false);
          }}
          maxFraction={0.85}
          testID="refine-item-sheet"
        >
          <RefineItemDetails
            item={data}
            onOpenItem={() => {
              pendingNavigation.current = onOpenItem;
              setSheetOpen(false);
            }}
          />
        </SheetModal>
      )}
    </>
  );
}

/** Il contenuto del foglio: tutto ciò che il riquadro in linea mostrava, senza tetti d'altezza. */
function RefineItemDetails({ item: data, onOpenItem }: { item: Reader<BacklogItemDetail>; onOpenItem: () => void }) {
  const { t } = useTranslation();
  const meta = backlogMetaParts({ ...data, ticketCount: data.tickets.length })
    .map((part) => t(part.key, part.params))
    .join(" · ");
  const riskNote = data.riskNote !== null && data.riskNote.trim() !== "" ? data.riskNote : null;
  const plan = data.implementationPlan ?? null;

  return (
    <View style={styles.panel} testID="refine-item-panel">
      <Text style={styles.eyebrow}>{t("mobile.agents.refineItem.label")}</Text>
      <Pressable accessibilityRole="link" onPress={onOpenItem} hitSlop={6} testID="refine-item-open">
        <Text style={styles.title}>{data.title}</Text>
      </Pressable>
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

/** Una sezione del foglio: parte APERTA, si richiude; scorre col foglio, non da sé. */
function Section({ title, empty, body, testID }: { title: string; empty: string; body: string | null; testID: string }) {
  const [open, setOpen] = useState(true);
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
      {open && body !== null && <SafeMarkdown>{body}</SafeMarkdown>}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: "center",
    borderColor: colors.line,
    borderRadius: radii.control,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    marginHorizontal: 16,
    marginVertical: 4,
    minHeight: 36,
    paddingHorizontal: 12,
  },
  rowPressed: { backgroundColor: colors.ink850 },
  rowInset: { marginHorizontal: 16, marginVertical: 4 },
  rowTitle: { color: colors.fg, flex: 1, fontFamily: fontFamily.sansSemiBold, fontSize: 13, fontWeight: "600" },
  chevron: { color: colors.muted, fontFamily: fontFamily.mono, fontSize: 12 },
  panel: { gap: 4 },
  eyebrow: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  title: { color: colors.fg, fontFamily: fontFamily.sansSemiBold, fontSize: 16, fontWeight: "600" },
  meta: { color: colors.muted, fontFamily: fontFamily.mono, fontSize: fontSize.label },
  section: { marginTop: 8 },
  sectionHeader: { alignItems: "center", flexDirection: "row", gap: 8, minHeight: 32 },
  sectionTitle: { color: colors.fg, fontFamily: fontFamily.mono, fontSize: 12 },
  faint: { color: colors.faint, fontFamily: fontFamily.mono, fontSize: 12 },
});
