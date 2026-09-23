import { ApiError } from "@stubwise/api-client";
import {
  effectiveSettings,
  pulseValue,
  settingsErrorKey,
  settingsInvalid,
  settingsPatch,
  type ProjectSettingsValues,
} from "./project-settings";

const PROJECT: ProjectSettingsValues = {
  name: "Portale B2B",
  description: "Il portale dei rivenditori",
  docAutoUpdate: false,
  dailyReportEnabled: true,
  backlogEnabled: true,
  pulseEnabled: true,
  pulseEveryDays: 3,
  weeklyBriefEnabled: false,
};

describe("settingsPatch", () => {
  test("niente toccato: patch vuota", () => {
    expect(settingsPatch(PROJECT, {})).toEqual({});
  });

  /**
   * ⚠️ Il cuore della regola: la patch porta SOLO il campo cambiato. Se
   * portasse l'oggetto intero, chi salva sovrascriverebbe i campi che un
   * collega ha cambiato mentre questa schermata era aperta.
   */
  test("un solo interruttore toccato: un solo campo nella patch", () => {
    expect(settingsPatch(PROJECT, { weeklyBriefEnabled: true })).toEqual({ weeklyBriefEnabled: true });
  });

  test("toccato e rimesso com'era: non si manda", () => {
    expect(settingsPatch(PROJECT, { backlogEnabled: true, pulseEveryDays: 3 })).toEqual({});
  });

  test("descrizione svuotata: null, non stringa vuota", () => {
    expect(settingsPatch(PROJECT, { description: "   " })).toEqual({ description: null });
  });

  test("nome con spazi ai bordi: si manda ripulito", () => {
    expect(settingsPatch(PROJECT, { name: "  Portale Rivenditori " })).toEqual({ name: "Portale Rivenditori" });
  });

  test("cadenza cambiata", () => {
    expect(settingsPatch(PROJECT, { pulseEveryDays: 7 })).toEqual({ pulseEveryDays: 7 });
  });
});

describe("effectiveSettings", () => {
  /**
   * I campi NON toccati si leggono dal server: un valore cambiato da un
   * collega arriva al primo refetch, invece di restare congelato nel form.
   */
  test("un campo non toccato segue il server", () => {
    const fromServer = { ...PROJECT, dailyReportEnabled: false };
    expect(effectiveSettings(fromServer, { weeklyBriefEnabled: true }).dailyReportEnabled).toBe(false);
  });
});

describe("settingsInvalid", () => {
  test("nome vuoto non si salva", () => {
    expect(settingsInvalid({ ...PROJECT, name: "  " })).toBe(true);
  });
});

describe("pulseValue", () => {
  test("spento", () => {
    expect(pulseValue({ ...PROJECT, pulseEnabled: false }).key).toBe("mobile.projects.settings.pulseOff");
  });

  /** ⚠️ Acceso senza backlog è muto: lo si dice, invece di promettere una cadenza. */
  test("acceso senza backlog: in attesa del backlog, non una cadenza", () => {
    expect(pulseValue({ ...PROJECT, backlogEnabled: false })).toEqual({
      key: "mobile.projects.settings.pulseWaitingBacklog",
    });
  });

  test("acceso col backlog: la cadenza", () => {
    expect(pulseValue(PROJECT)).toEqual({ key: "mobile.projects.settings.pulseEvery", count: 3 });
  });
});

describe("settingsErrorKey", () => {
  test("403: solo un maintainer", () => {
    expect(settingsErrorKey(new ApiError(403, "Forbidden", "forbidden"))).toBe("mobile.projects.settings.errors.forbidden");
  });
  test("altro: generico", () => {
    expect(settingsErrorKey(new Error("rete"))).toBe("mobile.projects.settings.errors.generic");
  });
});
