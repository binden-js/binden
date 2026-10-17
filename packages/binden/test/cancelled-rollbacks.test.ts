import {
  Binden,
  BindenResponse,
  type Context,
  type IRepresentation,
  type IRepresentationNegotiator,
  kNegotiator,
} from "../index.js";
import { Duplex, PassThrough, Readable } from "node:stream";
import { after, afterEach, before, mock, suite, test } from "node:test";
import { capture, listen, never, send, within } from "./helpers.js";
import { deepStrictEqual, ok } from "node:assert/strict";
import fsp, { type FileHandle, mkdtemp, rm, writeFile } from "node:fs/promises";
import { kCancel, kCancelling, kSeal, owners } from "../src/seal.js";
import { IncomingMessage } from "node:http";
import type { ReadStream } from "node:fs";
import type { Socket } from "node:net";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";

/** Long enough never to expire on a loaded machine: it only guards against a hang */
const deadline = 10_000;

/** A response to `GET` (with the headers of its request) on a connection that records what it is sent */
function detached(headers: Record<string, string> = {}): {
  response: BindenResponse;
  /** What the connection has been sent, without the `Date` */
  sent(): string;
  close(): void;
} {
  const chunks: Buffer[] = [];
  const wire = new Duplex({
    read(): void {
      // The client sends nothing more
    },
    write(chunk: Buffer, _encoding, done): void {
      chunks.push(chunk);
      done();
    },
  });
  const request = new IncomingMessage(wire as unknown as Socket);
  Object.assign(request, {
    method: "GET",
    headers,
    httpVersionMajor: 1,
    httpVersionMinor: 1,
  });
  const response = new BindenResponse(request);
  response.assignSocket(wire as unknown as Socket);
  return {
    response,
    sent: () =>
      Buffer.concat(chunks)
        .toString("latin1")
        .replaceAll(/\r\nDate: [^\r]*/gu, ""),
    close: (): void => {
      wire.destroy();
    },
  };
}

/** The settled value of a promise: `null` once resolved, or its error */
function settled(promise: Promise<unknown>): Promise<unknown> {
  return within(
    promise.then(
      () => null,
      (error: unknown) => error,
    ),
    deadline,
  );
}

/**
 * Lets `respond` act once a send of a `Readable` has started (e.g. the send
 * of the file of a `sendFile()`), right after it has
 */
function onPipe(
  response: BindenResponse,
  respond: (source: Readable) => void,
): void {
  const original = response.send.bind(response) as (
    ...args: unknown[]
  ) => Promise<void>;
  response.send = (...args: unknown[]): Promise<void> => {
    const sent = original(...args);
    const [data] = args;
    if (data instanceof Readable) {
      respond(data);
    }
    return sent;
  };
}

/** A negotiator of the body as it is, which counts how often its choice is forgotten */
class Negotiator implements IRepresentationNegotiator {
  public forgotten = 0;

  // eslint-disable-next-line class-methods-use-this -- the body as it is
  public choose(): IRepresentation {
    return { coding: null, status: null };
  }

  public forget(): void {
    this.forgotten += 1;
  }
}

/** The headers that a `sendFile()` of a range sets */
const fileHeaders = [
  "accept-ranges",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
  "x-content-type-options",
];

suite("A cancellation recorded before a send settles", () => {
  let tmp = "";
  let file = "";

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), "binden-rollbacks-"));
    file = join(tmp, "window.pdf");
    await writeFile(file, "12345678");
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  afterEach(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });

  test("a sendFile() whose send of its file fails before the cancellation runs is restored all the same: the reply that replaces it has the status and the headers from before it", async () => {
    const connection = detached({ range: "bytes=0-1" });
    const { response } = connection;
    try {
      const reason = new Error("The pipe has failed");
      response.setHeader("X-Before", "kept");
      // Recorded while the file is sent, which then fails (e.g. a read
      // error), and its `sendFile()` settles before the cancellation runs
      onPipe(response, (source) => {
        response[kCancelling](reason);
        source.destroy(new Error("The file has failed"));
      });
      deepStrictEqual(await settled(response.sendFile(file)), reason);
      // Settled: not yet restored
      deepStrictEqual(response.statusCode, 206);
      ok(!response.started);
      response[kCancel](reason);
      deepStrictEqual(
        [response.statusCode, response.getHeaderNames().sort()],
        [200, ["x-before"]],
      );
      await within(response.send("FAILED"), deadline);
      const head = connection.sent();
      ok(head.startsWith("HTTP/1.1 200 OK\r\n"), head);
      ok(/^X-Before: kept\r$/mu.test(head), head);
      ok(/^Content-Type: text\/plain\r$/mu.test(head), head);
      ok(
        !/^(?:ETag|Content-Range|Last-Modified|Accept-Ranges):/imu.test(head),
        head,
      );
      ok(head.endsWith("\r\n\r\nFAILED"), head);
    } finally {
      connection.close();
    }
  });

  test("a sendFile() that settles as ignored before the cancellation runs (its work revoked) is restored all the same, once: the status and the headers set after it are removed, not those of the reply that replaces it", async () => {
    const connection = detached();
    const { response } = connection;
    try {
      const work = {};
      const replacement = {};
      let revoked = false;
      response[kSeal](
        (owner) => owner === replacement || (owner === work && !revoked),
      );
      const reason = new Error("The error handler has failed");
      const sending = owners.run(work, () => {
        const pending = response.sendFile(file);
        response.status(201).setHeader("X-After", "set");
        return pending;
      });
      // Before its file is opened: it sees that its work may no longer
      // mutate the response, and settles (as an ignored send would)
      revoked = true;
      response[kCancelling](reason);
      deepStrictEqual(await settled(sending), reason);
      deepStrictEqual(response.statusCode, 201);
      response[kCancel](reason);
      deepStrictEqual(
        [response.statusCode, response.hasHeader("X-After")],
        [200, false],
      );
      await owners.run(replacement, async () => {
        response.status(500).setHeader("X-Replacement", "kept");
        // E.g. a deadline that cancels the sends of the reply that replaces
        // it: restored once, it is not restored again
        response[kCancel](new Error("The deadline has passed"));
        deepStrictEqual(
          [response.statusCode, response.getHeader("X-Replacement")],
          [500, "kept"],
        );
        await within(response.send("FAILED"), deadline);
      });
      const head = connection.sent();
      ok(head.startsWith("HTTP/1.1 500 Internal Server Error\r\n"), head);
      ok(/^X-Replacement: kept\r$/mu.test(head), head);
      ok(!/^X-After:/imu.test(head), head);
    } finally {
      connection.close();
    }
  });

  test("a sendFile() whose send of its file fails without the rights of its revoked work before the cancellation runs is restored all the same: the representation chosen for the file is forgotten", async () => {
    const connection = detached({ range: "bytes=0-1" });
    const { response } = connection;
    try {
      const work = {};
      const replacement = {};
      let revoked = false;
      response[kSeal](
        (owner) => owner === replacement || (owner === work && !revoked),
      );
      const negotiator = new Negotiator();
      response[kNegotiator](negotiator);
      const reason = new Error("The pipe has failed");
      onPipe(response, (source) => {
        revoked = true;
        response[kCancelling](reason);
        source.destroy(new Error("The file has failed"));
      });
      const sending = owners.run(work, () => response.sendFile(file));
      deepStrictEqual(await settled(sending), reason);
      // Its send has failed as its work, which may no longer forget
      deepStrictEqual([response.statusCode, negotiator.forgotten], [206, 0]);
      response[kCancel](reason);
      deepStrictEqual(
        [
          response.statusCode,
          negotiator.forgotten,
          fileHeaders.filter((name) => response.hasHeader(name)),
        ],
        [200, 1, []],
      );
      await owners.run(replacement, () =>
        within(response.send("FAILED"), deadline),
      );
      const head = connection.sent();
      ok(head.startsWith("HTTP/1.1 200 OK\r\n"), head);
      ok(
        !/^(?:ETag|Content-Range|Content-Type: application)/imu.test(head),
        head,
      );
    } finally {
      connection.close();
    }
  });

  for (const settles of [false, true]) {
    test(`a send of a stream ${settles ? "that fails before the cancellation runs" : "still in progress when the cancellation runs"} is restored without the framing set since it has started`, async () => {
      const connection = detached();
      const { response } = connection;
      try {
        const work = {};
        const replacement = {};
        let revoked = false;
        response[kSeal](
          (owner) => owner === replacement || (owner === work && !revoked),
        );
        const reason = new Error("The pipe has failed");
        const source = new PassThrough();
        const sending = owners.run(work, () => {
          response.setHeader("Content-Length", 8);
          const piped = response.send(source);
          // Framed again once it has started: its own failure leaves that
          // framing (to the reply that has set it), its cancellation does not
          response.setHeader("Content-Range", "bytes 0-7/16");
          return piped;
        });
        revoked = true;
        response[kCancelling](reason);
        if (settles) {
          source.destroy(new Error("The source has failed"));
          deepStrictEqual(await settled(sending), reason);
          ok(response.hasHeader("Content-Range"));
        }
        response[kCancel](reason);
        deepStrictEqual(await settled(sending), reason);
        deepStrictEqual(
          ["content-length", "content-range"].filter((name) =>
            response.hasHeader(name),
          ),
          [],
        );
        await owners.run(replacement, () =>
          within(response.send("FAILED"), deadline),
        );
        const head = connection.sent();
        ok(head.startsWith("HTTP/1.1 200 OK\r\n"), head);
        ok(/^Content-Length: 6\r$/mu.test(head), head);
        ok(!/^Content-Range:/imu.test(head), head);
      } finally {
        connection.close();
      }
    });
  }

  test("in an application, a sendFile() of the stack whose file fails once a pipe of the stack has failed is restored before the error handler replies: without the representation chosen for the file", async () => {
    /** The streams of the files, whose first chunk never comes */
    const streams: PassThrough[] = [];
    const created = Promise.withResolvers<null>();
    const { open } = fsp;
    mock.method(
      fsp,
      "open",
      async (...args: Parameters<typeof open>): Promise<FileHandle> => {
        const handle = await open(...args);
        const create = handle.createReadStream.bind(handle);
        handle.createReadStream = (
          ...options: Parameters<FileHandle["createReadStream"]>
        ): ReadStream => {
          // Closes the file once it is destroyed (it reads nothing)
          const stream = create(...options);
          const proxy = new PassThrough();
          proxy.once("close", () => {
            stream.destroy();
          });
          streams.push(proxy);
          created.resolve(null);
          return proxy as unknown as ReadStream;
        };
        return handle;
      },
    );
    syncBuiltinESMExports();
    const negotiator = new Negotiator();
    const failure = new Error("The pipe has failed");
    const sending = Promise.withResolvers<unknown>();
    /** How many times the choice was forgotten once the error handler runs */
    let forgotten: number | null = null;
    const app = new Binden({
      logger: capture().logger,
      error_handler: async (context: Context): Promise<void> => {
        ({ forgotten } = negotiator);
        await context.response.status(500).send("failed");
      },
    });
    app.use(async (context: Context) => {
      context.response[kNegotiator](negotiator);
      // Told that its response is closed once the pipe below has failed,
      // before the framework cancels its sends: its file fails then
      context.response.on("close", () => {
        streams[0]?.destroy(new Error("The file has failed"));
      });
      settled(context.response.sendFile(file)).then(
        sending.resolve,
        sending.reject,
      );
      // Once its file is sent
      await within(created.promise, deadline);
      const source = new PassThrough();
      source.pipe(context.response);
      source.prependListener("end", () => {
        throw failure;
      });
      source.end();
      await never();
    });
    const listening = await listen(app);
    try {
      const received = await send(listening.port, { ms: deadline });
      deepStrictEqual(
        [
          received.status,
          received.body,
          fileHeaders.filter((name) => name in received.headers),
        ],
        [500, "failed", ["content-length", "content-type"]],
      );
      deepStrictEqual(received.headers["content-type"], "text/plain");
    } finally {
      await listening.close();
    }
    deepStrictEqual(forgotten, 1);
    deepStrictEqual(await within(sending.promise, deadline), failure);
  });

  test("a send that has settled before its cancellation is recorded is not restored: what is set since stays", async () => {
    const connection = detached();
    const { response } = connection;
    try {
      const reason = new Error("The pipe has failed");
      const missing = join(tmp, "missing.pdf");
      const failure = (await settled(response.sendFile(missing))) as {
        code?: unknown;
      };
      deepStrictEqual(failure.code, "ENOENT");
      const source = new PassThrough();
      const streamed = response.send(source);
      source.destroy(new Error("The source has failed"));
      ok((await settled(streamed)) instanceof Error);
      response.status(404).set({
        "Content-Range": "bytes */16",
        "X-After": "kept",
      });
      response[kCancelling](reason);
      response[kCancel](reason);
      deepStrictEqual(
        [
          response.statusCode,
          response.getHeader("Content-Range"),
          response.getHeader("X-After"),
        ],
        [404, "bytes */16", "kept"],
      );
    } finally {
      connection.close();
    }
  });
});
