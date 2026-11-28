import { expect, type APIRequestContext } from "@playwright/test";

/** Il primo admin della suite: lo crea il primo spec che gira (il database nasce vuoto a ogni run). */
export const ADMIN_EMAIL = "ada@example.com";
export const ADMIN_PASSWORD = "password-sicura-e2e-app";

export async function ensureAdmin(request: APIRequestContext): Promise<void> {
  const status = await request.get("/api/auth/setup");
  const { needed } = (await status.json()) as { needed: boolean };
  if (!needed) return;
  const setup = await request.post("/api/auth/setup", { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  expect(setup.ok()).toBe(true);
}
