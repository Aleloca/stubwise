import { googleOauthScopes } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import en from "../../i18n/locales/en.json";
import it_ from "../../i18n/locales/it.json";
import { GOOGLE_SETUP } from "./constants";

// Il riconsenso unico dell'area 6 (fetta 1): gli scope che Stubwise chiede a
// Google sono quelli del server (`googleOauthScopes`), e i testi non dicono più
// «sola lettura» (letto/non letto si sincronizza con Gmail, D5).

describe("gli scope di Google", () => {
  it("Impostazioni → Google mostra gli scope che il server chiede davvero", () => {
    expect(GOOGLE_SETUP.scopes).toEqual(googleOauthScopes);
  });

  it("le Preferenze dicono cosa fa Stubwise con la casella: legge e segna letto/non letto, non «sola lettura»", () => {
    expect(en.prefs.google.intro).not.toMatch(/read-only/i);
    expect(it_.prefs.google.intro).not.toMatch(/sola lettura/i);
    expect(en.prefs.google.intro).toMatch(/read and unread/i);
    expect(it_.prefs.google.intro).toMatch(/letto e non letto/i);
  });
});
