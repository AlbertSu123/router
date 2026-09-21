import { expect, test } from "bun:test";
import { deviceChallenge } from "./codex-login.ts";

test("extracts the device challenge from Codex's ANSI terminal prompt", () => {
  const output = "Open this link\n  \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\nEnter this one-time code (expires in 15 minutes)\n  \x1b[94mABCD-12345\x1b[0m\n";
  expect(deviceChallenge(output)).toEqual({url: "https://auth.openai.com/codex/device", code: "ABCD-12345"});
});
test("waits for a complete challenge and rejects other hosts", () => {
  expect(deviceChallenge("https://auth.openai.com/codex/device\nABCD-")).toBeNull();
  expect(deviceChallenge("https://example.com/codex/device\nABCD-12345\n")).toBeNull();
});
