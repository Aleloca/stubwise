import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SheetModal } from "../SheetModal";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

export type CommentAction = "edit" | "delete";

/**
 * Il pannello «⋯» di un commento (piano 2026-10-05, B4): «Modifica» ed
 * «Elimina», SOLO le voci che il server ha detto permesse (`canEdit`/
 * `canDelete`, letti da chi monta il pannello — mai dedotti dal ruolo).
 *
 * ⚠️ **La scelta NON agisce al tocco.** Il tocco annota la voce e chiede di
 * chiudere (`onRequestClose`: chi possiede `open` lo mette a falso); la
 * scelta esce da `onClosed`, cioè da `onDidDismiss`, quando il foglio è
 * davvero sceso. Chi la riceve smonta il pannello e SOLO DOPO agisce — apre
 * il campo di modifica, o monta la conferma — in un effetto, dopo il commit
 * che l'ha tolto. Agire al tocco presenterebbe la conferma mentre questo
 * foglio è ancora a schermo (due fogli insieme), o smonterebbe un foglio
 * presentato: su iOS in entrambi i casi la pagina resta immobile, col foglio
 * congelato (CLAUDE.md, «Un foglio nativo che porta a un'altra schermata»).
 * Il mock Jest chiude in modo sincrono: il test verifica che la scelta non
 * arrivi a foglio aperto, la sequenza vera si prova sul telefono.
 *
 * Trascinarlo via senza scegliere chiude con `null`.
 */
export function CommentActionsSheet({
  open,
  canEdit,
  canDelete,
  onRequestClose,
  onClosed,
}: {
  open: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onRequestClose: () => void;
  onClosed: (choice: CommentAction | null) => void;
}) {
  const { t } = useTranslation();
  const chosen = useRef<CommentAction | null>(null);

  function choose(action: CommentAction): void {
    chosen.current = action;
    onRequestClose();
  }

  return (
    <SheetModal
      open={open}
      onClose={() => {
        const choice = chosen.current;
        chosen.current = null;
        onClosed(choice);
      }}
      scrollable={false}
      testID="work-comment-actions"
    >
      <View style={styles.list}>
        {canEdit && (
          <Pressable
            accessibilityRole="button"
            onPress={() => choose("edit")}
            style={styles.item}
            testID="work-comment-action-edit"
          >
            <Text style={styles.label}>{t("mobile.work.comments.actionEdit")}</Text>
          </Pressable>
        )}
        {canDelete && (
          <Pressable
            accessibilityRole="button"
            onPress={() => choose("delete")}
            style={styles.item}
            testID="work-comment-action-delete"
          >
            <Text style={[styles.label, styles.danger]}>{t("mobile.work.comments.actionDelete")}</Text>
          </Pressable>
        )}
      </View>
    </SheetModal>
  );
}

const styles = StyleSheet.create({
  list: {
    gap: 8,
  },
  item: {
    borderColor: colors.lineStrong,
    borderRadius: radii.control,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  label: {
    color: colors.fg,
    fontFamily: fontFamily.monoSemiBold,
    fontSize: fontSize.body,
  },
  danger: {
    color: colors.danger,
  },
});
