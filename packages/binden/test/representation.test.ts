/* eslint-disable init-declarations */
import {
  BindenResponse,
  type IRepresentation,
  type IRepresentationNegotiator,
  type IResponseOptions,
  kNegotiator,
  kRepresentation,
  validateResponseOptions,
} from "../index.js";
import { type IReply, type ITestServer, listen } from "./http.js";
import { IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { after, afterEach, before, suite, test } from "node:test";
import { deepStrictEqual, ok } from "node:assert/strict";
import { kFramework, kSeal } from "../src/seal.js";
import { mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { Socket } from "node:net";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** A response with the dynamic `ETag` */
class EtagResponse extends BindenResponse {
  // eslint-disable-next-line class-methods-use-this -- the options of a subclass
  protected override get options(): Readonly<IResponseOptions> {
    return validateResponseOptions({ etag: true });
  }
}

/** A negotiator that chooses one representation, and records its calls */
class Negotiator implements IRepresentationNegotiator {
  readonly #representation: IRepresentation;
  /** The lengths that it has been asked for */
  public readonly lengths: (number | null)[] = [];
  /** How many times the choice has been forgotten */
  public forgotten = 0;

  public constructor(representation: IRepresentation) {
    this.#representation = representation;
  }

  public choose(length: number | null): IRepresentation {
    this.lengths.push(length);
    return this.#representation;
  }

  public forget(): void {
    this.forgotten += 1;
  }
}

const coded: IRepresentation = { coding: "gzip", status: null };
const refused: IRepresentation = { coding: null, status: 406 };
const identity: IRepresentation = { coding: null, status: null };

/** The status, the `ETag`, the `Content-Length` and the body of a reply */
function summary({ status, headers, body }: IReply): unknown[] {
  return [status, headers.etag, headers["content-length"], body.toString()];
}

/** The strong `ETag` of a body */
function etagOf(body: string): string {
  return `"${createHash("sha256").update(body).digest("base64url")}"`;
}

suite("The representation chosen before the preconditions", () => {
  let tmp: string;
  let file: string;
  const content = "0123456789";
  const validator = `"v1"`;
  // The modification time of the file, and of the dynamic `ETag`
  const lm = "Wed, 01 Jan 2020 00:00:00 GMT";
  const before2020 = "Tue, 31 Dec 2019 23:59:59 GMT";
  let server: ITestServer | null = null;

  before(async () => {
    tmp = await realpath(await mkdtemp(join(tmpdir(), "binden-represent-")));
    file = join(tmp, "file.txt");
    await writeFile(file, content);
    const date = new Date(lm);
    await utimes(file, date, date);
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  afterEach(async () => {
    const current = server;
    server = null;
    await current?.close();
  });

  /** Serves the next request: `sendFile()` of the file with the representation of a negotiator */
  const sendFile = async (
    negotiator: Negotiator | null,
    headers: OutgoingHttpHeaders,
    method = "GET",
  ): Promise<IReply> => {
    const app = server as ITestServer;
    const handled = app.handle(async (_request, response) => {
      if (negotiator !== null) {
        response[kNegotiator](negotiator);
      }
      await response.sendFile(file, { validator });
    });
    const reply = await app.request({ method, headers });
    deepStrictEqual(await handled, null);
    return reply;
  };

  /** Serves the next request: `send()` of `body` with the dynamic `ETag` */
  const send = async (
    negotiator: Negotiator | null,
    headers: OutgoingHttpHeaders,
    { method = "GET", modified = null as number | string | null } = {},
  ): Promise<IReply> => {
    const app = server as ITestServer;
    const handled = app.handle(async (_request, response) => {
      if (negotiator !== null) {
        response[kNegotiator](negotiator);
      }
      if (modified !== null) {
        response.setHeader("Last-Modified", modified);
      }
      await response.send(content);
    });
    const reply = await app.request({ method, headers });
    deepStrictEqual(await handled, null);
    return reply;
  };

  test("[kRepresentation]()", () => {
    const response = new BindenResponse(new IncomingMessage(new Socket()));
    // The body as it is without a negotiator
    deepStrictEqual(response[kRepresentation](10), identity);

    const negotiator = new Negotiator(coded);
    response[kNegotiator](negotiator);
    deepStrictEqual(response[kRepresentation](10), coded);
    deepStrictEqual(response[kRepresentation](null), coded);
    deepStrictEqual(negotiator.lengths, [10, null]);

    // Not for the work that may no longer mutate the response
    response[kSeal]();
    deepStrictEqual(response[kRepresentation](20), identity);
    deepStrictEqual(negotiator.lengths, [10, null]);
  });

  test("sendFile(): the preconditions of a coded representation, whose `ETag` is weak", async () => {
    server = await listen();
    for (const method of ["GET", "HEAD"]) {
      const negotiator = new Negotiator(coded);
      const status = async (headers: OutgoingHttpHeaders): Promise<number> =>
        (await sendFile(negotiator, headers, method)).status;
      const body = method === "GET" ? content : "";

      // The representation of the whole file, before the preconditions
      deepStrictEqual(summary(await sendFile(negotiator, {}, method)), [
        200,
        validator,
        `${content.length}`,
        body,
      ]);
      deepStrictEqual(negotiator.lengths, [content.length]);
      // `If-Match` compares strongly: the tag of the coded representation is weak
      deepStrictEqual(
        summary(await sendFile(negotiator, { "If-Match": validator }, method)),
        [412, validator, "0", ""],
      );
      deepStrictEqual(await status({ "If-Match": `W/${validator}` }), 412);
      deepStrictEqual(await status({ "If-Match": "*" }), 200);
      deepStrictEqual(await status({ "If-Unmodified-Since": before2020 }), 412);
      deepStrictEqual(await status({ "If-Unmodified-Since": lm }), 200);
      // `If-None-Match` compares weakly
      deepStrictEqual(
        summary(
          await sendFile(negotiator, { "If-None-Match": validator }, method),
        ),
        [304, validator, `${content.length}`, ""],
      );
      deepStrictEqual(await status({ "If-None-Match": `"other"` }), 200);
      deepStrictEqual(await status({ "If-Modified-Since": lm }), 304);
      deepStrictEqual(await status({ "If-Modified-Since": before2020 }), 200);
      // Each request has chosen once
      deepStrictEqual(negotiator.lengths.length, 10);
    }

    // Other methods: a matching `If-None-Match` fails
    const negotiator = new Negotiator(coded);
    deepStrictEqual(
      (await sendFile(negotiator, { "If-None-Match": validator }, "POST"))
        .status,
      412,
    );
    // A coded representation is sent whole: ranges are of the file as it is
    for (const headers of [
      { Range: "bytes=0-1" },
      { Range: "bytes=0-1", "If-Range": validator },
      { Range: "bytes=20-30" },
    ]) {
      deepStrictEqual(summary(await sendFile(negotiator, headers)), [
        200,
        validator,
        `${content.length}`,
        content,
      ]);
    }

    // The file as it is: its strong tag, and its ranges
    const plain = new Negotiator(identity);
    deepStrictEqual(
      (await sendFile(plain, { "If-Match": validator })).status,
      200,
    );
    const partial = await sendFile(plain, {
      Range: "bytes=0-1",
      "If-Range": validator,
    });
    deepStrictEqual([partial.status, partial.body.toString()], [206, "01"]);
  });

  test("sendFile(): a replaced representation, whatever the preconditions", async () => {
    server = await listen();
    for (const method of ["GET", "HEAD"]) {
      for (const headers of [
        {},
        { "If-None-Match": validator },
        { "If-Match": `"other"` },
        { "If-Modified-Since": lm },
        { "If-Unmodified-Since": before2020 },
        { Range: "bytes=0-1" },
      ]) {
        const negotiator = new Negotiator(refused);
        const reply = await sendFile(negotiator, headers, method);
        deepStrictEqual(
          [reply.status, reply.headers["content-length"], reply.body.length],
          [406, "0", 0],
          `${method} ${JSON.stringify(headers)}`,
        );
        deepStrictEqual(negotiator.lengths, [content.length]);
      }
    }
  });

  test("the dynamic `ETag`: the preconditions of the chosen representation", async () => {
    server = await listen({ Response: EtagResponse });
    const tag = etagOf(content);
    for (const method of ["GET", "HEAD"]) {
      const body = method === "GET" ? content : "";
      const length = `${content.length}`;

      // Without a negotiator: the body as it is
      const status = async (
        headers: OutgoingHttpHeaders,
        modified: number | string | null = null,
      ): Promise<number> =>
        (await send(null, headers, { method, modified })).status;
      deepStrictEqual(summary(await send(null, {}, { method })), [
        200,
        tag,
        length,
        body,
      ]);
      deepStrictEqual(
        summary(await send(null, { "If-Match": `"other"` }, { method })),
        [412, tag, "0", ""],
      );
      deepStrictEqual(await status({ "If-Match": tag }), 200);
      deepStrictEqual(await status({ "If-Match": `"other", ${tag}` }), 200);
      deepStrictEqual(await status({ "If-Match": "*" }), 200);
      deepStrictEqual(await status({ "If-Match": `W/${tag}` }), 412);
      // The dates of the `Last-Modified` of the response
      deepStrictEqual(await status({ "If-Unmodified-Since": before2020 }), 200);
      deepStrictEqual(
        await status({ "If-Unmodified-Since": before2020 }, lm),
        412,
      );
      deepStrictEqual(await status({ "If-Unmodified-Since": lm }, lm), 200);
      deepStrictEqual(
        await status({ "If-Unmodified-Since": before2020 }, "garbage"),
        200,
      );
      deepStrictEqual(
        await status({ "If-Unmodified-Since": before2020 }, 1),
        200,
      );
      // `If-Match` takes precedence over `If-Unmodified-Since`
      deepStrictEqual(
        await status(
          { "If-Match": tag, "If-Unmodified-Since": before2020 },
          lm,
        ),
        200,
      );
      deepStrictEqual(await status({ "If-Modified-Since": lm }), 200);
      deepStrictEqual(
        summary(
          await send(
            null,
            { "If-Modified-Since": lm },
            { method, modified: lm },
          ),
        ),
        [304, tag, length, ""],
      );
      deepStrictEqual(
        await status({ "If-Modified-Since": before2020 }, lm),
        200,
      );
      // `If-None-Match` takes precedence over `If-Modified-Since`
      deepStrictEqual(
        await status(
          { "If-None-Match": `"other"`, "If-Modified-Since": lm },
          lm,
        ),
        200,
      );

      // A coded representation: its tag is weak
      const negotiator = new Negotiator(coded);
      deepStrictEqual(
        summary(await send(negotiator, { "If-Match": tag }, { method })),
        [412, tag, "0", ""],
      );
      deepStrictEqual(
        (await send(negotiator, { "If-Match": "*" }, { method })).status,
        200,
      );
      deepStrictEqual(
        summary(await send(negotiator, { "If-None-Match": tag }, { method })),
        [304, tag, length, ""],
      );
      deepStrictEqual(negotiator.lengths, Array(3).fill(content.length));

      // A replaced representation, whatever the preconditions
      for (const headers of [
        {},
        { "If-None-Match": tag },
        { "If-Match": `"other"` },
      ]) {
        const replaced = await send(new Negotiator(refused), headers, {
          method,
        });
        deepStrictEqual(
          [
            replaced.status,
            replaced.headers["content-length"],
            replaced.body.length,
          ],
          [406, "0", 0],
        );
      }
    }
  });

  test("the choice is forgotten when its stream fails before its first chunk", async () => {
    server = await listen();
    const app = server;
    const outcomes: unknown[] = [];
    /** Sends a stream that fails once its first chunk is sent (`late`) or before it */
    const fail = async (late: boolean): Promise<number> => {
      const negotiator = new Negotiator(coded);
      const handled = app.handle(async (_request, response) => {
        response[kNegotiator](negotiator);
        const source = new PassThrough();
        const sent = response.setHeader("Content-Length", 10).send(source);
        if (late) {
          // Its first chunk commits the headers
          source.write("01234");
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          ok(response.headersSent);
        }
        source.destroy(new Error("Failed"));
        outcomes.push(
          await sent.then(
            () => null,
            (error: unknown) => (error as Error).message,
          ),
        );
        if (!late) {
          await response.send("replaced");
        }
      });
      const reply = await app.request().catch(() => null);
      deepStrictEqual(await handled, null);
      if (!late) {
        deepStrictEqual(reply?.body.toString(), "replaced");
      }
      return negotiator.forgotten;
    };
    deepStrictEqual(await fail(false), 1);
    deepStrictEqual(await fail(true), 0);
    deepStrictEqual(outcomes, ["Failed", "Failed"]);

    // Not by the abandoned work: the reply of the new owner keeps its choice
    const negotiator = new Negotiator(coded);
    let abandoned: unknown = null;
    const handled = app.handle(async (_request, response) => {
      response[kNegotiator](negotiator);
      const source = new PassThrough();
      const sent = response.send(source);
      response[kSeal]();
      source.destroy(new Error("Failed"));
      abandoned = await sent.then(
        () => null,
        (error: unknown) => (error as Error).message,
      );
      response[kFramework](() => {
        response.destroy();
      });
    });
    await app.request().catch(() => null);
    deepStrictEqual(await handled, null);
    deepStrictEqual(negotiator.forgotten, 0);
    deepStrictEqual(abandoned, "Failed");
  });
});
