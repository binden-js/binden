import {
  Binden,
  BindenResponse,
  type Context,
  type IRepresentation,
  type IRepresentationNegotiator,
  kNegotiator,
  releasedFailure,
} from "../index.js";
import { Duplex, Readable } from "node:stream";
import { type ICaptured, capture, listen, within } from "./helpers.js";
import { converse, get } from "./connection.js";
import { kSeal, owners } from "../src/seal.js";
import { suite, test } from "node:test";
import { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { deepStrictEqual } from "node:assert/strict";

/** How a source cannot be read when it is sent */
type IUnreadable = "destroyed" | "errored";

/**
 * A source that nothing can be read of: destroyed, or errored without being
 * destroyed (a chunk that is not bytes, which `autoDestroy: false` keeps),
 * which records its release (its `_destroy()`, e.g. of a file that it closes)
 */
function unreadable(kind: IUnreadable): {
  source: Readable;
  /** Whether its `_destroy()` has run (it holds its resources until then) */
  released(): boolean;
} {
  let released = false;
  const source = new Readable({
    autoDestroy: false,
    read(): void {
      // Never read
    },
    destroy(error, callback): void {
      released = true;
      callback(error);
    },
  });
  source.on("error", () => {
    // Its error is `errored`
  });
  if (kind === "destroyed") {
    source.destroy();
    released = false;
  } else {
    source.push({});
  }
  return { source, released: () => released };
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

/** A response to `GET` on a connection that records nothing */
function detached(): { response: BindenResponse; close(): void } {
  const wire = new Duplex({
    read(): void {
      // The client sends nothing more
    },
    write(_chunk: Buffer, _encoding, done): void {
      done();
    },
  });
  const request = new IncomingMessage(wire as unknown as Socket);
  Object.assign(request, {
    method: "GET",
    headers: {},
    httpVersionMajor: 1,
    httpVersionMinor: 1,
  });
  const response = new BindenResponse(request);
  response.assignSocket(wire as unknown as Socket);
  return {
    response,
    close: (): void => {
      wire.destroy();
    },
  };
}

/** How a send has settled: `resolved`, or the code (else the message) of what it has rejected with */
function outcomeOf(promise: Promise<void>): Promise<unknown> {
  return promise.then(
    () => "resolved",
    (error: unknown) => {
      const { code, message } = error as { code?: unknown; message?: unknown };
      return code ?? message;
    },
  );
}

/**
 * The first response of what has been received: its framing (`chunked`, or
 * its `Content-Length`), its body, and whether exactly the reply of `/next`
 * follows it
 */
function first(received: string): [string, string, boolean] {
  const end = received.indexOf("\r\n\r\n");
  const head = received.slice(0, end).toLowerCase();
  const rest = received.slice(end + 4);
  const chunked = head.includes("\r\ntransfer-encoding: chunked");
  // Where its body ends: after its last chunk (without trailers), or its length
  const length = chunked
    ? rest.indexOf("0\r\n\r\n") + 5
    : Number(/\r\ncontent-length: (?<length>\d+)/u.exec(head)?.groups?.length);
  const framing = chunked ? "chunked" : `Content-Length: ${String(length)}`;
  const next = rest.slice(length);
  return [
    framing,
    rest.slice(0, length),
    next.startsWith("HTTP/1.1 200 OK\r\n") && next.endsWith("\r\n\r\nnext"),
  ];
}

/**
 * Runs `scenario` as the middleware of `/` (`/next` replies `next`), with
 * `/` and `/next` pipelined on one connection: what the client receives, how
 * the scenario has settled, and the logger
 */
async function run(
  scenario: (context: Context) => Promise<unknown>,
): Promise<[string, unknown, ICaptured]> {
  const captured = capture();
  const outcome = Promise.withResolvers<unknown>();
  const app = new Binden({
    logger: captured.logger,
    log_error_details: true,
  }).use(async (context: Context) => {
    if (context.url.pathname === "/next") {
      await context.text("next");
    } else {
      outcome.resolve(await scenario(context));
    }
  });
  const listening = await listen(app);
  try {
    const { received } = await converse(
      listening.port,
      `${get("/")}${get("/next")}`,
      { complete: (text) => text.endsWith("\r\n\r\nnext") },
    );
    return [received, await within(outcome.promise), captured];
  } finally {
    await listening.close();
  }
}

suite("A send of a Readable that nothing can be read of", () => {
  for (const kind of ["destroyed", "errored"] as const) {
    const error =
      kind === "destroyed"
        ? "ERR_STREAM_PREMATURE_CLOSE"
        : "ERR_INVALID_ARG_TYPE";

    test(`(${kind}) rejects before the headers are committed without the framing of its body: the work that ends the response sends an empty body, and the next response is read as such (R19-H2)`, async () => {
      const [received, outcome] = await run(async (context) => {
        const { response } = context;
        // The length of the body that it was to send
        response.setHeader("Content-Length", 3);
        const sent = await outcomeOf(context.send(unreadable(kind).source));
        const framed = response.hasHeader("Content-Length");
        response.end();
        return [sent, framed];
      });
      // An empty body (its last chunk), then the next response
      deepStrictEqual(
        [outcome, first(received)],
        [
          [error, false],
          ["chunked", "0\r\n\r\n", true],
        ],
      );
    });

    test(`(${kind}) rejects without the representation chosen for its body`, async () => {
      const connection = detached();
      const { response } = connection;
      try {
        const negotiator = new Negotiator();
        response[kNegotiator](negotiator);
        response.setHeader("Content-Length", 3);
        const sent = await outcomeOf(response.send(unreadable(kind).source));
        deepStrictEqual(
          [sent, negotiator.forgotten, response.hasHeader("Content-Length")],
          [error, 1, false],
        );
      } finally {
        connection.close();
      }
    });

    test(`(${kind}) whose code ends the work while it is checked: rejects without the framing of its body, removed with the rights of the framework`, async () => {
      const connection = detached();
      const { response } = connection;
      try {
        const work = {};
        let revoked = false;
        response[kSeal]((owner) => owner !== work || !revoked);
        const negotiator = new Negotiator();
        response[kNegotiator](negotiator);
        const { source } = unreadable(kind);
        const { destroyed } = source;
        // A getter of its own that the checks of the send read
        Object.defineProperty(source, "destroyed", {
          get(): boolean {
            revoked = true;
            return destroyed;
          },
        });
        const sent = await owners.run(work, () => {
          response.setHeader("Content-Length", 3);
          return outcomeOf(response.send(source));
        });
        // Its work, which may no longer mutate the response, forgets nothing
        deepStrictEqual(
          [sent, negotiator.forgotten, response.hasHeader("Content-Length")],
          [error, 0, false],
        );
      } finally {
        connection.close();
      }
    });
  }

  test("errored without being destroyed: rejects at once with its error, then is released (its resources freed)", async () => {
    const connection = detached();
    const { response } = connection;
    try {
      const unread = unreadable("errored");
      const { source } = unread;
      const sent = await outcomeOf(response.send(source));
      deepStrictEqual(
        [sent, source.destroyed, unread.released()],
        ["ERR_INVALID_ARG_TYPE", true, true],
      );
    } finally {
      connection.close();
    }
  });

  test("errored without being destroyed, whose code ends the response while it is checked: the send settles as the response, its error is logged once, and it is released", async () => {
    const unread = unreadable("errored");
    const { source } = unread;
    const { errored } = source;
    const [received, outcome, captured] = await run(async (context) => {
      // A getter of its own that ends the response once `send()` reads it
      Object.defineProperty(source, "errored", {
        get(): Error | null {
          context.response.end("ended");
          return errored;
        },
      });
      return outcomeOf(context.send(source));
    });
    deepStrictEqual(
      [
        received.match(/\r\n\r\n(?:ended|next)/gu),
        outcome,
        captured.records
          .filter(({ msg }) => msg === releasedFailure)
          .map(({ failure }) => (failure as { code?: unknown }).code),
        source.destroyed,
        unread.released(),
      ],
      [
        ["\r\n\r\nended", "\r\n\r\nnext"],
        "resolved",
        ["ERR_INVALID_ARG_TYPE"],
        true,
        true,
      ],
    );
  });
});
