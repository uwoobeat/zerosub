import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;
let savedPaseoHome: string | undefined;

beforeEach(async () => {
  savedPaseoHome = process.env.PASEO_HOME;
  root = await mkdtemp(join(tmpdir(), "zerosub-binaries-"));
  process.env.PASEO_HOME = root;
  vi.resetModules();
});

afterEach(async () => {
  if (savedPaseoHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = savedPaseoHome;
  await rm(root, { recursive: true, force: true });
});

async function providerCommand(provider: "claude" | "codex" | "antigravity") {
  const module = await import("./binaries");
  return module.providerCommand(provider);
}

describe("providerCommand", () => {
  it("maps Antigravity to agy when Paseo has no command override", async () => {
    expect(await providerCommand("antigravity")).toEqual({ command: "agy", prefix: [] });
    expect(await providerCommand("claude")).toEqual({ command: "claude", prefix: [] });
    expect(await providerCommand("codex")).toEqual({ command: "codex", prefix: [] });
  });

  it("keeps a configured wrapper and its prefix arguments", async () => {
    await writeFile(
      join(root, "config.json"),
      JSON.stringify({
        agents: {
          providers: {
            antigravity: { command: ["agy-wrapper", "--profile", "work"] },
          },
        },
      }),
    );

    expect(await providerCommand("antigravity")).toEqual({ command: "agy-wrapper", prefix: ["--profile", "work"] });
  });

  it("falls back to the provider defaults when the command is malformed", async () => {
    await writeFile(
      join(root, "config.json"),
      JSON.stringify({ agents: { providers: { antigravity: { command: ["agy", 7] } } } }),
    );
    expect(await providerCommand("antigravity")).toEqual({ command: "agy", prefix: [] });
  });
});
