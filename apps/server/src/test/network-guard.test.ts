import { describe, expect, it } from "vitest";
import { isLocalHost } from "./network-guard.js";

/**
 * Cosa la guardia di rete considera LOCALE (cioè lascia passare). Un host
 * remoto ammesso per sbaglio è una chiamata di rete vera da un test; un host
 * locale rifiutato è un test con un server di prova che fallisce senza motivo.
 */
describe("isLocalHost", () => {
  const noEnv = {};

  it("loopback: tutto 127.0.0.0/8, localhost, *.localhost, ::1, 0.0.0.0", () => {
    for (const host of ["127.0.0.1", "127.0.0.2", "127.255.255.254", "localhost", "api.localhost", "::1", "[::1]", "0.0.0.0"]) {
      expect(isLocalHost(host, noEnv)).toBe(true);
    }
  });

  it("tutto il resto no: provider, IP privati, finti loopback", () => {
    for (const host of ["api.github.com", "api.bitbucket.org", "10.0.0.5", "128.0.0.1", "127.0.0.256", "127.0.0.1.evil.com", "localhost.evil.com"]) {
      expect(isLocalHost(host, noEnv)).toBe(false);
    }
  });

  it("l'host di DOCKER_HOST (tcp://…) è ammesso, solo lui", () => {
    const env = { DOCKER_HOST: "tcp://10.0.0.5:2375" };
    expect(isLocalHost("10.0.0.5", env)).toBe(true);
    expect(isLocalHost("10.0.0.6", env)).toBe(false);
  });

  it("DOCKER_HOST su socket unix non ammette niente in più", () => {
    expect(isLocalHost("var", { DOCKER_HOST: "unix:///var/run/docker.sock" })).toBe(false);
  });

  it("TESTCONTAINERS_HOST_OVERRIDE (un host nudo) è ammesso", () => {
    const env = { TESTCONTAINERS_HOST_OVERRIDE: "docker.internal.test" };
    expect(isLocalHost("docker.internal.test", env)).toBe(true);
    expect(isLocalHost("api.github.com", env)).toBe(false);
  });

  it("variabili vuote o assenti non ammettono la stringa vuota", () => {
    expect(isLocalHost("", { DOCKER_HOST: "", TESTCONTAINERS_HOST_OVERRIDE: "  " })).toBe(false);
  });
});
