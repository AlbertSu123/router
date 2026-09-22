import { expect, test } from "bun:test";

// launchd restarts a service only when its process exits, so a SIGTERM that
// stops the listener but leaves the process alive takes the service down for
// good. The child holds an open stream and a timer, which kept it alive before.
test("SIGTERM exits the process even while a client holds a stream open", async () => {
  const child = Bun.spawn(["bun", "-e", `
    import { exitOnSigterm } from ${JSON.stringify(`${import.meta.dir}/common.ts`)};
    const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("x")); } })) });
    setInterval(() => {}, 1000);
    exitOnSigterm(server);
    console.log(server.port);
  `], { stdout: "pipe" });
  const reader = child.stdout.getReader();
  const port = Number(new TextDecoder().decode((await reader.read()).value).trim());
  const stream = await fetch(`http://127.0.0.1:${port}/`);
  await stream.body!.getReader().read();
  const start = Date.now();
  child.kill("SIGTERM");
  expect(await child.exited).toBe(0);
  expect(Date.now() - start).toBeLessThan(17000);
}, 25000);
