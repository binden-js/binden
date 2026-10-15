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
import { deepEqual, equal, ok, rejects, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import multipart, {
  type IFileInfo,
  type IMultipartOptions,
  Multipart,
} from "../index.js";
import { request as httpRequest } from "node:http";

/** A middleware that keeps the entries of the form: a file as its name */
function keep(parsed: unknown[]): (context: Context) => Promise<void> {
  return async (context: Context): Promise<void> => {
    for (const [name, value] of context.request.body as FormData) {
      parsed.push([name, typeof value === "string" ? value : value.name]);
    }
    await context.send();
  };
}

/** A form of a text file, a field and an image */
const form = body(
  part('name="text"; filename="a.txt"', "text"),
  part('name="field"', "value"),
  part('name="image"; filename="b.png"', "png", ["Content-Type: image/png"]),
);

describe("Multipart (file_filter)", () => {
  it("refuses a request of a filtered file with `415`", async (t) => {
    let reached = false;
    const { url } = await serve(t, [
      multipart({ file_filter: ({ mime_type }) => mime_type === "image/png" }),
      (): void => {
        reached = true;
      },
    ]);

    const reply = await post(url, form);

    deepEqual([reply.status, reply.headers.connection], [415, "close"]);
    equal(reached, false);
  });

  it('drops the filtered files with `filtered: "skip"`', async (t) => {
    const parsed: unknown[] = [];
    const infos: unknown[] = [];
    const { url } = await serve(t, [
      multipart({
        filtered: "skip",
        file_filter: (info: IFileInfo, context: Context): boolean => {
          infos.push(info, context.request.method);
          return info.mime_type === "image/png";
        },
      }),
      keep(parsed),
    ]);

    const reply = await post(url, form);

    equal(reply.status, 200);
    deepEqual(parsed, [
      ["field", "value"],
      ["image", "b.png"],
    ]);
    deepEqual(infos, [
      {
        field: "text",
        filename: "a.txt",
        mime_type: "text/plain",
        encoding: "7bit",
      },
      "POST",
      {
        field: "image",
        filename: "b.png",
        mime_type: "image/png",
        encoding: "7bit",
      },
      "POST",
    ]);
  });

  it("awaits a `file_filter` that returns a `Promise`, and keeps the order of the parts", async (t) => {
    const parsed: unknown[] = [];
    const { url } = await serve(t, [
      multipart({
        file_filter: async ({ field }): Promise<boolean> => {
          await sleep(field === "text" ? 30 : 0);
          return true;
        },
      }),
      keep(parsed),
    ]);

    const reply = await post(url, form);

    equal(reply.status, 200);
    deepEqual(parsed, [
      ["text", "a.txt"],
      ["field", "value"],
      ["image", "b.png"],
    ]);
  });

  it("still applies the limits to a skipped file", async (t) => {
    const { url } = await serve(t, [
      multipart({
        filtered: "skip",
        file_filter: () => false,
        config: { limits: { fileSize: 4096 } },
      }),
    ]);

    // The limit is reached by the second chunk, once the file is skipped
    const data = body(part('name="a"; filename="a.bin"', "a".repeat(8192)));
    const reply = await new Promise<number | undefined>((resolve, reject) => {
      const client = httpRequest(url, {
        method: "POST",
        headers: { "Content-Type": type, "Content-Length": data.length },
        signal: AbortSignal.timeout(5000),
      });
      client
        .once("response", (response) => {
          response.resume();
          resolve(response.statusCode);
        })
        .once("error", reject)
        .write(data.slice(0, 1024));
      setTimeout(() => {
        client.end(data.slice(1024));
      }, 50);
    });

    equal(reply, 413);
  });

  it("replies `500` to a result that is not a boolean", async (t) => {
    let result: unknown = null;
    const { url } = await serve(t, [
      multipart({ file_filter: () => result as boolean }),
    ]);

    const statuses: number[] = [];
    for (const value of ["yes", 1, null, Promise.resolve("true")]) {
      result = value;
      statuses.push((await post(url, form)).status);
    }

    deepEqual(statuses, [500, 500, 500, 500]);
  });

  it("replies with the status of a failure of `file_filter` (`500` but for a `BindenError`)", async (t) => {
    let fail = (): Promise<boolean> => Promise.resolve(true);
    const { url } = await serve(t, [multipart({ file_filter: () => fail() })]);

    const statuses: number[] = [];
    for (const failure of [
      (): Promise<boolean> => {
        throw new BindenError(403);
      },
      (): Promise<boolean> => {
        throw new Error("A failure");
      },
      (): Promise<boolean> => Promise.reject(new BindenError(422)),
      async (): Promise<boolean> => {
        await sleep(1);
        throw new TypeError("A late failure");
      },
    ]) {
      fail = failure;
      statuses.push((await post(url, form)).status);
    }

    deepEqual(statuses, [403, 500, 422, 500]);
  });

  it("stops awaiting a `file_filter` that never settles once the request is aborted", async (t) => {
    const { promise: settled, resolve: settle } =
      Promise.withResolvers<unknown>();
    const parser = new Multipart({ file_filter: never });
    const { url } = await serve(
      t,
      [
        async (context: Context): Promise<void> => {
          await parser.run(context).catch((error: unknown) => {
            settle(error);
            throw error;
          });
        },
      ],
      { timeout: 100 },
    );

    const reply = await upload(url, part('name="a"; filename="a"', "a"));
    const error = await within(settled);

    deepEqual(reply, [503, "close"]);
    ok(error instanceof BindenAbortError);
    equal(error.reason, "deadline");
  });

  it("refuses an invalid `file_filter` or `filtered`", () => {
    const invalid: [unknown, Error][] = [
      [{ file_filter: true }, new TypeError("`file_filter` is not a function")],
      [
        { filtered: "drop" },
        new TypeError('`filtered` is not "reject" or "skip"'),
      ],
    ];
    for (const [options, error] of invalid) {
      throws(() => new Multipart(options as IMultipartOptions), error);
    }
  });
});

describe("race()", () => {
  it("settles like the result, unless the signal is aborted first", async () => {
    const { race } = await import("../src/race.js");
    const controller = new AbortController();
    const reason = new Error("aborted");
    const called: string[] = [];

    equal(await race(() => 1, controller.signal), 1);
    equal(await race(() => Promise.resolve(2), controller.signal), 2);
    await rejects(
      race(() => {
        throw new Error("thrown");
      }, controller.signal),
      new Error("thrown"),
    );
    const pending = race(never, controller.signal);
    controller.abort(reason);
    await rejects(within(pending), reason);
    await rejects(
      race(() => {
        called.push("called");
      }, controller.signal),
      reason,
    );
    deepEqual(called, []);
  });
});
