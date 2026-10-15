import { Ajv as AJV, type JTDDataType } from "ajv/dist/jtd.js";
import {
  BindenError,
  type ContentType,
  type Context,
  ct_form,
  ct_json,
  ct_text,
} from "binden";
import { BodyParser, type IParse } from "../index.js";
import {
  type IBody,
  type IReply,
  chunked,
  send,
  serve,
  summarize,
} from "./helpers.js";
import { deepStrictEqual, ok } from "node:assert/strict";
import { suite, test } from "node:test";
import { once } from "node:events";

/** Sends one request through the middlewares (then `echo`) */
async function post(
  middlewares: Parameters<typeof serve>,
  body: IBody | null,
  headers: Record<string, string> = {},
  method = "POST",
): Promise<IReply> {
  const server = await serve(...middlewares);
  try {
    return await send(server.url, body, headers, method);
  } finally {
    await server.close();
  }
}

const json = { "Content-Type": ct_json };

suite("BodyParser", () => {
  test("JSON: objects, arrays and `+json` types", async () => {
    const parser = new BodyParser();
    const reply = (value: unknown): IReply => ({
      status: 200,
      connection: "keep-alive",
      body: { type: "json", value },
    });

    deepStrictEqual(await post([parser], '{"a":1}', json), reply({ a: 1 }));
    deepStrictEqual(await post([parser], "[1,2]", json), reply([1, 2]));
    deepStrictEqual(
      await post([parser], ' \r\n\t{"a":[]}', {
        "Content-Type": "application/vnd.api+json; charset=UTF-8",
      }),
      reply({ a: [] }),
    );
  });

  test("JSON: an empty body has no value", async () => {
    deepStrictEqual(await post([new BodyParser()], "", json), {
      status: 200,
      connection: "keep-alive",
      body: { type: "undefined" },
    });
  });

  test("JSON: invalid, or only whitespace, is a 400", async () => {
    const parser = new BodyParser({ strict: false });
    for (const body of ["Not a JSON", "{", " \r\n\t", '{"a":1} x']) {
      deepStrictEqual((await post([parser], body, json)).status, 400);
    }
  });

  test("JSON: `strict` accepts only an object or an array", async () => {
    const strict = new BodyParser();
    const loose = new BodyParser({ strict: false });
    for (const [body, value] of [
      ['"text"', "text"],
      ["1", 1],
      ["null", null],
      [" true", true],
    ] as const) {
      deepStrictEqual((await post([strict], body, json)).status, 400);
      deepStrictEqual((await post([loose], body, json)).body, summarize(value));
    }
  });

  test("JSON: `JSON.parse` is the default parse", async () => {
    const parser = new BodyParser({ parse: JSON.parse });
    // `strict` applies, and a `SyntaxError` is the fault of the client
    deepStrictEqual((await post([parser], '"text"', json)).status, 400);
    deepStrictEqual((await post([parser], "{", json)).status, 400);
    deepStrictEqual((await post([parser], "[]", json)).body, {
      type: "json",
      value: [],
    });
  });

  test("JSON: a custom `parse` (synchronous or not)", async () => {
    const ajv = new AJV();
    const schema = {
      properties: { username: { type: "string" } },
      additionalProperties: false,
    } as const;
    const ajvParse = ajv.compileParser<JTDDataType<typeof schema>>(schema);
    const parsers: [string, IParse][] = [
      ["ajv", ajvParse],
      ["async", (input): Promise<unknown> => Promise.resolve(ajvParse(input))],
    ];
    for (const [name, parse] of parsers) {
      const parser = new BodyParser({ parse });
      const valid = await post([parser], '{"username":"a"}', json);
      deepStrictEqual(
        valid.body,
        {
          type: "json",
          value: { username: "a" },
        },
        name,
      );
      // `undefined` tells that the body is invalid
      deepStrictEqual((await post([parser], '{"x":1}', json)).status, 400);
      // Not `strict`
      deepStrictEqual((await post([parser], '"a"', json)).status, 400);
    }
    const primitive = new BodyParser({
      parse: (input): number => input.length,
    });
    deepStrictEqual((await post([primitive], '"a"', json)).body, {
      type: "json",
      value: 3,
    });
  });

  test("JSON: the message of a parse that returns `undefined`", async () => {
    const ajv = new AJV();
    const parse = ajv.compileParser({ properties: { a: { type: "string" } } });
    const errors: unknown[] = [];
    const capture = async (context: Context): Promise<void> => {
      try {
        await new BodyParser({ parse }).run(context);
      } catch (error: unknown) {
        errors.push(error);
        throw error;
      }
    };
    deepStrictEqual((await post([capture], '{"a":1}', json)).status, 400);
    const [error] = errors;
    ok(error instanceof BindenError);
    deepStrictEqual(error.message, parse.message);
    ok(typeof parse.message === "string" && parse.message !== "");

    // Without a message
    const undefinedParse = new BodyParser({
      parse: (): undefined => Reflect.get({}, "nothing") as undefined,
    });
    const without: unknown[] = [];
    const run = async (context: Context): Promise<void> => {
      try {
        await undefinedParse.run(context);
      } catch (failure: unknown) {
        without.push(failure);
        throw failure;
      }
    };
    deepStrictEqual((await post([run], "{}", json)).status, 400);
    deepStrictEqual((without[0] as Error).message, "Bad Request");
  });

  test("JSON: the failures of a custom `parse`", async () => {
    const unprocessable = (): never => {
      throw new BindenError(422);
    };
    const nothing = (): never => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- any value
      throw null;
    };
    const statuses: [IParse, number][] = [
      [unprocessable, 422],
      [(): Promise<never> => Promise.reject(new BindenError(409)), 409],
      // A `SyntaxError` of a custom parse
      [(input): unknown => JSON.parse(`${input}x`), 500],
      [(): Promise<never> => Promise.reject(new TypeError("A failure")), 500],
      [nothing, 500],
    ];
    for (const [parse, status] of statuses) {
      const parser = new BodyParser({ parse });
      deepStrictEqual((await post([parser], "{}", json)).status, status);
    }
  });

  test("JSON: `parse` is called only for a body that is not empty or blank", async () => {
    const inputs: string[] = [];
    const parse = (input: string): { input: string } => {
      inputs.push(input);
      return { input };
    };
    const parser = new BodyParser({ parse });
    deepStrictEqual((await post([parser], "", json)).body, {
      type: "undefined",
    });
    deepStrictEqual((await post([parser], "  \n", json)).status, 400);
    deepStrictEqual((await post([parser], " x", json)).body, {
      type: "json",
      value: { input: " x" },
    });
    deepStrictEqual(inputs, [" x"]);
  });

  test("text", async () => {
    const parser = new BodyParser();
    deepStrictEqual(
      await post([parser], "Hello World", { "Content-Type": ct_text }),
      {
        status: 200,
        connection: "keep-alive",
        body: { type: "text", value: "Hello World" },
      },
    );
    deepStrictEqual(
      (await post([parser], "", { "Content-Type": ct_text })).body,
      {
        type: "text",
        value: "",
      },
    );
    // Not selected by default
    deepStrictEqual(
      (await post([parser], "<p>", { "Content-Type": "text/html" })).body,
      {
        type: "undefined",
      },
    );
  });

  test("charset", async () => {
    const parser = new BodyParser();
    const text = (charset: string, body: Buffer): Promise<IReply> =>
      post([parser], body, {
        "Content-Type": `${ct_text}; charset=${charset}`,
      });

    deepStrictEqual(
      (await text("iso-8859-1", Buffer.from([0x63, 0x61, 0x66, 0xe9]))).body,
      { type: "text", value: "café" },
    );
    deepStrictEqual(
      (await text("UTF-16LE", Buffer.from("café", "utf16le"))).body,
      { type: "text", value: "café" },
    );
    deepStrictEqual((await text("utf-8", Buffer.from("café"))).body, {
      type: "text",
      value: "café",
    });
    // Unknown: not read
    deepStrictEqual(await text("unknown-charset", Buffer.from("café")), {
      status: 415,
      connection: "close",
      body: null,
    });
    // Invalid bytes: read
    deepStrictEqual(await text("utf-8", Buffer.from([0x63, 0xff])), {
      status: 400,
      connection: "keep-alive",
      body: null,
    });
    deepStrictEqual(
      (await post([parser], Buffer.from([0x7b, 0xff, 0x7d]), json)).status,
      400,
    );
  });

  test("form", async () => {
    const parser = new BodyParser();
    const form = (body: string): Promise<IReply> =>
      post([parser], body, { "Content-Type": ct_form });
    deepStrictEqual((await form("a=1&b=%20x+y&a=2")).body, {
      type: "form",
      value: [
        ["a", "1"],
        ["b", " x y"],
        ["a", "2"],
      ],
    });
    deepStrictEqual((await form("")).body, { type: "form", value: [] });
  });

  test("`parameter_limit`", async () => {
    const form = { "Content-Type": ct_form };
    const parameters = (count: number): string =>
      Array.from({ length: count }, (_, index) => `p${index}=${index}`).join(
        "&",
      );

    // 1000 by default
    const parser = new BodyParser();
    deepStrictEqual((await post([parser], parameters(1000), form)).status, 200);
    deepStrictEqual(await post([parser], parameters(1001), form), {
      status: 413,
      connection: "keep-alive",
      body: null,
    });

    const two = new BodyParser({ parameter_limit: 2 });
    // Empty parameters are not counted
    deepStrictEqual((await post([two], "&a=1&&b=2&", form)).body, {
      type: "form",
      value: [
        ["a", "1"],
        ["b", "2"],
      ],
    });
    deepStrictEqual((await post([two], "a=1&b=2&c", form)).status, 413);
    deepStrictEqual((await post([two], "a", form)).status, 200);

    const none = new BodyParser({ parameter_limit: 0 });
    deepStrictEqual((await post([none], "", form)).status, 200);
    deepStrictEqual((await post([none], "&", form)).status, 200);
    deepStrictEqual((await post([none], "a", form)).status, 413);

    const unlimited = new BodyParser({ parameter_limit: Infinity });
    deepStrictEqual(
      (await post([unlimited], parameters(1001), form)).status,
      200,
    );
  });

  test("`raw`", async () => {
    const octet = { "Content-Type": "application/octet-stream" };
    const raw = new BodyParser({ raw: true });
    deepStrictEqual(await post([raw], Buffer.from([0, 0xff]), octet), {
      status: 200,
      connection: "keep-alive",
      body: { type: "buffer", value: "00ff" },
    });
    deepStrictEqual((await post([raw], "", octet)).body, {
      type: "buffer",
      value: "",
    });
    // A charset does not apply to bytes
    deepStrictEqual(
      (
        await post([raw], "a", {
          "Content-Type": "application/octet-stream; charset=unknown",
        })
      ).body,
      { type: "buffer", value: "61" },
    );
    // The other types still are parsed
    deepStrictEqual((await post([raw], "[]", json)).body, {
      type: "json",
      value: [],
    });
    // Not without `raw`
    deepStrictEqual((await post([new BodyParser()], "a", octet)).body, {
      type: "undefined",
    });
    // With a list
    const listed = new BodyParser({ raw: true, type: ["text/plain"] });
    deepStrictEqual((await post([listed], "a", octet)).body, {
      type: "buffer",
      value: "61",
    });
    deepStrictEqual((await post([listed], "[]", json)).body, {
      type: "undefined",
    });
  });

  test("`type`: a list of media types", async () => {
    const all = new BodyParser({ type: ["*/*"] });
    const kinds: [string, unknown][] = [
      [ct_json, { type: "json", value: [] }],
      ["application/ld+json", { type: "json", value: [] }],
      [ct_form, { type: "form", value: [["[]", ""]] }],
      ["text/csv", { type: "text", value: "[]" }],
      ["application/xml", { type: "buffer", value: "5b5d" }],
    ];
    for (const [type, summary] of kinds) {
      deepStrictEqual(
        (await post([all], "[]", { "Content-Type": type })).body,
        summary,
        type,
      );
    }

    const selected: [string[], string, boolean][] = [
      [["text/*"], "text/html", true],
      [["text/*"], "application/json", false],
      [["TEXT/HTML"], "text/html", true],
      [["text/html"], "text/plain", false],
      [["*/html"], "text/html", true],
      [["+json"], "application/geo+json", true],
      [["+json"], "application/json", false],
      [["+json"], "application/+json", false],
      [[], "text/plain", false],
    ];
    for (const [type, content_type, parsed] of selected) {
      const reply = await post([new BodyParser({ type })], "[1]", {
        "Content-Type": content_type,
      });
      deepStrictEqual(
        reply.body !== null &&
          (reply.body as { type: string }).type !== "undefined",
        parsed,
        `${type.join()} ${content_type}`,
      );
    }
  });

  test("`type`: a function of the `Content-Type`", async () => {
    const received: ContentType[] = [];
    const parser = new BodyParser({
      type: (content_type): "json" | null => {
        received.push(content_type);
        return content_type.type === "application/csp-report" ? "json" : null;
      },
    });
    deepStrictEqual(
      (
        await post([parser], '{"csp-report":{}}', {
          "Content-Type": "application/csp-report; charset=utf-8",
        })
      ).body,
      { type: "json", value: { "csp-report": {} } },
    );
    deepStrictEqual((await post([parser], "[]", json)).body, {
      type: "undefined",
    });
    deepStrictEqual(
      received.map((content_type) => content_type.toString()),
      ["application/csp-report; charset=utf-8", ct_json],
    );

    // Not called without a `Content-Type`
    deepStrictEqual((await post([parser], "[]", {})).body, {
      type: "undefined",
    });
    deepStrictEqual(received.length, 2);
  });

  test("`type`: a function that fails is a 500", async () => {
    const failures: [string, BodyParser][] = [
      [
        "throws",
        new BodyParser({
          type: (): never => {
            throw new Error("A failure");
          },
        }),
      ],
      [
        "throws an HTTP error",
        new BodyParser({
          type: (): never => {
            throw new BindenError(404);
          },
        }),
      ],
      ["invalid", new BodyParser({ type: () => "xml" as "raw" })],
      [
        "promise",
        new BodyParser({
          type: () => Promise.resolve("raw") as unknown as "raw",
        }),
      ],
    ];
    for (const [name, parser] of failures) {
      deepStrictEqual((await post([parser], "[]", json)).status, 500, name);
    }
  });

  test("a body that is not selected is not read", async () => {
    const bodies: string[] = [];
    const read = async (context: Context): Promise<void> => {
      bodies.push(
        await context.request
          .setEncoding("utf8")
          .toArray()
          .then((chunks) => chunks.join("")),
      );
    };
    for (const headers of [
      { "Content-Type": "application/x-unknown" },
      { "Content-Type": "multipart/form-data; boundary=x" },
      // Without a `Content-Type`, or a malformed one
      {},
      { "Content-Type": "json" },
    ]) {
      deepStrictEqual(
        (await post([new BodyParser(), read], "Hello World", headers)).body,
        { type: "undefined" },
      );
    }
    deepStrictEqual(
      bodies,
      Array.from({ length: 4 }, () => "Hello World"),
    );
  });

  test("a body that is not selected is left to another parser", async () => {
    const first = new BodyParser();
    const second = new BodyParser({ type: ["text/csv"] });
    deepStrictEqual(
      (await post([first, second], "a,b", { "Content-Type": "text/csv" })).body,
      { type: "text", value: "a,b" },
    );
  });

  test("the methods without a body are skipped", async () => {
    const methods = [...BodyParser.unsupported_methods];
    for (const method of methods) {
      // Even with an (invalid) body
      const reply = await post([new BodyParser()], "{x", json, method);
      deepStrictEqual(reply.status, 200, method);
      deepStrictEqual(
        reply.body,
        method === "HEAD" ? null : { type: "undefined" },
      );
    }
  });

  test("a body is parsed once", async () => {
    const inputs: string[] = [];
    const parser = new BodyParser({
      parse: (input): unknown => {
        inputs.push(input);
        return JSON.parse(input) as unknown;
      },
    });
    const other = new BodyParser();
    deepStrictEqual((await post([parser, other, parser], "[1]", json)).body, {
      type: "json",
      value: [1],
    });
    // An empty body (without a value) is not read again either
    deepStrictEqual((await post([parser, other], "", json)).body, {
      type: "undefined",
    });
    deepStrictEqual(inputs, ["[1]"]);
  });

  test("a body that something else has read is a 500", async () => {
    const read = async (context: Context): Promise<void> => {
      await context.request.toArray();
    };
    const resume = async (context: Context): Promise<void> => {
      context.request.resume();
      await once(context.request, "end");
    };
    deepStrictEqual(
      (await post([read, new BodyParser()], "[]", json)).status,
      500,
    );
    // Empty: ended without data
    deepStrictEqual(
      (await post([resume, new BodyParser()], "", json)).status,
      500,
    );
    // Partly
    const first = async (context: Context): Promise<void> => {
      const chunks = context.request.iterator({ destroyOnReturn: false });
      await chunks.next();
      await chunks.return?.();
    };
    const body = chunked(Buffer.from("a"), Buffer.alloc(64 * 1024, 0x62));
    const text = { "Content-Type": ct_text };
    deepStrictEqual(
      (await post([first, new BodyParser()], body, text)).status,
      500,
    );
  });
});
