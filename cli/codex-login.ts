// Parse only the public device challenge, never the resulting credentials.
export function deviceChallenge(output: string): { url: string; code: string } | null {
  const text = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const url = text.match(/https:\/\/auth\.openai\.com\/codex\/device\b/)?.[0];
  const code = text.match(/^\s*([A-Z0-9]{4}-[A-Z0-9]{5}|[A-Z0-9]{4}-[A-Z0-9]{4})[ \t]*\r?\n/m)?.[1];
  return url && code ? { url, code } : null;
}
