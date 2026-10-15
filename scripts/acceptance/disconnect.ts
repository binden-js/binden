// Clients that go away in the middle of a request: of a body (also while `verify`
// never settles), of a multipart body in each storage (also while `on_file` never
// settles), of a file sent by `sendFile()`, and of a compressed stream. Each time,
// the work settles (nothing stays pending), `context.signal` is aborted
// (`client_closed`), the cleanups run, and nothing is left: no temporary file, no
// open file, no source that is not closed. A multipart body that is still read
// once the response has finished settles too when its client goes away (the
// signal is no longer aborted then), and the stream of its file is destroyed.
import { Binden, type Context, Router } from "binden";
import {
  closed,
  deadline,
  eventually,
  multipart,
  openFiles,
  outcome,
  read,
  reasonOf,
  serve,
  start,
} from "./helpers.js";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { BodyParser } from "@binden/body";
import { Compression } from "@binden/compression";
import { Multipart } from "@binden/multipart";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

deadline(30_000);

const dir = mkdtempSync(join(tmpdir(), "binden-acceptance-"));
process.once("exit", () => {
  rmSync(dir, { recursive: true, force: true });
});
const uploads = join(dir, "uploads");
const file = join(dir, "large.bin");
writeFileSync(file, Buffer.alloc(4 * 1024 * 1024, "a"));
mkdirSync(uploads);

/** What a scenario has observed once the cleanups of its request have run */
interface IObserved {
  outcome: string;
  signal: string | null;
}

/** A scenario: the server has reached the point where the client goes away */
interface IScenario {
  readonly reached: PromiseWithResolvers<null>;
  readonly observed: PromiseWithResolvers<IObserved>;
  /** Extra observations (e.g. whether a source has been closed) */
  readonly extra: Record<string, unknown>;
}

const scenarios = new Map<string, IScenario>();
function scenario(name: string): IScenario {
  const created: IScenario = {
    reached: Promise.withResolvers<null>(),
    observed: Promise.withResolvers<IObserved>(),
    extra: {},
  };
  scenarios.set(name, created);
  return created;
}

/**
 * A middleware that awaits `work` and, once the cleanups of the request run,
 * reports how it has settled (it must settle: the cleanup waits for it) and the
 * signal
 */
function observe(
  name: string,
  work: (context: Context, current: IScenario) => Promise<unknown>,
): (context: Context) => Promise<void> {
  const current = scenario(name);
  return async (context: Context): Promise<void> => {
    const settled = outcome(work(context, current));
    context.onCleanup(async () => {
      current.observed.resolve({
        outcome: await settled,
        signal: reasonOf(context.signal),
      });
    });
    await settled;
  };
}

/** A promise that never settles */
const never = <T>(): Promise<T> => Promise.withResolvers<T>().promise;

const MiB = 1024 * 1024;
const app = new Binden({ timeout: 30_000 })
  .use(
    "/body",
    observe("body", (context, current) => {
      current.reached.resolve(null);
      return new BodyParser({ limit: MiB }).run(context);
    }),
  )
  .use(
    "/verify",
    observe("verify never settles", (context, current) =>
      new BodyParser({
        limit: MiB,
        verify: (): Promise<never> => {
          current.reached.resolve(null);
          return never();
        },
      }).run(context),
    ),
  )
  .use(
    "/memory",
    observe("multipart (memory)", (context, current) => {
      current.reached.resolve(null);
      return new Multipart({ limit: 10 * MiB }).run(context);
    }),
  )
  .use(
    "/disk",
    observe("multipart (disk)", (context, current) =>
      new Multipart({
        limit: 10 * MiB,
        storage: { dir: uploads },
        file_filter: (): boolean => {
          current.reached.resolve(null);
          return true;
        },
      }).run(context),
    ),
  )
  .use(
    "/stream",
    observe("multipart (stream, on_file never settles)", (context, current) =>
      new Multipart({
        limit: 10 * MiB,
        storage: {
          on_file: (): Promise<never> => {
            current.reached.resolve(null);
            return never();
          },
        },
      }).run(context),
    ),
  )
  .use(
    "/after-response",
    observe("multipart after the response", (context, current) => {
      const parsed = new Multipart({
        limit: 10 * MiB,
        storage: {
          on_file: ({ stream }): Promise<void> => {
            current.reached.resolve(null);
            stream.resume();
            return finished(stream).then(
              () => {
                current.extra.stream = "ended";
              },
              () => {
                current.extra.stream = stream.destroyed
                  ? "destroyed"
                  : "failed";
              },
            );
          },
        },
      }).run(context);
      // Not awaited before the response: it finishes while the body is read
      return Promise.all([context.send("early"), parsed]);
    }),
  )
  .use(
    "/file",
    observe("sendFile", (context, current) => {
      current.reached.resolve(null);
      return context.sendFile(file);
    }),
  )
  .use(
    "/compressed",
    new Compression(),
    new Router().get(
      observe("compression", (context, current) => {
        function* source(): Generator<string> {
          try {
            for (let line = 0; ; line += 1) {
              yield `${String(line).padStart(8, "0")} ${"x".repeat(1000)}\n`;
              current.reached.resolve(null);
            }
          } finally {
            current.extra.source_closed = true;
          }
        }
        return context.type("text/plain").send(Readable.from(source()));
      }),
    ),
  );

const { server, port } = await serve(app);

const form = new FormData();
form.append("field", "value");
form.append("file", new File([Buffer.alloc(256 * 1024, "b")], "file.bin"));
const upload = await multipart(form);

/** The requests: the first bytes that the client sends, then it goes away */
const requests: [string, string, Record<string, string | number>, Buffer][] = [
  [
    "body",
    "/body",
    { "Content-Type": "application/json", "Content-Length": 1000 },
    Buffer.from('{"a":"'),
  ],
  [
    "verify never settles",
    "/verify",
    { "Content-Type": "application/json" },
    Buffer.from("{}"),
  ],
  ...(["/memory", "/disk", "/stream"] as const).map(
    (
      path,
      index,
    ): [string, string, Record<string, string | number>, Buffer] => [
      [
        "multipart (memory)",
        "multipart (disk)",
        "multipart (stream, on_file never settles)",
      ][index] ?? "",
      path,
      { "Content-Type": upload.type, "Content-Length": upload.body.length },
      upload.body.subarray(0, 64 * 1024),
    ],
  ),
];

/** The count of the files in the private directories of the requests */
const stored = (): number =>
  readdirSync(uploads).reduce(
    (count, request) => count + readdirSync(join(uploads, request)).length,
    0,
  );

const results: Record<string, unknown> = {};
for (const [name, path, headers, head] of requests) {
  const current = scenarios.get(name);
  if (typeof current === "undefined") {
    throw new Error(`No scenario ${name}`);
  }
  const files = openFiles();
  const { client } = start(port, path, { method: "POST", headers });
  client.on("error", () => {
    // The connection is closed on purpose
  });
  if (name === "verify never settles") {
    client.end(head);
  } else {
    client.write(head);
  }
  await current.reached.promise;
  if (path === "/disk") {
    // A part of the file is on the disk
    await eventually(() => stored() > 0, "the file is stored");
  }
  client.destroy();
  const observed = await current.observed.promise;
  await closed(files, name);
  results[name] = { ...observed, ...current.extra };
}
await eventually(
  () => readdirSync(uploads).length === 0,
  "the private directories of the requests are removed",
);
results.uploads_left = readdirSync(uploads).length;

// The response finishes while the multipart body is read: the client reads it,
// then goes away in the middle of its file
{
  const name = "multipart after the response";
  const current = scenarios.get(name);
  if (typeof current === "undefined") {
    throw new Error(`No scenario ${name}`);
  }
  const files = openFiles();
  const { client, response } = start(port, "/after-response", {
    method: "POST",
    headers: {
      "Content-Type": upload.type,
      "Content-Length": upload.body.length,
    },
  });
  client.on("error", () => {
    // The connection is closed on purpose
  });
  client.write(upload.body.subarray(0, 64 * 1024));
  const reply = await read(await response);
  await current.reached.promise;
  client.destroy();
  const observed = await current.observed.promise;
  await eventually(
    () => typeof current.extra.stream === "string",
    "the stream of the file has settled",
  );
  await closed(files, name);
  results[name] = { status: reply.status, ...observed, ...current.extra };
}

// The downloads: the client reads the first bytes, then goes away
for (const [name, path, headers] of [
  ["sendFile", "/file", {}],
  ["compression", "/compressed", { "Accept-Encoding": "gzip" }],
] as const) {
  const current = scenarios.get(name);
  if (typeof current === "undefined") {
    throw new Error(`No scenario ${name}`);
  }
  const files = openFiles();
  const { client, response } = start(port, path, { headers });
  client.on("error", () => {
    // The connection is closed on purpose
  });
  client.end();
  const started = await response;
  started.on("error", () => {
    // The connection is closed on purpose
  });
  await current.reached.promise;
  current.extra.encoding = started.headers["content-encoding"] ?? null;
  client.destroy();
  const observed = await current.observed.promise;
  await closed(files, name);
  results[name] = { ...observed, ...current.extra };
}

server.close();
process.stdout.write(`${JSON.stringify(results)}\n`);
