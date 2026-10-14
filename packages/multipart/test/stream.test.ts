import { BindenAbortError, BindenError, type Context } from "binden";
import {
  body,
  never,
  part,
  post,
  serve,
  sleep,
  type,
  upload,
  within,
} from "./helpers.js";
import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import multipart, {
  type IMultipartOptions,
  type IStreamFile,
  Multipart,
} from "../index.js";
import type { Readable } from "node:stream";
import { request as httpRequest } from "node:http";
import { once } from "node:events";

/** The content of a stream */
async function read(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString();
}

/** A middleware that keeps the entries of the form */
function keep(parsed: unknown[]): (context: Context) => Promise<void> {
  return async (context: Context): Promise<void> => {
    parsed.push([...(context.request.body as FormData)]);
    await context.send();
  };
}

/** A form of two files and two fields */
const form = body(
  part('name="a"; filename="a.txt"', "Hello"),
  part('name="f1"', "v1"),
  part('name="b"; filename="b.png"', "World", ["Content-Type: image/png"]),
  part('name="f2"', "v2"),
);

describe("Multipart (stream storage)", () => {
  it("streams the files to `on_file`, and awaits it", async (t) => {
    const handled: unknown[] = [];
    const parsed: unknown[] = [];
    const { url } = await serve(t, [
      multipart({
        storage: {
          on_file: async (file: IStreamFile, context: Context) => {
            const { field, filename, mime_type, encoding } = file;
            const content = await read(file.stream);
            await sleep(20);
            handled.push([
              field,
              filename,
              mime_type,
              encoding,
              content,
              file.truncated(),
              context.request.method,
            ]);
          },
        },
      }),
      async (context: Context): Promise<void> => {
        parsed.push(handled.length);
        await keep(parsed)(context);
      },
    ]);

    const reply = await post(url, form);

    equal(reply.status, 200);
    deepEqual(handled, [
      ["a", "a.txt", "text/plain", "7bit", "Hello", false, "POST"],
      ["b", "b.png", "image/png", "7bit", "World", false, "POST"],
    ]);
    deepEqual(parsed, [
      2,
      [
        ["f1", "v1"],
        ["f2", "v2"],
      ],
    ]);
  });

  it("reads and discards what `on_file` has not read", async (t) => {
    const parsed: unknown[] = [];
    const { url } = await serve(t, [
      multipart({
        storage: {
          on_file: ({ field, stream }: IStreamFile): unknown => {
            if (field === "b") {
              // Paused once it has a chunk: the rest is not read
              return new Promise((resolve) => {
                stream.once("data", () => {
                  stream.pause();
                  resolve(null);
                });
              });
            }
            return null;
          },
        },
      }),
      keep(parsed),
    ]);

    const reply = await post(
      url,
      body(
        part('name="a"; filename="a.txt"', "Hello"),
        part('name="f1"', "v1"),
        part('name="b"; filename="b.txt"', "a".repeat(1 << 18)),
        part('name="f2"', "v2"),
      ),
    );

    equal(reply.status, 200);
    deepEqual(parsed, [
      [
        ["f1", "v1"],
        ["f2", "v2"],
      ],
    ]);
  });

  it("tells whether a file has been truncated (`throw_limits: false`)", async (t) => {
    const handled: unknown[] = [];
    const { url } = await serve(t, [
      multipart({
        throw_limits: false,
        config: { limits: { fileSize: 3 } },
        storage: {
          on_file: async (file: IStreamFile) => {
            handled.push([await read(file.stream), file.truncated()]);
          },
        },
      }),
    ]);

    await post(url, form);

    deepEqual(handled, [
      ["Hel", true],
      ["Wor", true],
    ]);
  });

  it("replies with the status of a failure of `on_file` (`500` but for a `BindenError`)", async (t) => {
    let fail = (): unknown => null;
    const { url } = await serve(t, [
      multipart({ storage: { on_file: () => fail() } }),
    ]);

    const statuses: number[] = [];
    for (const failure of [
      (): unknown => {
        throw new BindenError(422);
      },
      (): unknown => {
        throw new Error("A failure");
      },
      (): unknown => Promise.reject(new BindenError(507)),
      async (): Promise<unknown> => {
        await sleep(1);
        throw new TypeError("A late failure");
      },
    ]) {
      fail = failure;
      statuses.push((await post(url, form)).status);
    }

    deepEqual(statuses, [422, 500, 507, 500]);
  });

  it("replies to the client with the status of a failure in the middle of an upload", async (t) => {
    let received = 0;
    const { url } = await serve(t, [
      multipart({
        storage: {
          on_file: async ({ stream }: IStreamFile) => {
            const [chunk] = (await once(stream, "data")) as [Buffer];
            received += chunk.length;
            throw new BindenError(422);
          },
        },
      }),
    ]);

    // The body is never complete: the reply comes before it
    const reply = await upload(
      url,
      part('name="file"; filename="file.bin"', "a".repeat(1024)),
    );

    deepEqual(reply, [422, "close"]);
    ok(received > 0);
  });

  it("refuses the request when `on_file` destroys the stream", async (t) => {
    let error: Error | undefined = new BindenError(415);
    const { url } = await serve(t, [
      multipart({
        storage: {
          on_file: ({ stream }: IStreamFile): void => {
            stream.destroy(error);
          },
        },
      }),
    ]);

    const statuses = [(await post(url, form)).status];
    error = new Map<string, Error>().get("none");
    statuses.push((await post(url, form)).status);

    deepEqual(statuses, [415, 500]);
  });

  it("destroys the streams of a refused request", async (t) => {
    const { promise: closed, resolve: close } = Promise.withResolvers<null>();
    const { url } = await serve(t, [
      multipart({
        limit: 1 << 16,
        storage: {
          on_file: async ({ field, stream }: IStreamFile) => {
            if (field === "b") {
              await read(stream);
            } else {
              // Not read: busboy has pushed it whole, and gone on
              await once(stream, "close");
              close(null);
            }
          },
        },
      }),
    ]);

    // The request is refused by the second chunk
    const data = body(
      part('name="a"; filename="a.txt"', "a"),
      part('name="b"; filename="b.bin"', "b".repeat(1 << 17)),
    );
    const reply = await new Promise<number | undefined>((resolve, reject) => {
      const client = httpRequest(url, {
        method: "POST",
        headers: { "Content-Type": type, "Transfer-Encoding": "chunked" },
        signal: AbortSignal.timeout(5000),
      });
      client
        .once("response", (response) => {
          response.resume();
          resolve(response.statusCode);
          client.destroy();
        })
        .once("error", reject)
        .write(data.slice(0, 1024));
      setTimeout(() => {
        client.write(data.slice(1024));
      }, 50);
    });

    equal(reply, 413);
    equal(await within(closed), null);
  });

  it("stops awaiting an `on_file` that never settles once the request is aborted", async (t) => {
    const { promise: settled, resolve: settle } =
      Promise.withResolvers<unknown>();
    const parser = new Multipart({ storage: { on_file: never } });
    const { url } = await serve(t, [
      async (context: Context): Promise<void> => {
        await parser.run(context).then(settle, settle);
      },
    ]);

    const client = httpRequest(url, {
      method: "POST",
      headers: { "Content-Type": type },
    });
    client.on("error", () => {
      // The connection is closed on purpose
    });
    client.end(form);
    await sleep(50);
    client.destroy();

    const error = await within(settled);
    ok(error instanceof BindenError);
    ok(error.cause instanceof BindenAbortError);
    deepEqual(
      [error.status, error.code, error.cause.reason],
      [400, "aborted", "client_closed"],
    );
  });

  it("refuses an invalid `storage`", () => {
    const invalid: [unknown, Error][] = [
      ["disk", new TypeError("`storage` is not an object")],
      [{ on_file: null }, new TypeError("`storage.on_file` is not a function")],
      [
        { on_file: (): null => null, dir: "/tmp" },
        new TypeError("`storage.dir` and `storage.on_file` are exclusive"),
      ],
      [{ dir: "" }, new TypeError("`storage.dir` is not a non-empty string")],
      [{ dir: 1 }, new TypeError("`storage.dir` is not a non-empty string")],
      [
        { directory: "/tmp" },
        new TypeError("Unknown option: `storage.directory`"),
      ],
    ];
    for (const [storage, error] of invalid) {
      throws(() => new Multipart({ storage } as IMultipartOptions), error);
    }
  });
});
