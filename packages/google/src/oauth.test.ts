import { describe, expect, it } from "vitest";
import { GoogleApiError, isFatalGoogleError } from "./errors.js";
import {
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserinfo,
  GOOGLE_SCOPES,
  refreshAccessToken,
  revokeToken,
} from "./oauth.js";
import { fakeFetch, jsonResponse } from "./test-support.js";

const CREDS = { clientId: "cid.apps.googleusercontent.com", clientSecret: "shh" };

describe("buildAuthorizeUrl", () => {
  it("chiede il consenso offline con gli scope di sola lettura", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: CREDS.clientId,
        redirectUri: "https://stubwise.test/api/me/google/callback",
        state: "signed-state",
        hd: "acme.test",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(CREDS.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe("https://stubwise.test/api/me/google/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("signed-state");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    expect(url.searchParams.get("hd")).toBe("acme.test");
    expect(url.searchParams.get("scope")).toBe(GOOGLE_SCOPES.join(" "));
    expect(GOOGLE_SCOPES).toContain("https://www.googleapis.com/auth/gmail.readonly");
    expect(GOOGLE_SCOPES).toContain("https://www.googleapis.com/auth/calendar.readonly");
  });

  it("omette hd quando il Workspace non ha un dominio da suggerire", () => {
    const url = new URL(
      buildAuthorizeUrl({ clientId: "cid", redirectUri: "https://stubwise.test/cb", state: "s" }),
    );
    expect(url.searchParams.has("hd")).toBe(false);
  });
});

describe("exchangeCode", () => {
  it("posta il code al token endpoint in form-urlencoded", async () => {
    const { impl, calls } = fakeFetch([
      jsonResponse({
        access_token: "at-1",
        expires_in: 3599,
        refresh_token: "rt-1",
        scope: "openid email https://www.googleapis.com/auth/gmail.readonly",
        token_type: "Bearer",
        id_token: "idt",
      }),
    ]);
    const tokens = await exchangeCode(
      { ...CREDS, code: "auth-code", redirectUri: "https://stubwise.test/cb" },
      { fetchImpl: impl },
    );
    const call = calls[0];
    expect(call?.url).toBe("https://oauth2.googleapis.com/token");
    expect(call?.method).toBe("POST");
    expect(call?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(call?.body ?? "");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("client_id")).toBe(CREDS.clientId);
    expect(body.get("client_secret")).toBe(CREDS.clientSecret);
    expect(body.get("redirect_uri")).toBe("https://stubwise.test/cb");
    expect(tokens).toEqual({
      accessToken: "at-1",
      expiresInSeconds: 3599,
      refreshToken: "rt-1",
      scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"],
      tokenType: "Bearer",
      idToken: "idt",
    });
  });

  it("segnala l'assenza del refresh token con refreshToken null (non con un errore)", async () => {
    const { impl } = fakeFetch([jsonResponse({ access_token: "at", expires_in: 3599, token_type: "Bearer" })]);
    const tokens = await exchangeCode({ ...CREDS, code: "c", redirectUri: "https://x.test/cb" }, { fetchImpl: impl });
    expect(tokens.refreshToken).toBeNull();
    expect(tokens.scopes).toEqual([]);
    expect(tokens.idToken).toBeNull();
  });

  it("401 invalid_grant è FATALE: il refresh token non tornerà buono da solo", async () => {
    const { impl } = fakeFetch([
      jsonResponse({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 401 }),
    ]);
    const error = await exchangeCode({ ...CREDS, code: "c", redirectUri: "https://x.test/cb" }, { fetchImpl: impl }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(GoogleApiError);
    const api = error as GoogleApiError;
    expect(api.status).toBe(401);
    expect(api.code).toBe("invalid_grant");
    expect(api.reason).toBe("invalid_grant");
    expect(isFatalGoogleError(api)).toBe(true);
  });
});

describe("refreshAccessToken", () => {
  it("posta grant_type=refresh_token", async () => {
    const { impl, calls } = fakeFetch([
      jsonResponse({ access_token: "at-2", expires_in: 3599, scope: "openid", token_type: "Bearer" }),
    ]);
    const tokens = await refreshAccessToken({ ...CREDS, refreshToken: "rt-9" }, { fetchImpl: impl });
    const body = new URLSearchParams(calls[0]?.body ?? "");
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-9");
    expect(tokens.accessToken).toBe("at-2");
  });

  it("429 con Retry-After: 7 è TRANSITORIO e porta retryAfterMs 7000", async () => {
    const { impl } = fakeFetch([
      jsonResponse({ error: "rate_limit_exceeded" }, { status: 429, headers: { "retry-after": "7" } }),
    ]);
    const error = await refreshAccessToken({ ...CREDS, refreshToken: "rt" }, { fetchImpl: impl }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleApiError);
    const api = error as GoogleApiError;
    expect(api.status).toBe(429);
    expect(api.code).toBe("rate_limited");
    expect(api.retryAfterMs).toBe(7000);
    expect(isFatalGoogleError(api)).toBe(false);
  });

  it("403 con scope insufficienti è fatale", async () => {
    const { impl } = fakeFetch([
      jsonResponse(
        { error: { code: 403, message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }] } },
        { status: 403 },
      ),
    ]);
    const error = await refreshAccessToken({ ...CREDS, refreshToken: "rt" }, { fetchImpl: impl }).catch((e: unknown) => e);
    expect((error as GoogleApiError).code).toBe("insufficient_scope");
    expect((error as GoogleApiError).reason).toBe("insufficientPermissions");
    expect(isFatalGoogleError(error)).toBe(true);
  });

  it("un 500 è transitorio anche senza Retry-After", async () => {
    const { impl } = fakeFetch([new Response("<html>oops</html>", { status: 503 })]);
    const error = await refreshAccessToken({ ...CREDS, refreshToken: "rt" }, { fetchImpl: impl }).catch((e: unknown) => e);
    expect((error as GoogleApiError).code).toBe("server_error");
    expect((error as GoogleApiError).retryAfterMs).toBeUndefined();
    expect(isFatalGoogleError(error)).toBe(false);
  });
});

describe("revokeToken", () => {
  it("posta il token all'endpoint di revoca", async () => {
    const { impl, calls } = fakeFetch([new Response("", { status: 200 })]);
    await revokeToken({ token: "rt-to-kill" }, { fetchImpl: impl });
    expect(calls[0]?.url).toBe("https://oauth2.googleapis.com/revoke");
    expect(calls[0]?.method).toBe("POST");
    expect(new URLSearchParams(calls[0]?.body ?? "").get("token")).toBe("rt-to-kill");
  });
});

describe("fetchUserinfo", () => {
  it("chiama userinfo con l'access token nell'header Authorization", async () => {
    const { impl, calls } = fakeFetch([
      jsonResponse({ sub: "1234", email: "ada@acme.test", email_verified: true, hd: "acme.test", name: "Ada" }),
    ]);
    const info = await fetchUserinfo({ accessToken: "at-3" }, { fetchImpl: impl });
    expect(calls[0]?.url).toBe("https://openidconnect.googleapis.com/v1/userinfo");
    expect(calls[0]?.headers.authorization).toBe("Bearer at-3");
    expect(info).toEqual({ sub: "1234", email: "ada@acme.test", emailVerified: true, hd: "acme.test", name: "Ada" });
  });

  it("normalizza l'email in minuscolo", async () => {
    const { impl } = fakeFetch([jsonResponse({ sub: "1", email: "Ada@ACME.test" })]);
    const info = await fetchUserinfo({ accessToken: "at" }, { fetchImpl: impl });
    expect(info.email).toBe("ada@acme.test");
    expect(info.hd).toBeNull();
  });

  it("una risposta senza i campi attesi è un errore tipizzato, non un crash di parsing", async () => {
    const { impl } = fakeFetch([jsonResponse({ nope: true })]);
    const error = await fetchUserinfo({ accessToken: "at" }, { fetchImpl: impl }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleApiError);
    expect((error as GoogleApiError).code).toBe("invalid_response");
  });
});
