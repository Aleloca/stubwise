import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { isUnknown, type MailRejections, type Reader } from "@stubwise/shared";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import type { MbxStackParamList } from "../../app/navigation";
import { GhostButton } from "../../components/GhostButton";
import { usePullToRefresh } from "../../components/PullToRefresh";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Skeleton } from "../../components/Skeleton";
import { REJECTIONS_DAYS, useMailRejections } from "../../lib/mail-mutations";
import { mailKeys } from "../../lib/query-keys";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

/** Vedi `InboxScreen.tsx` per il perché di una costante invece di leggere `styles.body.paddingBottom`. */
const CONTENT_BASE_BOTTOM_PADDING = 40;

type RejectionReason = Reader<MailRejections>["accounts"][number]["reasons"][number];

/**
 * LE MAIL TENUTE FUORI («le mail tenute fuori», 25 set 2026, design §5):
 * quante email il cancello di ammissione ha scartato negli ultimi giorni, per
 * casella e per motivo, con i domini di chi le ha mandate.
 *
 * Risponde a UNA domanda — «il cancello sta tagliando un cliente?» — e per
 * questo mostra il DOMINIO e non l'email: di una mail scartata Stubwise non
 * conserva né l'oggetto né l'indirizzo completo.
 *
 * L'intestazione con l'indirizzo della casella compare solo quando le caselle
 * sono più d'una: con una sola sarebbe un'informazione che chi guarda sa già.
 * Le righe dei domini NON sono premibili: non c'è un dettaglio da aprire.
 */
export function MailRejectionsScreen({ navigation }: NativeStackScreenProps<MbxStackParamList, "MailRejections">) {
  const { t } = useTranslation();
  const tabBarHeight = useBottomTabBarHeight();
  const query = useMailRejections(REJECTIONS_DAYS);
  const refreshControl = usePullToRefresh([mailKeys.rejections(REJECTIONS_DAYS)], "rejections-refresh");
  const showAccounts = (query.data?.accounts.length ?? 0) > 1;

  return (
    <View style={styles.container} testID="mail-rejections-screen">
      <ScrollView
        refreshControl={refreshControl}
        contentContainerStyle={[styles.body, { paddingBottom: CONTENT_BASE_BOTTOM_PADDING + tabBarHeight }]}
        stickyHeaderIndices={[0]}
      >
        <ScreenHeader
          title={t("mobile.mbx.rejections.title")}
          onBack={() => navigation.goBack()}
          backLabel={t("mobile.mbx.rejections.back")}
        />

        {query.isPending ? (
          <View style={styles.list} testID="rejections-skeleton">
            <Skeleton height={96} />
            <Skeleton height={96} />
          </View>
        ) : query.isError ? (
          <View style={styles.centered} testID="rejections-error">
            <Text style={styles.stateTitle}>{t("mobile.mbx.rejections.loadError.title")}</Text>
            <GhostButton
              label={t("mobile.mbx.rejections.loadError.retry")}
              onPress={() => void query.refetch()}
              testID="rejections-retry"
            />
          </View>
        ) : query.data.accounts.length === 0 ? (
          <View style={styles.centered} testID="rejections-empty">
            <Text style={styles.stateTitle}>{t("mobile.mbx.rejections.empty.title")}</Text>
            <Text style={styles.stateBody}>{t("mobile.mbx.rejections.empty.body", { days: query.data.days })}</Text>
          </View>
        ) : (
          <>
            <Text style={styles.intro}>{t("mobile.mbx.rejections.intro", { days: query.data.days })}</Text>
            {query.data.accounts.map((account) => (
              <View key={account.accountId} style={styles.list}>
                {showAccounts && (
                  <Text style={styles.account} testID={`rejections-account-${account.accountId}`}>
                    {account.email}
                  </Text>
                )}
                {account.reasons.map((reason, index) => (
                  <ReasonGroup key={isUnknown(reason.reason) ? `unknown-${index}` : reason.reason} reason={reason} />
                ))}
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

/**
 * Un motivo: titolo col conteggio, UNA riga che dice cosa vuol dire, e sotto i
 * domini. Un motivo che questa versione dell'app non conosce (un server più
 * nuovo, via `readerSchema`) si mostra come «Altro» e SENZA spiegazione:
 * meglio nessuna frase che una frase inventata.
 */
function ReasonGroup({ reason }: { reason: RejectionReason }) {
  const { t } = useTranslation();
  const known = !isUnknown(reason.reason);
  const key = known ? reason.reason : "unknown";

  return (
    <View style={styles.group} testID={`rejections-reason-${key}`}>
      <View style={styles.groupHeader}>
        <Text style={styles.groupTitle}>{t(`mobile.mbx.rejections.reasons.${key}.title`)}</Text>
        <Text style={styles.groupCount}>{t("mobile.mbx.rejections.count", { count: reason.count })}</Text>
      </View>
      {known && <Text style={styles.groupBody}>{t(`mobile.mbx.rejections.reasons.${key}.body`)}</Text>}
      {reason.domains.map((domain) => (
        <View key={domain.domain ?? "__null__"} style={styles.domainRow}>
          <Text style={[styles.domain, domain.domain === null && styles.domainUnknown]} numberOfLines={1}>
            {domain.domain ?? t("mobile.mbx.rejections.unknownDomain")}
          </Text>
          <Text style={styles.domainCount}>{domain.count}</Text>
        </View>
      ))}
      {reason.otherDomains > 0 && (
        <Text style={styles.otherDomains}>
          {t("mobile.mbx.rejections.otherDomains", { count: reason.otherDomains })}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  body: {
    gap: 12,
    padding: 16,
    paddingBottom: 40,
  },
  intro: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 13,
    lineHeight: 18,
  },
  list: {
    gap: 8,
  },
  account: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    marginTop: 4,
  },
  group: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.control,
    borderWidth: 1,
    gap: 6,
    padding: 12,
  },
  groupHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    justifyContent: "space-between",
  },
  groupTitle: {
    color: colors.fg,
    flexShrink: 1,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 15,
    fontWeight: "600",
  },
  groupCount: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  groupBody: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 13,
    lineHeight: 18,
  },
  domainRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    justifyContent: "space-between",
  },
  domain: {
    color: colors.fg,
    flexShrink: 1,
    fontFamily: fontFamily.mono,
    fontSize: 13,
  },
  domainUnknown: {
    color: colors.faint,
    fontStyle: "italic",
  },
  domainCount: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 13,
  },
  otherDomains: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  centered: {
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 32,
    paddingVertical: 48,
  },
  stateTitle: {
    color: colors.fg,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 17,
    fontWeight: "600",
    textAlign: "center",
  },
  stateBody: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
});
