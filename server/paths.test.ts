import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { antigravityCredentialPath, mainAntigravityHome } from "./paths";

let savedGeminiHome: string | undefined;

beforeEach(() => {
  savedGeminiHome = process.env.GEMINI_HOME;
});

afterEach(() => {
  if (savedGeminiHome === undefined) delete process.env.GEMINI_HOME;
  else process.env.GEMINI_HOME = savedGeminiHome;
});

describe("Antigravity paths", () => {
  it("uses the operating system HOME for the CLI login", () => {
    expect(mainAntigravityHome()).toBe(homedir());
    // GEMINI_HOME belongs to the ACP runtime, not the native CLI's account selector.
    process.env.GEMINI_HOME = "/tmp/not-antigravity";
    expect(mainAntigravityHome()).toBe(homedir());
  });

  it("points at the CLI-owned credential file for main and managed homes", () => {
    const suffix = join(".gemini", "antigravity-cli", "antigravity-oauth-token");
    expect(antigravityCredentialPath(null)).toBe(join(homedir(), suffix));
    expect(antigravityCredentialPath("/homes/antigravity-a")).toBe(join("/homes/antigravity-a", suffix));
  });
});
