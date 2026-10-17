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
import { capture, listen, never, pollUntil, send, within } from "./helpers.js";
import { deepStrictEqual, ok } from "node:assert/strict";
import fsp, { type FileHandle, mkdtemp, rm, writeFile } from "node:fs/promises";
import { kCancel, kCancelling } from "../src/seal.js";
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
  /** The head of what the connection has been sent, without the `Date` */
  head(): string;
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
    head: () =>
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
 * Holds the file of every `sendFile()` of a response before its first chunk:
 * its stream is destroyed (its file closed), and a `PassThrough` that sends
 * nothing until the test destroys it is sent instead (in the order of the
 * sends)
 */
function hold(response: BindenResponse): PassThrough[] {
  const held: PassThrough[] = [];
  const original = response.send.bind(response) as (
    ...args: unknown[]
  ) => Promise<void>;
  response.send = (...args: unknown[]): Promise<void> => {
    const [data, ...rest] = args;
    if (data instanceof Readable) {
      data.destroy();
      const stream = new PassThrough();
      held.push(stream);
      return original(stream, ...rest);
    }
    return original(...args);
  };
  return held;
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

/** The headers that a `sendFile()` of a range sets (its framing among them) */
const fileHeaders = [
  "accept-ranges",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
  "x-content-type-options",
];

/** The headers of a response, by their names, but `X-Before` (set by the tests before every send) */
function headersOf(response: BindenResponse): string[] {
  return response
    .getHeaderNames()
    .filter((name) => name !== "x-before")
    .sort();
}

suite("The cancellation of overlapping sends", () => {
  let tmp = "";
  /** The files of the sends, of different types (each one sets its own headers) */
  let files: string[] = [];

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), "binden-unwound-"));
    files = [
      join(tmp, "first.pdf"),
      join(tmp, "second.txt"),
      join(tmp, "third.json"),
    ];
    await Promise.all(
      files.map((file, index) => writeFile(file, "x".repeat(8 + index))),
    );
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  afterEach(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });

  /**
   * Starts a `sendFile()` of each file, one after the other, each once the
   * file before it is sent (its headers set, which the snapshot of the next
   * one holds): their outcomes, and the streams that hold them
   */
  async function overlapping(
    response: BindenResponse,
    count: number,
  ): Promise<{ outcomes: Promise<unknown>[]; held: PassThrough[] }> {
    const held = hold(response);
    const outcomes: Promise<unknown>[] = [];
    for (const file of files.slice(0, count)) {
      outcomes.push(settled(response.sendFile(file)));
      const sent = outcomes.length;
      await pollUntil(() => held.length >= sent, deadline);
    }
    return { outcomes, held };
  }

  test("two sendFile() whose files fail once their cancellation is recorded are restored as before the first: the second never reinstates the headers of the first (R19-C2)", async () => {
    const connection = detached({ range: "bytes=0-1" });
    const { response } = connection;
    try {
      response.setHeader("X-Before", "kept");
      const { outcomes, held } = await overlapping(response, 2);
      // A range of the second file, with the headers of both
      deepStrictEqual(response.statusCode, 206);
      const reason = new Error("Cancel both");
      response[kCancelling](reason);
      for (const stream of held) {
        stream.destroy(new Error("The file has failed"));
      }
      deepStrictEqual(await Promise.all(outcomes), [reason, reason]);
      response[kCancel](reason);
      deepStrictEqual([response.statusCode, headersOf(response)], [200, []]);
      await within(response.send("FAILED"), deadline);
      const head = connection.head();
      ok(head.startsWith("HTTP/1.1 200 OK\r\n"), head);
      ok(/^X-Before: kept\r$/mu.test(head), head);
      ok(/^Content-Type: text\/plain\r$/mu.test(head), head);
      ok(
        !/^(?:ETag|Last-Modified|Accept-Ranges|Content-Range|X-Content-Type-Options):/imu.test(
          head,
        ),
        head,
      );
      ok(head.endsWith("\r\n\r\nFAILED"), head);
    } finally {
      connection.close();
    }
  });

  for (const recorded of [false, true]) {
    test(`two sendFile() still in progress${recorded ? ", the second settled once their cancellation is recorded," : ""} are restored as before the first: the reply that replaces them has the status and the headers from before both`, async () => {
      const connection = detached();
      const { response } = connection;
      try {
        response.setHeader("X-Before", "kept");
        const { outcomes, held } = await overlapping(response, 2);
        const reason = new Error("Cancelled");
        if (recorded) {
          response[kCancelling](reason);
          held[1]?.destroy(new Error("The second file has failed"));
          deepStrictEqual(await outcomes[1], reason);
        }
        response[kCancel](reason);
        deepStrictEqual([response.statusCode, headersOf(response)], [200, []]);
        deepStrictEqual(await Promise.all(outcomes), [reason, reason]);
        await within(response.status(500).send("FAILED"), deadline);
        const head = connection.head();
        ok(head.startsWith("HTTP/1.1 500 Internal Server Error\r\n"), head);
        ok(/^X-Before: kept\r$/mu.test(head), head);
        ok(
          !/^(?:ETag|Last-Modified|Accept-Ranges|X-Content-Type-Options|Content-Type: application)/imu.test(
            head,
          ),
          head,
        );
      } finally {
        connection.close();
      }
    });
  }

  for (const index of [0, 1, 2]) {
    test(`three sendFile() in progress, the ${["first", "second", "third"][index] ?? ""} settled once their cancellation is recorded, are restored as before the first`, async () => {
      const connection = detached({ range: "bytes=0-1" });
      const { response } = connection;
      try {
        response.setHeader("X-Before", "kept");
        const { outcomes, held } = await overlapping(response, 3);
        // The first file sets its type, which the next ones keep
        deepStrictEqual(response.getHeader("Content-Type"), "application/pdf");
        const reason = new Error("Cancelled");
        response[kCancelling](reason);
        held[index]?.destroy(new Error("A file has failed"));
        deepStrictEqual(await outcomes[index], reason);
        // Settled: not yet restored
        deepStrictEqual(response.statusCode, 206);
        response[kCancel](reason);
        deepStrictEqual([response.statusCode, headersOf(response)], [200, []]);
        deepStrictEqual(await Promise.all(outcomes), [reason, reason, reason]);
        await within(response.send("FAILED"), deadline);
        const head = connection.head();
        ok(head.startsWith("HTTP/1.1 200 OK\r\n"), head);
        ok(/^Content-Type: text\/plain\r$/mu.test(head), head);
        ok(!/^(?:ETag|Content-Range):/imu.test(head), head);
      } finally {
        connection.close();
      }
    });
  }

  for (const recorded of [false, true]) {
    test(`the framing set before the earliest sendFile(), whose send of a second file then fails${recorded ? " once their cancellation is recorded" : ""}, is not inherited by the reply that replaces them (R2-2)`, async () => {
      const connection = detached({ range: "bytes=0-1" });
      const { response } = connection;
      try {
        response.setHeader("X-Before", "kept");
        // The framing of a body of the application, then replaced by files
        response.set({ "Content-Length": "5", "Content-Range": "bytes */10" });
        const { outcomes, held } = await overlapping(response, 2);
        const reason = new Error("Cancelled");
        if (recorded) {
          response[kCancelling](reason);
        }
        const failure = new Error("The second file has failed");
        held[1]?.destroy(failure);
        deepStrictEqual(await outcomes[1], recorded ? reason : failure);
        response[kCancel](reason);
        deepStrictEqual([response.statusCode, headersOf(response)], [200, []]);
        deepStrictEqual(await outcomes[0], reason);
        await within(response.send("FAILED"), deadline);
        const head = connection.head();
        ok(head.startsWith("HTTP/1.1 200 OK\r\n"), head);
        ok(/^Content-Length: 6\r$/mu.test(head), head);
        ok(!/^(?:Content-Range|ETag):/imu.test(head), head);
        ok(head.endsWith("\r\n\r\nFAILED"), head);
      } finally {
        connection.close();
      }
    });
  }

  test("a send of a stream in progress is cancelled without its representation, forgotten once", async () => {
    const connection = detached();
    const { response } = connection;
    try {
      const negotiator = new Negotiator();
      response[kNegotiator](negotiator);
      response.setHeader("Content-Length", 8);
      const sending = settled(response.send(new PassThrough()));
      const reason = new Error("Cancelled");
      response[kCancel](reason);
      deepStrictEqual(
        [
          await sending,
          negotiator.forgotten,
          response.hasHeader("Content-Length"),
        ],
        [reason, 1, false],
      );
    } finally {
      connection.close();
    }
  });

  test("two sendFile() in progress are cancelled without the representation chosen for their files, forgotten once", async () => {
    const connection = detached();
    const { response } = connection;
    try {
      const negotiator = new Negotiator();
      response[kNegotiator](negotiator);
      const { outcomes } = await overlapping(response, 2);
      const reason = new Error("Cancelled");
      response[kCancel](reason);
      deepStrictEqual(
        [
          await Promise.all(outcomes),
          negotiator.forgotten,
          headersOf(response),
        ],
        [[reason, reason], 1, []],
      );
    } finally {
      connection.close();
    }
  });

  test("a sendFile() cancelled before its file is opened is restored without the framing set before it, and its representation is forgotten", async () => {
    const connection = detached();
    const { response } = connection;
    try {
      const negotiator = new Negotiator();
      response[kNegotiator](negotiator);
      response.setHeader("Content-Length", 5);
      const sending = settled(response.sendFile(files[0] ?? ""));
      const reason = new Error("Cancelled");
      response[kCancel](reason);
      deepStrictEqual(
        [await sending, negotiator.forgotten, headersOf(response)],
        [reason, 1, []],
      );
    } finally {
      connection.close();
    }
  });

  test("in an application, two sendFile() of the stack in progress once a pipe of the stack fails are replaced by the reply of the error handler without the headers of either file", async () => {
    /** The streams of the files, whose first chunk never comes */
    const streams: PassThrough[] = [];
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
          return proxy as unknown as ReadStream;
        };
        return handle;
      },
    );
    syncBuiltinESMExports();
    const failure = new Error("The pipe has failed");
    const outcomes: Promise<unknown>[] = [];
    const app = new Binden({
      logger: capture().logger,
      error_handler: async (context: Context): Promise<void> => {
        await context.response.status(500).send("failed");
      },
    });
    app.use(async (context: Context) => {
      for (const file of files.slice(0, 2)) {
        outcomes.push(settled(context.response.sendFile(file)));
        const sent = outcomes.length;
        // Once its file is sent: its headers are set
        await pollUntil(() => streams.length >= sent, deadline);
      }
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
          received.headers["content-type"],
        ],
        [500, "failed", ["content-length", "content-type"], "text/plain"],
      );
    } finally {
      await listening.close();
    }
    deepStrictEqual(await Promise.all(outcomes), [failure, failure]);
  });
});
