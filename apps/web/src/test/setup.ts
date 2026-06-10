import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Senza i globals di vitest l'auto-cleanup di testing-library non si
// registra da solo: lo si fa qui per ogni test.
afterEach(cleanup);
