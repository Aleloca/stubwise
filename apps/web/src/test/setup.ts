import "@testing-library/jest-dom/vitest";
// Inizializza i18next (side-effect) prima dei test: i componenti che usano
// `useTranslation`/`t()` risolvono le chiavi sulla lingua di default (en),
// niente warning NO_I18NEXT_INSTANCE.
import "../i18n";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Senza i globals di vitest l'auto-cleanup di testing-library non si
// registra da solo: lo si fa qui per ogni test.
afterEach(cleanup);
