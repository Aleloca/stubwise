import { ApiError } from "@stubwise/api-client";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, StyleSheet, Text, TextInput, View } from "react-native";
import DeviceInfo from "react-native-device-info";
import type { AuthStackParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Wordmark } from "../../components/Wordmark";
import { createClient } from "../../lib/client";
import { colors } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

/**
 * `deviceName` per il PAT che `mobile-login` crea (`Mobile · <deviceName>`):
 * `DeviceInfo.getDeviceName()` è quello vero, impostato dall'utente in
 * Impostazioni ("iPhone di Aleloca"); se il device non lo espone (o la
 * chiamata fallisce) si ripiega su piattaforma + modello, che esiste
 * sempre.
 */
async function resolveDeviceName(): Promise<string> {
  try {
    const name = await DeviceInfo.getDeviceName();
    if (name && name.trim().length > 0) return name.trim();
  } catch {
    // ignorato: si passa al fallback
  }
  return `${Platform.OS === "ios" ? "iOS" : "Android"} · ${DeviceInfo.getModel()}`;
}

/** Antepone `https://` se l'utente non ha scritto uno schema, e toglie lo slash finale. */
function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

type LoginError =
  | "invalid_credentials"
  | "unexpected"
  | "setup_required"
  | "invalid_code"
  | "busy"
  | "locked";

type LoginState =
  | { kind: "form"; error?: LoginError; lockedUntil?: Date }
  | { kind: "submitting" }
  | { kind: "unreachable" };

export function LoginScreen({ navigation }: NativeStackScreenProps<AuthStackParamList, "Login">) {
  const { t } = useTranslation();
  const { login } = useAuth();
  const [url, setUrl] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Il codice del secondo fattore: il campo compare quando il server lo
  // chiede (401 `second_factor_required`) e resta, con email e password
  // intatte, finché il login non riesce.
  const [code, setCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [state, setState] = useState<LoginState>({ kind: "form" });

  async function submit() {
    const baseUrl = normalizeBaseUrl(url);
    setState({ kind: "submitting" });
    try {
      const client = createClient(baseUrl);
      const deviceName = await resolveDeviceName();
      const result = await client.auth.mobileLogin({
        email,
        password,
        deviceName,
        ...(needsCode && code.trim() ? { code: code.trim() } : {}),
      });
      await login({ baseUrl, token: result.token, patId: result.patId, user: result.user });
      navigation.navigate("Onboarding");
    } catch (error) {
      if (error instanceof ApiError && error.code === "second_factor_required") {
        setNeedsCode(true);
        setState({ kind: "form" });
        return;
      }
      if (error instanceof ApiError && error.code === "invalid_second_factor") {
        setState({ kind: "form", error: "invalid_code" });
        return;
      }
      if (error instanceof ApiError && error.code === "second_factor_setup_required") {
        setState({ kind: "form", error: "setup_required" });
        return;
      }
      if (error instanceof ApiError && error.code === "second_factor_locked") {
        const until = (error.details as { lockedUntil?: unknown } | undefined)?.lockedUntil;
        const lockedUntil = typeof until === "string" ? new Date(until) : undefined;
        setState({
          kind: "form",
          error: "locked",
          lockedUntil: lockedUntil && !Number.isNaN(lockedUntil.getTime()) ? lockedUntil : undefined,
        });
        return;
      }
      // Troppi tentativi in volo: il codice non è stato valutato, si riprova.
      if (error instanceof ApiError && error.code === "second_factor_busy") {
        setState({ kind: "form", error: "busy" });
        return;
      }
      if (error instanceof ApiError && error.status === 401) {
        setState({ kind: "form", error: "invalid_credentials" });
        return;
      }
      // status 0 copre SIA `network_error` (fetch rifiutata: host giù, DNS,
      // TLS) SIA `auth_unavailable` (Keychain irraggiungibile) — qui non
      // c'è ancora nessuna sessione da leggere, quindi in pratica è sempre
      // il primo caso, ma trattarli allo stesso modo è corretto in
      // entrambi: "l'istanza non risponde" è la lettura giusta per un
      // utente anche quando la causa vera è locale.
      if (error instanceof ApiError && error.status === 0) {
        setState({ kind: "unreachable" });
        return;
      }
      setState({ kind: "form", error: "unexpected" });
    }
  }

  if (state.kind === "unreachable") {
    return (
      <View style={styles.container}>
        <View style={styles.centered}>
          <Text style={styles.unreachableTitle}>{t("mobile.auth.login.unreachableTitle")}</Text>
          <Text style={styles.unreachableBody}>{t("mobile.auth.login.unreachableBody")}</Text>
          <View style={styles.retryButton}>
            <GhostButton label={t("mobile.auth.login.retry")} onPress={() => void submit()} />
          </View>
        </View>
      </View>
    );
  }

  const submitting = state.kind === "submitting";

  return (
    <View style={styles.container}>
      <Wordmark size={24} />
      <Text style={styles.tagline}>{t("mobile.auth.tagline")}</Text>

      <View style={styles.form}>
        <Field
          label={t("mobile.auth.login.urlLabel")}
          value={url}
          onChangeText={setUrl}
          placeholder={t("mobile.auth.login.urlPlaceholder")}
          autoCapitalize="none"
          keyboardType="url"
          testID="login-url"
        />
        <Field
          label={t("mobile.auth.login.emailLabel")}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          testID="login-email"
        />
        <Field
          label={t("mobile.auth.login.passwordLabel")}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          testID="login-password"
        />

        {needsCode ? (
          <Field
            label={t("mobile.auth.login.codeLabel")}
            value={code}
            onChangeText={setCode}
            autoCapitalize="none"
            testID="login-code"
          />
        ) : null}

        {state.kind === "form" && state.error === "invalid_code" ? (
          <Text style={styles.errorText}>{t("mobile.auth.login.invalidCode")}</Text>
        ) : null}
        {state.kind === "form" && state.error === "setup_required" ? (
          <Text style={styles.errorText}>{t("mobile.auth.login.setupRequired")}</Text>
        ) : null}
        {state.kind === "form" && state.error === "busy" ? (
          <Text style={styles.errorText}>{t("mobile.auth.login.busy")}</Text>
        ) : null}
        {state.kind === "form" && state.error === "locked" ? (
          <Text style={styles.errorText}>
            {state.lockedUntil
              ? t("mobile.auth.login.locked", {
                  minutes: Math.max(1, Math.ceil((state.lockedUntil.getTime() - Date.now()) / 60_000)),
                })
              : t("mobile.auth.login.lockedNoTime")}
          </Text>
        ) : null}
        {state.kind === "form" && state.error === "invalid_credentials" ? (
          <Text style={styles.errorText}>{t("mobile.auth.login.invalidCredentials")}</Text>
        ) : null}
        {state.kind === "form" && state.error === "unexpected" ? (
          <Text style={styles.errorText}>{t("mobile.auth.login.unexpectedError")}</Text>
        ) : null}

        <PrimaryButton
          label={t("mobile.auth.login.submit")}
          onPress={() => void submit()}
          disabled={submitting || !url || !email || !password || (needsCode && !code.trim())}
          testID="login-submit"
        />
        <Text style={styles.qrHint}>{t("mobile.auth.login.qrHint")}</Text>
      </View>
    </View>
  );
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  autoCapitalize,
  keyboardType,
  secureTextEntry,
  testID,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  autoCapitalize?: "none" | "sentences";
  keyboardType?: "default" | "email-address" | "url";
  secureTextEntry?: boolean;
  testID?: string;
}) {
  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        autoCapitalize={autoCapitalize ?? "sentences"}
        keyboardType={keyboardType ?? "default"}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.faint}
        secureTextEntry={secureTextEntry}
        style={styles.input}
        testID={testID}
        value={value}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  centered: {
    alignItems: "center",
  },
  tagline: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 12,
    letterSpacing: 0.6,
    marginTop: 8,
  },
  form: {
    gap: 14,
    marginTop: 28,
  },
  label: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    fontWeight: "500",
    letterSpacing: 1.4,
    marginBottom: 6,
    textTransform: "uppercase",
  },
  input: {
    backgroundColor: "rgba(10,13,16,0.7)",
    borderColor: colors.lineStrong,
    borderRadius: 8,
    borderWidth: 1,
    color: colors.fg,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.input,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  errorText: {
    color: colors.danger,
    fontFamily: fontFamily.sans,
    fontSize: 13,
  },
  qrHint: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    marginTop: 2,
    textAlign: "center",
  },
  unreachableTitle: {
    color: colors.fg,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 15,
    fontWeight: "600",
    marginTop: 10,
  },
  unreachableBody: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 14,
    marginTop: 6,
    textAlign: "center",
  },
  retryButton: {
    marginTop: 16,
    width: "100%",
  },
});
