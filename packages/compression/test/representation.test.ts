/* eslint-disable init-declarations */
import { Compression, isCompressible, skipCompression } from "../index.js";
import { type ContentType, type Context, type IBindenOptions } from "binden";
import {
  type IServed,
  fetchRaw,
  gzips,
  none,
  serve,
  sleep,
  text,
  within,
} from "./helpers.js";
import { PassThrough, type Readable } from "node:stream";
import { after, afterEach, before, mock, suite, test } from "node:test";
import fsp, {
  type FileHandle,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { deepStrictEqual } from "node:assert/strict";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";

/** A promise with its `resolve()` */
function gate(): { promise: Promise<void>; open(): void } {
  const { promise, resolve } = Promise.withResolvers<never>();
  return { promise, open: resolve as () => void };
}

/**
 * The streams of the files that `open()` opens read once `reading` resolves,
 * or fail before their first chunk with `reading` (an error): the streams
 * created so far
 */
function delayReads(reading: Error | Promise<void>): Readable[] {
  const streams: Readable[] = [];
  const { open } = fsp;
  mock.method(
    fsp,
    "open",
    async (...args: Parameters<typeof open>): Promise<FileHandle> => {
      const handle = await open(...args);
      const create = handle.createReadStream.bind(handle);
      handle.createReadStream = ((
        ...options: Parameters<FileHandle["createReadStream"]>
      ) => {
        const stream = create(...options);
        const proxy = new PassThrough();
        streams.push(proxy);
        proxy.once("close", () => {
          stream.destroy();
        });
        if (reading instanceof Error) {
          process.nextTick(() => {
            proxy.destroy(reading);
          });
        } else {
          reading
            .then(() => {
              stream.pipe(proxy);
            })
            .catch(() => null);
        }
        return proxy;
      }) as unknown as FileHandle["createReadStream"];
      return handle;
    },
  );
  syncBuiltinESMExports();
  return streams;
}

const gzip = { "Accept-Encoding": "gzip" };

suite("The representation chosen before the commit", () => {
  let tmp: string;
  let file: string;
  const content = text(4096);
  const reply = text(2048);
  const validator = `"v1"`;
  const servers: IServed[] = [];

  const start = async (
    app: IBindenOptions,
    compression: Compression,
    handler: (context: Context) => Promise<void>,
  ): Promise<string> => {
    const served = await serve({ app }, compression, handler);
    servers.push(served);
    return served.url;
  };

  before(async () => {
    tmp = await realpath(await mkdtemp(join(tmpdir(), "binden-compression-")));
    file = join(tmp, "file.txt");
    await writeFile(file, content);
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  afterEach(async () => {
    mock.restoreAll();
    syncBuiltinESMExports();
    await Promise.all(servers.splice(0).map(async (served) => served.close()));
  });

  test("`sendFile()`: the choice sends no header and creates no compressor, the commit applies it", async () => {
    const reading = gate();
    const streams = delayReads(reading.promise);
    const states: unknown[] = [];
    let filtered = 0;
    const compression = new Compression({
      filter: (_context: Context, type: ContentType | null): boolean => {
        filtered += 1;
        return isCompressible(type);
      },
    });
    const created = await gzips(async (compressors) => {
      const url = await start({}, compression, async (context: Context) => {
        const { response } = context;
        const sent = response.sendFile(file, { validator });
        // Chosen, and its stream created
        await within(
          (async (): Promise<void> => {
            while (streams.length === 0) {
              await sleep(5);
            }
          })(),
        );
        states.push(
          response.headersSent,
          response.getHeader("Content-Encoding"),
          response.getHeader("Vary"),
          response.getHeader("ETag"),
          filtered,
          compressors.length,
        );
        reading.open();
        await sent;
      });
      const received = await fetchRaw(url, { headers: gzip });
      deepStrictEqual(
        [
          received.status,
          received.headers["content-encoding"],
          received.headers.vary,
          received.headers.etag,
          received.body,
        ],
        [200, "gzip", "Accept-Encoding", `W/${validator}`, content],
      );
    });
    deepStrictEqual(states, [false, none, none, validator, 1, 0]);
    // Not decided again by the commit
    deepStrictEqual([filtered, created.length], [1, 1]);
  });

  test("`sendFile()`: a refused representation does not read the file", async () => {
    const streams = delayReads(Promise.resolve());
    const url = await start({}, new Compression(), async (context: Context) => {
      await context.response.sendFile(file, { validator });
    });
    const refused = await fetchRaw(url, {
      headers: { "Accept-Encoding": "identity;q=0" },
    });
    deepStrictEqual(
      [refused.status, refused.headers["content-length"], streams.length],
      [406, "0", 0],
    );
    const sent = await fetchRaw(url, { headers: gzip });
    deepStrictEqual(
      [sent.status, sent.body, streams.length],
      [200, content, 1],
    );
  });

  test("a deadline before the first chunk: the reply of the error handler is not the chosen representation", async () => {
    delayReads(gate().promise);
    const url = await start(
      {
        timeout: 50,
        error_handler: async (context: Context): Promise<void> => {
          skipCompression(context.response);
          context.response.status(503);
          await context.text(reply);
        },
      },
      new Compression(),
      async (context: Context) => {
        await context.response.sendFile(file, { validator });
      },
    );
    const received = await fetchRaw(url, { headers: gzip });
    deepStrictEqual(
      [
        received.status,
        received.headers["content-encoding"],
        received.headers.etag,
        received.raw.toString(),
      ],
      [503, none, none, reply],
    );
  });

  test("a stream that fails before its first chunk: the error reply is not the chosen representation", async () => {
    delayReads(new Error("Failed"));
    const failures: unknown[] = [];
    const url = await start(
      {
        error_handler: async (context: Context, error: unknown) => {
          failures.push((error as Error).message);
          skipCompression(context.response);
          context.response.status(500);
          await context.text(reply);
        },
      },
      new Compression(),
      async (context: Context) => {
        await context.response.sendFile(file, { validator });
      },
    );
    const received = await fetchRaw(url, { headers: gzip });
    deepStrictEqual(
      [
        received.status,
        received.headers["content-encoding"],
        received.raw.toString(),
      ],
      [500, none, reply],
    );
    deepStrictEqual(failures, ["Failed"]);
  });
});
