import { Agent, request as httpRequest } from "node:http";
import { Binden, BindenError, type Context } from "binden";
import {
  RecordingLogger,
  body,
  encode,
  listen,
  part,
  post,
  send,
  serve,
  type,
  upload,
} from "./helpers.js";
import { deepEqual, equal, ok } from "node:assert/strict";
import { describe, it } from "node:test";
import multipart, { Multipart } from "../index.js";
import { PassThrough } from "node:stream";
import { gzipSync } from "node:zlib";

/** The entries of a form: a file as its name, type and content */
async function entries(form: unknown): Promise<unknown[]> {
  ok(form instanceof FormData);
  const result: unknown[] = [];
  for (const [name, value] of form) {
    result.push(
      typeof value === "string"
        ? [name, value]
        : [name, value.name, value.type, await value.text()],
    );
  }
  return result;
}

/** A middleware that keeps the entries of the parsed form */
function keep(parsed: unknown[]): (context: Context) => Promise<void> {
  return async (context: Context): Promise<void> => {
    parsed.push(...(await entries(context.request.body)));
    await context.send();
  };
}

/** The limits of busboy, and a body that reaches each of them */
const limits = [
  ["fields", { fields: 1 }, [part('name="a"', "1"), part('name="b"', "2")]],
  [
    "files",
    { files: 1 },
    [part('name="a"; filename="a"', "1"), part('name="b"; filename="b"', "2")],
  ],
  ["parts", { parts: 1 }, [part('name="a"', "1"), part('name="b"', "2")]],
  ["fieldSize", { fieldSize: 3 }, [part('name="a"', "abcdef")]],
  ["fileSize", { fileSize: 3 }, [part('name="a"; filename="a"', "abcdef")]],
] as const;

describe("Multipart", () => {
  it("parses the fields and the files of a form, in their order", async (t) => {
    const form = new FormData();
    form.append("name1", "value11");
    form.append(
      "file1",
      new File(['{"hello":"world"}'], "file11.json", {
        type: "application/json",
      }),
    );
    form.append("name1", "value12");
    form.append(
      "file1",
      new File(["<html></html>"], "file12.html", { type: "text/html" }),
    );
    form.append("name2", "value2");
    form.append(
      "file2",
      new File(["Hello World"], "file2.txt", { type: "text/plain" }),
    );
    const parsed: unknown[] = [];
    const { url } = await serve(t, [multipart(), keep(parsed)]);

    const { body: data, type: content_type } = await encode(form);
    const reply = await post(url, data, { "Content-Type": content_type });

    equal(reply.status, 200);
    deepEqual(parsed, [
      ["name1", "value11"],
      ["file1", "file11.json", "application/json", '{"hello":"world"}'],
      ["name1", "value12"],
      ["file1", "file12.html", "text/html", "<html></html>"],
      ["name2", "value2"],
      ["file2", "file2.txt", "text/plain", "Hello World"],
    ]);
  });

  it("parses a `boundary` that comes after another parameter", async (t) => {
    const parsed: unknown[] = [];
    const { url } = await serve(t, [multipart(), keep(parsed)]);

    const reply = await post(url, body(part('name="field"', "value")), {
      "Content-Type": `multipart/form-data; charset=utf-8; boundary="binden-boundary"`,
    });

    equal(reply.status, 200);
    deepEqual(parsed, [["field", "value"]]);
  });

  it('names a part without a name `""`', async (t) => {
    const parsed: unknown[] = [];
    const { url } = await serve(t, [multipart(), keep(parsed)]);

    const reply = await post(
      url,
      body(part('name=""', "value"), part('filename="a.txt"', "file")),
    );

    equal(reply.status, 200);
    deepEqual(parsed, [
      ["", "value"],
      ["", "a.txt", "text/plain", "file"],
    ]);
  });

  it("skips the methods without a body", async (t) => {
    const bodies: unknown[] = [];
    const { url } = await serve(t, [
      multipart(),
      async (context: Context): Promise<void> => {
        bodies.push(typeof context.request.body);
        await context.send();
      },
    ]);

    for (const method of ["GET", "HEAD", "OPTIONS", "TRACE"]) {
      const reply = await send(url, {
        method,
        headers: { "Content-Type": type },
      });
      equal(reply.status, 200);
    }
    deepEqual(bodies, Array(4).fill("undefined"));
  });

  it("skips another media type, without reading its body", async (t) => {
    const read: unknown[] = [];
    const { url } = await serve(t, [
      multipart(),
      async (context: Context): Promise<void> => {
        const chunks: Buffer[] = [];
        for await (const chunk of context.request) {
          chunks.push(chunk as Buffer);
        }
        const text = Buffer.concat(chunks).toString();
        read.push([typeof context.request.body, text]);
        await context.send();
      },
    ]);

    const data = body(part('name="field"', "value"));
    for (const content_type of [
      null,
      "text/plain",
      "application/json; charset=utf-8",
      `multipart/mixed; boundary=binden-boundary`,
      `multipart/form-data-like; boundary=binden-boundary`,
    ]) {
      const headers =
        content_type === null ? {} : { "Content-Type": content_type };
      const reply = await send(url, { headers, body: data });
      equal(reply.status, 200);
    }
    deepEqual(read, Array(5).fill(["undefined", data]));
  });

  it("skips a request that has already been parsed", async (t) => {
    const parsed: unknown[] = [];
    const { url } = await serve(t, [
      new Multipart(),
      new Multipart(),
      keep(parsed),
    ]);

    const reply = await post(url, body(part('name="field"', "value")));

    equal(reply.status, 200);
    deepEqual(parsed, [["field", "value"]]);
  });

  it("replies `400` to a missing or invalid `boundary`", async (t) => {
    let reached = false;
    const { url } = await serve(t, [
      multipart(),
      (): void => {
        reached = true;
      },
    ]);

    const data = body(part('name="field"', "value"));
    for (const [content_type, used] of [
      ["multipart/form-data", ""],
      ["Multipart/Form-Data; boundary=", ""],
      ...["a".repeat(71), "binden-boundary ", "binden@boundary"].map(
        (invalid) => [`multipart/form-data; boundary="${invalid}"`, invalid],
      ),
    ]) {
      // A body of that boundary, which busboy would parse
      const reply = await send(url, {
        headers: { "Content-Type": content_type },
        body: data.replaceAll("binden-boundary", used),
      });
      deepEqual([reply.status, reply.headers.connection], [400, "close"]);
    }
    equal(reached, false);

    // A parameter that busboy does not parse
    const malformed = await send(url, {
      headers: { "Content-Type": `${type}; charset` },
      body: data,
    });
    equal(malformed.status, 400);

    // The longest boundary, with characters other than letters and digits
    const longest = `${"a".repeat(57)}'()+_,-./:= ?`;
    const parsed: unknown[] = [];
    const other = await serve(t, [multipart(), keep(parsed)]);
    const reply = await send(other.url, {
      headers: { "Content-Type": `multipart/form-data; boundary="${longest}"` },
      body: data.replaceAll("binden-boundary", longest),
    });
    equal(reply.status, 200);
    deepEqual(parsed, [["field", "value"]]);
  });

  it("replies `400` to a malformed body", async (t) => {
    let reached = false;
    const { url } = await serve(t, [
      multipart(),
      (): void => {
        reached = true;
      },
    ]);

    for (const data of [
      "Hello World",
      "",
      body(part('name="field"', "value", ["Content-Type: text/plain\u0001"])),
      [`--binden-boundary`, `Content-Disposition: form-data; name="a"`].join(
        "\r\n",
      ),
      part('name="file"; filename="file.txt"', "Hello World"),
    ]) {
      const reply = await post(url, data);
      deepEqual([reply.status, reply.headers.connection], [400, "close"]);
    }
    equal(reached, false);
  });

  it("replies `415` to a body with a content coding, which it does not decode", async (t) => {
    const files: string[] = [];
    let reached = false;
    const { url } = await serve(t, [
      multipart({
        file_filter: ({ filename }): boolean => {
          files.push(filename);
          return true;
        },
      }),
      (): void => {
        reached = true;
      },
    ]);
    const data = body(part('name="file"; filename="a.txt"', "Hello"));

    for (const [coding, sent] of [
      ["unknown", data],
      ["gzip", gzipSync(data)],
      ["identity, gzip", gzipSync(data)],
    ] as const) {
      const reply = await post(url, sent, { "Content-Encoding": coding });
      deepEqual([reply.status, reply.headers.connection], [415, "close"]);
    }
    deepEqual([files, reached], [[], false]);
  });

  it("parses a body whose content coding is `identity`", async (t) => {
    const parsed: unknown[] = [];
    const { url } = await serve(t, [multipart(), keep(parsed)]);

    for (const coding of ["identity", "Identity, ", ""]) {
      const reply = await post(url, body(part('name="a"', "1")), {
        "Content-Encoding": coding,
      });
      equal(reply.status, 200);
    }
    deepEqual(parsed, [
      ["a", "1"],
      ["a", "1"],
      ["a", "1"],
    ]);
  });

  it("replies `415` to a field of an unsupported charset", async (t) => {
    const { url } = await serve(t, [multipart()]);

    const reply = await post(
      url,
      body(
        part('name="field"', "value", [
          "Content-Type: text/plain; charset=koi8-r",
        ]),
      ),
    );

    deepEqual([reply.status, reply.headers.connection], [415, "close"]);
  });

  for (const [name, config, parts] of limits) {
    it(`replies \`413\` once the \`${name}\` limit is reached`, async (t) => {
      let reached = false;
      const { url } = await serve(t, [
        multipart({ config: { limits: config } }),
        (): void => {
          reached = true;
        },
      ]);

      const reply = await post(url, body(...parts));

      deepEqual([reply.status, reply.headers.connection], [413, "close"]);
      equal(reached, false);
    });
  }

  it("truncates the fields to `fieldSize` (`throw_limits: false`)", async (t) => {
    const parsed: unknown[] = [];
    const { url } = await serve(t, [
      new Multipart({
        config: { limits: { fieldSize: 3 } },
        throw_limits: false,
      }),
      keep(parsed),
    ]);

    const reply = await post(url, body(part('name="a"', "abcdef")));

    equal(reply.status, 200);
    deepEqual(parsed, [["a", "abc"]]);
  });

  it("drops the fields over `fields` (`throw_limits: false`)", async (t) => {
    const parsed: unknown[] = [];
    const { url } = await serve(t, [
      new Multipart({ config: { limits: { fields: 1 } }, throw_limits: false }),
      keep(parsed),
    ]);

    const reply = await post(
      url,
      body(part('name="a"', "1"), part('name="b"', "2")),
    );

    equal(reply.status, 200);
    deepEqual(parsed, [["a", "1"]]);
  });

  it("drops the files over `files` (`throw_limits: false`)", async (t) => {
    const parsed: unknown[] = [];
    const { url } = await serve(t, [
      new Multipart({ config: { limits: { files: 1 } }, throw_limits: false }),
      keep(parsed),
    ]);

    const reply = await post(
      url,
      body(
        part('name="a"; filename="a.txt"', "1"),
        part('name="b"; filename="b.txt"', "2"),
      ),
    );

    equal(reply.status, 200);
    deepEqual(parsed, [["a", "a.txt", "text/plain", "1"]]);
  });

  it("truncates the files to `fileSize` (`throw_limits: false`)", async (t) => {
    const parsed: unknown[] = [];
    const { url } = await serve(t, [
      new Multipart({
        config: { limits: { fileSize: 3 } },
        throw_limits: false,
      }),
      keep(parsed),
    ]);

    const reply = await post(
      url,
      body(
        part('name="a"; filename="a.txt"', "abcdef"),
        part('name="b"; filename="b.txt"', "ab"),
      ),
    );

    equal(reply.status, 200);
    deepEqual(parsed, [
      ["a", "a.txt", "text/plain", "abc"],
      ["b", "b.txt", "text/plain", "ab"],
    ]);
  });

  it("drops the parts over `parts` (`throw_limits: false`)", async (t) => {
    const parsed: unknown[] = [];
    const { url } = await serve(t, [
      new Multipart({ config: { limits: { parts: 2 } }, throw_limits: false }),
      keep(parsed),
    ]);

    const reply = await post(
      url,
      body(
        part('name="file"; filename="file.txt"', "123"),
        part('name="k1"', "v1"),
        part('name="k2"', "v2"),
      ),
    );

    equal(reply.status, 200);
    deepEqual(parsed, [
      ["file", "file.txt", "text/plain", "123"],
      ["k1", "v1"],
    ]);
  });

  it("`limit` (the size of the body, all parts included)", async (t) => {
    const parsed: unknown[] = [];
    const { url } = await serve(t, [
      new Multipart({ limit: 1024, throw_limits: false }),
      keep(parsed),
    ]);
    // Keeps its connections, unless the server closes them
    const agent = new Agent({ keepAlive: true });
    t.after(() => {
      agent.destroy();
    });
    const headers = { "Content-Type": type };
    const small = body(part('name="field"', "value"));
    const large = body(
      part('name="field"', "value"),
      part('name="file"; filename="file.bin"', "a".repeat(1024)),
    );

    const replies = [
      await send(url, { headers, body: small, agent }),
      await send(url, { headers, body: large, agent }),
    ].map(({ status, headers: { connection } }) => [status, connection]);

    deepEqual(replies, [
      [200, "keep-alive"],
      [413, "close"],
    ]);
    deepEqual(parsed, [["field", "value"]]);
  });

  it("`limit` counts the bytes of a body without a `Content-Length`", async (t) => {
    let reached = false;
    const { url } = await serve(t, [
      new Multipart({ limit: 64 }),
      (): void => {
        reached = true;
      },
    ]);

    // The parts that busboy reads after the limit are ignored
    const reply = await send(url, {
      headers: { "Content-Type": type, "Transfer-Encoding": "chunked" },
      body: body(
        part('name="a"', "a".repeat(64)),
        part('name="b"', "b"),
        part('name="c"; filename="c.txt"', "c"),
      ),
    });

    deepEqual([reply.status, reply.headers.connection], [413, "close"]);
    equal(reached, false);
  });

  it("`limit` refuses a larger `Content-Length` before reading the body", async (t) => {
    let reached = false;
    const { url } = await serve(t, [
      new Multipart({ limit: 1024 }),
      (): void => {
        reached = true;
      },
    ]);

    // Only the headers are sent: the reply does not wait for the body
    const reply = await new Promise<number | undefined>((resolve, reject) => {
      const client = httpRequest(url, {
        method: "POST",
        headers: { "Content-Type": type, "Content-Length": 2048 },
        signal: AbortSignal.timeout(5000),
      });
      client
        .once("response", (response) => {
          response.resume();
          resolve(response.statusCode);
          client.destroy();
        })
        .once("error", reject)
        .flushHeaders();
    });

    equal(reply, 413);
    equal(reached, false);
  });

  it("logs with the logger of the context, as `Multipart`", async (t) => {
    const logger = new RecordingLogger();
    const { url } = await serve(
      t,
      [multipart({ config: { limits: { fields: 0 } } })],
      {
        logger,
      },
    );

    const reply = await post(url, body(part('name="a"', "1")));

    equal(reply.status, 413);
    const record = logger.records.find(
      ({ message }) => message === "The multipart body has been refused",
    );
    deepEqual(
      [record?.level, record?.bindings.middleware, record?.extra],
      ["debug", "Multipart", { status: 413 }],
    );
  });
});

describe("Multipart (refusal)", () => {
  it("replies to a client that is still sending its body", async (t) => {
    let failure: unknown = null;
    const parser = new Multipart({ config: { limits: { fileSize: 4 } } });
    const { url } = await serve(t, [
      async (context: Context): Promise<void> => {
        await parser.run(context).catch((error: unknown) => {
          failure = error;
          throw error;
        });
      },
    ]);

    // The body is never complete: the reply comes before it
    const reply = await upload(
      url,
      part('name="file"; filename="file.bin"', "a".repeat(64)),
    );

    deepEqual(reply, [413, "close"]);
    ok(failure instanceof BindenError);
    equal(failure.status, 413);
  });

  it("keeps the request of a send whose headers are not sent, and closes its connection after the reply", async (t) => {
    const outcomes: unknown[] = [];
    const parser = new Multipart({ limit: 16 });
    const { url } = await serve(t, [
      async (context: Context): Promise<void> => {
        const stream = new PassThrough();
        const sending = context.send(stream);
        await parser.run(context).catch((error: unknown) => {
          outcomes.push(
            (error as BindenError).status,
            context.request.destroyed,
          );
        });
        // Its first chunk once the parse has been refused
        stream.end("replied");
        await sending;
      },
    ]);

    const reply = await post(url, body(part('name="a"', "a".repeat(64))));

    deepEqual(
      [reply.status, reply.headers.connection, reply.body],
      [200, "close", "replied"],
    );
    deepEqual(outcomes, [413, false]);
  });

  it("destroys the request once the headers of its response are sent", async () => {
    const outcomes: unknown[] = [];
    const parser = new Multipart({ limit: 16 });
    const app = new Binden().use(async (context: Context) => {
      context.response.flushHeaders();
      await parser.run(context).catch((error: unknown) => {
        outcomes.push((error as BindenError).status, context.request.destroyed);
      });
    });
    const test = await listen(app);

    await post(test.url, body(part('name="a"', "a".repeat(64)))).catch(
      (error: unknown) => {
        outcomes.push((error as NodeJS.ErrnoException).code);
      },
    );
    await test.close();

    deepEqual(outcomes, [413, true, "ECONNRESET"]);
  });
});
