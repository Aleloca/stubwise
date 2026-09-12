import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { ApiError } from "@stubwise/api-client";
import { useTranslation } from "react-i18next";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import type { MbxStackParamList } from "../../app/navigation";
import { GhostButton } from "../../components/GhostButton";
import { SettingsAvatarButton } from "../../components/SettingsAvatarButton";
import { Skeleton } from "../../components/Skeleton";
import { relativeTimeCompact } from "../../lib/format";
import { useMailDetail, useMailOriginal } from "../../lib/mail-mutations";
import { colors } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

/** Vedi `InboxScreen.tsx` per il perché di una costante invece di leggere `styles.body.paddingBottom`. */
const CONTENT_BASE_BOTTOM_PADDING = 40;

/**
 * Dettaglio di una email (App M3, Fase C, Task 7-8). Route target del deep
 * link `stubwise://mail/email/:id` (Task 7, architettura §5 regola 2) e
 * della lista Posta (Task 8, tap su una riga `"email"`/`"email_triage"`).
 *
 * **Il corpo è TESTO, mai markdown** (design §, punto 1): `textExcerpt` e
 * `bodyText` sono resi con un semplice `<Text>`, nessun
 * `react-native-markdown-display` — un asterisco o un trattino di un'email
 * scritta da un estraneo non vanno reinterpretati.
 *
 * **La copy distingue le due fonti** (design §, punto 2): l'estratto
 * dichiara di essere un estratto (niente citazioni, firma, allegati) ed è
 * assente sui messaggi anteriori alla fase 6; l'originale dichiara che sta
 * chiedendo il messaggio a Google ADESSO — la nota sta accanto al bottone
 * PRIMA del tap, non solo durante l'attesa (stesso fix di review del web,
 * commit `db2e5a3`).
 */
export function MailDetailScreen({ navigation, route }: NativeStackScreenProps<MbxStackParamList, "MailDetail">) {
  const { t } = useTranslation();
  const tabBarHeight = useBottomTabBarHeight();
  const { source, id } = route.params;

  const detailQuery = useMailDetail(source, id);
  const original = useMailOriginal(source, id);

  const notFound = detailQuery.isError && detailQuery.error instanceof ApiError && detailQuery.error.status === 404;

  return (
    <View style={styles.container} testID="mail-detail-screen">
      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: CONTENT_BASE_BOTTOM_PADDING + tabBarHeight }]}
        stickyHeaderIndices={[0]}
      >
        <View style={styles.headerRow}>
          <Pressable onPress={() => navigation.goBack()} testID="mail-detail-back">
            <Text style={styles.back}>{t("mobile.mbx.detail.back")}</Text>
          </Pressable>
          <SettingsAvatarButton />
        </View>

        {detailQuery.isPending ? (
          <View style={styles.skeletonList} testID="mail-detail-skeleton">
            <Skeleton height={24} width="70%" />
            <Skeleton height={16} width="40%" />
            <Skeleton height={120} />
          </View>
        ) : notFound ? (
          <View style={styles.centered} testID="mail-detail-not-found">
            <Text style={styles.errorTitle}>{t("mobile.mbx.detail.loadError.title")}</Text>
          </View>
        ) : detailQuery.isError ? (
          <View style={styles.centered} testID="mail-detail-error">
            <Text style={styles.errorTitle}>{t("mobile.mbx.detail.loadError.title")}</Text>
            <GhostButton
              label={t("mobile.mbx.detail.loadError.retry")}
              onPress={() => void detailQuery.refetch()}
              testID="mail-detail-retry"
            />
          </View>
        ) : (
          <DetailBody detail={detailQuery.data!} original={original} />
        )}
      </ScrollView>
    </View>
  );
}

function DetailBody({
  detail,
  original,
}: {
  detail: NonNullable<ReturnType<typeof useMailDetail>["data"]>;
  original: ReturnType<typeof useMailOriginal>;
}) {
  const { t } = useTranslation();
  const relative = relativeTimeCompact(detail.receivedAt);
  const timeText = relative.kind === "now" ? t("mobile.mbx.time.now") : t(`mobile.mbx.time.${relative.kind}`, { count: relative.count });

  return (
    <>
      <Text style={styles.subject}>{detail.subject ?? t("mobile.mbx.list.noSubject")}</Text>
      <Text style={styles.from}>{detail.from}</Text>
      {detail.to.length > 0 && <Text style={styles.meta}>{t("mobile.mbx.detail.to", { list: detail.to.join(", ") })}</Text>}
      <Text style={styles.time}>{timeText}</Text>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t("mobile.mbx.detail.excerptTitle")}</Text>
        {detail.textExcerpt !== null ? (
          <>
            <Text style={styles.excerptNote}>{t("mobile.mbx.detail.excerptNote")}</Text>
            <Text style={styles.excerptText}>{detail.textExcerpt}</Text>
          </>
        ) : (
          <Text style={styles.excerptMissing}>{t("mobile.mbx.detail.excerptMissing")}</Text>
        )}
      </View>

      <View style={styles.gmailButton}>
        <GhostButton label={t("mobile.mbx.detail.openInGmail")} onPress={() => void Linking.openURL(detail.url)} testID="mail-detail-open-gmail" />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t("mobile.mbx.detail.originalTitle")}</Text>
        <Text style={styles.excerptNote}>{t("mobile.mbx.detail.originalNote")}</Text>

        {original.data === null ? (
          <View style={styles.showOriginalButton}>
            <GhostButton
              label={original.isPending ? t("mobile.mbx.detail.originalLoading") : t("mobile.mbx.detail.showOriginal")}
              onPress={original.load}
              disabled={original.isPending}
              testID="mail-detail-show-original"
            />
            {original.errorMessage !== null && (
              <Text accessibilityLiveRegion="polite" style={styles.originalError} testID="mail-detail-original-error">
                {original.errorMessage}
              </Text>
            )}
          </View>
        ) : (
          <View testID="mail-detail-original-body">
            <Text style={styles.originalBody}>{original.data.bodyText ?? t("mobile.mbx.detail.excerptMissing")}</Text>
            {original.data.cc.length > 0 && <Text style={styles.meta}>{t("mobile.mbx.detail.cc", { list: original.data.cc.join(", ") })}</Text>}
            {original.data.attachments.length > 0 && (
              <Text style={styles.meta}>
                {t(
                  original.data.attachments.length === 1 ? "mobile.mbx.detail.attachments_one" : "mobile.mbx.detail.attachments_other",
                  {
                    count: original.data.attachments.length,
                    names: original.data.attachments.map((attachment) => attachment.filename).join(", "),
                  },
                )}
              </Text>
            )}
          </View>
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  body: {
    gap: 4,
    padding: 20,
    paddingBottom: 40,
  },
  headerRow: {
    alignItems: "center",
    backgroundColor: colors.ink950,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingBottom: 12,
    paddingTop: 56,
  },
  back: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 12,
  },
  skeletonList: {
    gap: 12,
  },
  centered: {
    alignItems: "center",
    flex: 1,
    gap: 8,
    justifyContent: "center",
    paddingHorizontal: 32,
    paddingVertical: 48,
  },
  errorTitle: {
    color: colors.fg,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 15,
    fontWeight: "600",
    textAlign: "center",
  },
  subject: {
    color: colors.fg,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 18,
    fontWeight: "600",
    marginTop: 6,
  },
  from: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 14,
    marginTop: 6,
  },
  meta: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    marginTop: 4,
  },
  time: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    marginTop: 4,
  },
  section: {
    marginTop: 22,
  },
  sectionTitle: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  excerptNote: {
    color: colors.faint,
    fontFamily: fontFamily.sans,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 6,
  },
  excerptText: {
    color: colors.fg,
    fontFamily: fontFamily.sans,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 10,
  },
  excerptMissing: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 14,
    marginTop: 10,
  },
  gmailButton: {
    alignSelf: "flex-start",
    marginTop: 14,
  },
  showOriginalButton: {
    alignSelf: "flex-start",
    marginTop: 10,
  },
  originalError: {
    color: colors.danger,
    fontFamily: fontFamily.sans,
    fontSize: 12,
    marginTop: 8,
  },
  originalBody: {
    color: colors.fg,
    fontFamily: fontFamily.sans,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 10,
  },
});
