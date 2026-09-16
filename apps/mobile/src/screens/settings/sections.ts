/**
 * IL CATALOGO delle Impostazioni (16 set 2026).
 *
 * La pagina Impostazioni è un INDICE: gruppi di righe che aprono una
 * sotto-pagina. La forma è una decisione del maintainer, presa sapendo che lì
 * finiranno tutte le impostazioni future — un elenco regge la crescita
 * (una voce nuova è una riga), una pagina unica no (una voce nuova sono venti
 * righe in più da scorrere prima di arrivare a «Esci»).
 *
 * Questo file è l'unico posto da toccare per aggiungerne una: le rotte non
 * cambiano (ce n'è UNA sola, parametrica) e l'indice si disegna da qui.
 *
 * ⚠️ `status: "wip"` non è un segnaposto inventato per riempire: ogni voce
 * marcata così è qualcosa che ESISTE già altrove e che l'app non ha ancora —
 * o il web la offre a un operatore (caselle Google, token di accesso), o il
 * server la supporta e l'app non la mostra (DM su Slack), o è nel programma
 * dell'app (ore di silenzio, dettatura e widget sono la M4). Chi la implementa
 * cambia `status` e basta.
 */
export type SettingsSectionStatus = "ready" | "wip";

export interface SettingsSection {
  key: SettingsSectionKey;
  /** Chiave i18n del titolo della riga e della sotto-pagina. */
  labelKey: string;
  /** Chiave i18n di una riga che spiega, dentro la sotto-pagina, cosa sarà. */
  descriptionKey: string;
  status: SettingsSectionStatus;
}

export interface SettingsGroup {
  labelKey: string;
  sections: SettingsSection[];
}

export type SettingsSectionKey =
  | "profile"
  | "mailboxes"
  | "tokens"
  | "notifications"
  | "quietHours"
  | "slack"
  | "language"
  | "appearance"
  | "instance"
  | "about";

function section(
  key: SettingsSectionKey,
  status: SettingsSectionStatus = "wip",
): SettingsSection {
  return {
    key,
    labelKey: `mobile.settings.sections.${key}.label`,
    descriptionKey: `mobile.settings.sections.${key}.description`,
    status,
  };
}

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    labelKey: "mobile.settings.groups.account",
    sections: [section("profile", "ready"), section("mailboxes"), section("tokens")],
  },
  {
    labelKey: "mobile.settings.groups.notifications",
    sections: [section("notifications", "ready"), section("quietHours"), section("slack")],
  },
  {
    labelKey: "mobile.settings.groups.app",
    sections: [
      section("language", "ready"),
      section("appearance"),
      section("instance", "ready"),
      section("about", "ready"),
    ],
  },
];

/** Tutte le voci, appiattite: comodo a chi deve risolvere una `key` in una sezione. */
export const SETTINGS_SECTIONS: SettingsSection[] = SETTINGS_GROUPS.flatMap((group) => group.sections);

export function settingsSection(key: SettingsSectionKey): SettingsSection {
  const found = SETTINGS_SECTIONS.find((item) => item.key === key);
  if (!found) throw new Error(`Sezione Impostazioni sconosciuta: ${key}`);
  return found;
}
