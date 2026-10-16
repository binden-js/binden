// Run by `process.test.ts` with `--expose-gc`: the file of a `sendFile()`
// whose send is cancelled, or would be ignored, while the file is opened or
// its metadata read (an error handler that fails or times out, a deadline
// once the headers are flushed) is closed by binden, never left to the
// collection of its handle (which crashes Node.js 26, and warns on Node.js
// 24), and no descriptor is left open. Prints what each request has got, and
// what is left.
import { Binden, type Context } from "../../index.js";
import { existsSync, readdirSync } from "node:fs";
import fsp, { type FileHandle, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { once } from "node:events";
import { request } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 20_000).unref();

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const warnings: string[] = [];
process.on("warning", ({ name, message }) => {
  warnings.push(`${name}: ${message}`);
});

/** The open descriptors of the process (none where `/dev/fd` is missing, e.g. on Windows) */
function descriptors(): number {
  return existsSync("/dev/fd") ? readdirSync("/dev/fd").length : 0;
}

const tmp = await mkdtemp(join(tmpdir(), "binden-release-"));
const file = join(tmp, "page.html");
await writeFile(file, "<p>error</p>");

/**
 * What the requests of a scenario have done: the handles that their
 * `sendFile()` has opened (and the opens still pending), the streams that it
 * has created of them, and how it has settled
 */
interface IScenario {
  readonly slow: boolean;
  readonly handles: FileHandle[];
  opening: number;
  streams: number;
  readonly outcomes: string[];
}

const scenario = (slow: boolean): IScenario => ({
  slow,
  handles: [],
  opening: 0,
  streams: 0,
  outcomes: [],
});

/** The scenario of the requests sent now (an open or a send keeps its own) */
let current = scenario(false);
const { open } = fsp;
fsp.open = async (...args: Parameters<typeof open>): Promise<FileHandle> => {
  const of = current;
  of.opening += 1;
  try {
    const handle = await open(...args);
    of.handles.push(handle);
    const stat = handle.stat.bind(handle);
    handle.stat = (async () => {
      if (of.slow) {
        // As on a slow disk
        await sleep(100);
      }
      return stat();
    }) as FileHandle["stat"];
    const create = handle.createReadStream.bind(handle);
    handle.createReadStream = (
      ...options: Parameters<FileHandle["createReadStream"]>
    ): ReturnType<FileHandle["createReadStream"]> => {
      of.streams += 1;
      return create(...options);
    };
    return handle;
  } finally {
    of.opening -= 1;
  }
};
syncBuiltinESMExports();

/** Records how a `sendFile()` settles */
const track = (sent: Promise<void>): Promise<void> => {
  const { outcomes } = current;
  sent.then(
    () => {
      outcomes.push("resolved");
    },
    (error: unknown) => {
      const { code, message } = error as { code?: unknown; message?: unknown };
      outcomes.push(`rejected:${String(code ?? message)}`);
    },
  );
  return sent;
};

const app = new Binden({
  timeout: 0,
  error_handler_timeout: 30,
  error_handler: async (context: Context): Promise<void> => {
    const { pathname } = context.url;
    if (pathname === "/throws") {
      // Started, then the handler fails before it awaits it
      track(context.response.sendFile(file)).catch(() => null);
      throw new Error("handler fails");
    } else if (pathname === "/all") {
      // E.g. an audit that fails while the page is sent
      await Promise.all([
        track(context.response.sendFile(file)),
        Promise.reject(new Error("audit fails")),
      ]);
    } else {
      // `/expired`: the metadata comes after `error_handler_timeout`
      await track(context.response.sendFile(file));
    }
  },
}).use(async (context: Context) => {
  if (context.url.pathname === "/flushed") {
    // The deadline passes while the metadata is read: it cancels nothing
    // once the headers are sent, and cuts the response
    context.setTimeout(30);
    context.response.flushHeaders();
    await track(context.response.sendFile(file));
    return;
  }
  throw new Error("The route fails");
});

const server = app.createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address() as AddressInfo;

/** The status of a response, `(cut)` when its connection closes before its end */
const get = (path: string): Promise<string> =>
  new Promise((resolve) => {
    request({ agent: false, path, port, host: "127.0.0.1" }, (response) => {
      response.resume();
      response.once("end", () => {
        resolve(String(response.statusCode));
      });
      response.once("error", () => {
        resolve(`${response.statusCode}(cut)`);
      });
    })
      .once("error", () => {
        resolve("cut");
      })
      .end();
  });

/**
 * Whether every `sendFile()` of a scenario has settled, and every file that
 * they have opened is closed, within 2 s
 */
const settled = async (of: IScenario, requests: number): Promise<boolean> => {
  const deadline = Date.now() + 2000;
  while (
    of.outcomes.length < requests ||
    of.opening > 0 ||
    of.handles.some(({ fd }) => fd !== -1)
  ) {
    if (Date.now() > deadline) {
      return false;
    }
    await sleep(5);
  }
  return true;
};

const before = descriptors();
const lines: string[] = [];
for (const [path, slow] of [
  ["/throws", false],
  ["/all", false],
  ["/expired", true],
  ["/flushed", true],
] as const) {
  current = scenario(slow);
  const statuses = new Set<string>();
  // A file that one request leaves open would show up three times
  const requests = 3;
  for (let index = 0; index < requests; index += 1) {
    statuses.add(await get(path));
  }
  const closed = await settled(current, requests);
  const { outcomes, streams, handles } = current;
  const left = handles.filter(({ fd }) => fd !== -1).length;
  lines.push(
    `${path} ${[...statuses].join(",")} ${[...new Set(outcomes)].join(",")} streams=${streams} ${closed ? "closed" : `open=${left}`}`,
  );
}
server.close();
await sleep(50);
const growth = descriptors() - before;

// What a handle that is still open would do once it is collected
const gc = Reflect.get(globalThis, "gc") as () => void;
for (let round = 0; round < 3; round += 1) {
  gc();
  await sleep(20);
}
await rm(tmp, { recursive: true, force: true });
process.stdout.write(
  `${lines.join("\n")}\nfd growth=${Math.max(growth, 0)} warnings=${JSON.stringify(warnings)}\n`,
);
