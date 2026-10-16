/* eslint-disable init-declarations */
import { type AddressInfo, Socket } from "node:net";
import {
  BindenAbortError,
  BindenRequest,
  BindenResponse,
  Context,
} from "../index.js";
import { IncomingMessage, type Server, createServer, get } from "node:http";
import { afterEach, beforeEach, suite, test } from "node:test";
import { deepStrictEqual, ok, rejects, throws } from "node:assert";
import { Exchange } from "../src/exchange.js";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { within } from "./helpers.js";

type IServer = Server<typeof BindenRequest, typeof BindenResponse>;

/** Resolves after `ms` milliseconds */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A function that does nothing */
function nothing(): void {
  // Nothing to do
}
type IPair = [BindenRequest, BindenResponse<BindenRequest>];

/** A logger that keeps its error records */
function recorder(): {
  errors: [string, Record<string, unknown> | undefined][];
  logger: Context["log"];
} {
  const errors: [string, Record<string, unknown> | undefined][] = [];
  const noop = (): void => {
    // Not recorded
  };
  const logger: Context["log"] = {
    fatal: noop,
    error: (message: string, extra?: Record<string, unknown>): void => {
      errors.push([message, extra]);
    },
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    child: (): Context["log"] => logger,
  };
  return { errors, logger };
}

suite("Exchange", () => {
  let server: IServer;
  let port = 0;

  /** The next request of the server, sent by `get()`, with its client request */
  const exchange = async (): Promise<
    IPair & { client: ReturnType<typeof get> }
  > => {
    const pending = once(server, "request") as Promise<IPair>;
    const client = get({ host: "127.0.0.1", port, path: "/" }, (response) =>
      response.resume(),
    );
    client.on("error", () => {
      // Aborted by the test
    });
    const [request, response] = await pending;
    return Object.assign([request, response] as IPair, { client });
  };

  beforeEach(async () => {
    server = createServer({
      IncomingMessage: BindenRequest,
      ServerResponse: BindenResponse,
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    ({ port } = server.address() as AddressInfo);
  });

  afterEach(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  });

  test("the signal is aborted when the client goes away first", async () => {
    const pair = await exchange();
    const context = new Context({ request: pair[0], response: pair[1] });
    ok(!context.signal.aborted);

    pair.client.destroy();
    await once(context.signal, "abort");

    const { reason } = context.signal as { reason: unknown };
    ok(reason instanceof BindenAbortError);
    deepStrictEqual(reason.reason, "client_closed");
    deepStrictEqual(reason.name, "BindenAbortError");
  });

  test("the signal is not aborted by a complete response", async () => {
    const [request, response] = await exchange();
    const context = new Context({ request, response });

    response.end("ok");
    await once(response, "close");
    await Exchange.for(request, response).finished;

    ok(!context.signal.aborted);
    deepStrictEqual(Exchange.for(request, response).phase, "finished");
  });

  test("setTimeout() aborts the signal with `deadline`", async () => {
    const [request, response] = await exchange();
    const context = new Context({ request, response });

    context.setTimeout(10_000);
    // Restarted: the shorter deadline wins
    context.setTimeout(5);
    await once(context.signal, "abort");
    const { reason } = context.signal as { reason: BindenAbortError };
    deepStrictEqual(reason.reason, "deadline");

    // Already aborted: another deadline changes nothing
    context.setTimeout(1);
    response.end();
    await Exchange.for(request, response).finished;
    deepStrictEqual(reason.reason, "deadline");
  });

  test("setTimeout(0) removes the deadline", async () => {
    const [request, response] = await exchange();
    const context = new Context({ request, response });

    context.setTimeout(5);
    context.setTimeout(0);
    await sleep(30);
    ok(!context.signal.aborted);
    response.end();
    await Exchange.for(request, response).finished;
    ok(!context.signal.aborted);
  });

  test("a deadline is cleared once the response is closed", async () => {
    const [request, response] = await exchange();
    const context = new Context({ request, response });

    context.setTimeout(20);
    response.end();
    await Exchange.for(request, response).finished;
    await sleep(40);
    ok(!context.signal.aborted);
  });

  test("setTimeout() validates the delay and the state of the request", async () => {
    const [request, response] = await exchange();
    const context = new Context({ request, response });

    throws(() => {
      context.setTimeout(1.5);
    }, TypeError);
    throws(() => {
      context.setTimeout(Number.NaN);
    }, TypeError);
    throws(() => {
      context.setTimeout(-1);
    }, RangeError);
    throws(() => {
      context.setTimeout(2 ** 31);
    }, RangeError);
    context.setTimeout(2 ** 31 - 1);
    context.setTimeout(0);

    response.end();
    await Exchange.for(request, response).finished;
    throws(() => {
      context.setTimeout(10);
    }, TypeError);
  });

  test("the cleanups run once, one at a time, the last registered first", async () => {
    const [request, response] = await exchange();
    const { errors, logger } = recorder();
    const context = new Context({ request, response, logger });
    const order: string[] = [];

    context.onCleanup(() => {
      order.push("first");
    });
    context.onCleanup(async () => {
      order.push("second:start");
      await sleep(10);
      order.push("second:end");
    });
    context.onCleanup(() => {
      throw new Error("A failing cleanup");
    });
    context.onCleanup(() => Promise.reject(new Error("A rejected cleanup")));

    response.end();
    await Exchange.for(request, response).finished;

    deepStrictEqual(order, ["second:start", "second:end", "first"]);
    deepStrictEqual(
      errors.map(([message]) => message),
      [
        "A cleanup of the request has failed",
        "A cleanup of the request has failed",
      ],
    );
    // Without the details of the errors
    deepStrictEqual(
      errors.map(([, extra]) => extra?.failure),
      [
        { type: "Error", location: "cleanup" },
        { type: "Error", location: "cleanup" },
      ],
    );

    throws(() => {
      context.onCleanup(nothing);
    }, TypeError);
  });

  test("a failing logger does not stop the cleanups", async () => {
    const [request, response] = await exchange();
    const { logger } = recorder();
    const failing: Context["log"] = {
      ...logger,
      error: (): never => {
        throw new Error("The logger fails");
      },
      child: (): Context["log"] => failing,
    };
    const context = new Context({ request, response, logger: failing });
    let ran = false;
    let reported = false;

    context.onCleanup(() => {
      ran = true;
    });
    context.onCleanup(() => {
      throw new Error("A failing cleanup");
    });

    response.end();
    await Exchange.for(request, response).finished;
    ok(ran);

    // Nor a report that fails
    const [otherRequest, otherResponse] = await exchange();
    const other = new Context({
      request: otherRequest,
      response: otherResponse,
      report: (): never => {
        reported = true;
        throw new Error("The report fails");
      },
    });
    let otherRan = false;
    other.onCleanup(() => {
      otherRan = true;
    });
    other.onCleanup(() => {
      throw new Error("A failing cleanup");
    });
    otherResponse.end();
    await Exchange.for(otherRequest, otherResponse).finished;
    deepStrictEqual([otherRan, reported], [true, true]);
  });

  test("a cleanup cannot be registered while the cleanups run", async () => {
    const [request, response] = await exchange();
    const context = new Context({ request, response });
    let late: unknown = null;

    context.onCleanup(() => {
      try {
        context.onCleanup(nothing);
      } catch (error: unknown) {
        late = error;
      }
    });

    response.end();
    await Exchange.for(request, response).finished;
    ok(late instanceof TypeError);
  });

  test("onCleanup() accepts functions only", async () => {
    const [request, response] = await exchange();
    const context = new Context({ request, response });

    throws(() => {
      context.onCleanup(null as unknown as () => void);
    }, TypeError);
    response.end();
  });

  test("the contexts of a request share its state", async () => {
    const [request, response] = await exchange();
    const state = { user: "alice" };
    const first = new Context<{ user: string }>({ request, response, state });
    const second = new Context<{ user: string }>({
      request,
      response,
      state: { user: "bob" },
    });

    deepStrictEqual(second.state, state);
    ok(first.signal === second.signal);

    second.done = true;
    ok(first.done);
    first.done = false;
    ok(second.done);

    deepStrictEqual(first.params, {});
    deepStrictEqual(first.mount_path, "");
    response.end();
  });

  test("the default state is an empty object", async () => {
    const [request, response] = await exchange();
    const context = new Context({ request, response });

    deepStrictEqual(context.state, {});
    response.end();
  });

  test("the exchange of a request refuses another response", async () => {
    const [request, response] = await exchange();
    const [, other] = await exchange();
    deepStrictEqual(new Context({ request, response }).response, response);

    throws(
      () => new Context({ request, response: other }),
      new TypeError("The response is not the one of the request"),
    );
    response.end();
    other.end();
  });

  test("the routing state of the exchange", async () => {
    const [request, response] = await exchange();
    const exchangeOf = Exchange.for(request, response);
    const params = { id: "1" };

    exchangeOf.params = params;
    params.id = "2";
    deepStrictEqual(exchangeOf.params, { id: "1" });
    ok(Object.isFrozen(exchangeOf.params));

    exchangeOf.mount_path = "/users/1";
    exchangeOf.mount_template = "/users/:id";
    deepStrictEqual(exchangeOf.mount_path, "/users/1");
    deepStrictEqual(exchangeOf.mount_template, "/users/:id");
    deepStrictEqual(exchangeOf.phase, "running");
    response.end();
  });

  test("an exchange without a reporter ignores the failures of its cleanups", async () => {
    const [request, response] = await exchange();
    const exchangeOf = Exchange.for(request, response);
    let ran = false;

    exchangeOf.onCleanup(() => {
      ran = true;
    });
    exchangeOf.onCleanup(() => {
      throw new Error("A failing cleanup");
    });
    response.end();
    await exchangeOf.finished;
    ok(ran);
  });

  test("find() finds the exchange of a request only", async () => {
    const [request, response] = await exchange();
    deepStrictEqual(Exchange.find(request), null);
    const created = Exchange.for(request, response);
    ok(Exchange.find(request) === created);
    response.end();
  });

  test("`aborted` settles once the signal is aborted", async () => {
    const [request, response] = await exchange();
    const exchangeOf = Exchange.for(request, response);
    let settled = false;
    const aborted = exchangeOf.aborted.then(() => {
      settled = true;
    });
    await sleep(5);
    ok(!settled);
    exchangeOf.abort("deadline");
    await aborted;
    ok(settled);
    response.end();
  });

  test("once sealed, only the work of the latest reply() may reply", async () => {
    const [request, response] = await exchange();
    const exchangeOf = Exchange.for(request, response);

    // Not sealed: anything may reply
    ok(exchangeOf.may_reply);
    ok(exchangeOf.reply(() => exchangeOf.may_reply));

    exchangeOf.seal();
    ok(!exchangeOf.may_reply);

    let resume: () => void = nothing;
    const earlier = exchangeOf.reply(async () => {
      ok(exchangeOf.may_reply);
      await new Promise<void>((resolve) => {
        resume = resolve;
      });
      return exchangeOf.may_reply;
    });
    // The latest reply (and its asynchronous work) may reply
    deepStrictEqual(
      await exchangeOf.reply(async () => {
        await sleep(1);
        return exchangeOf.may_reply;
      }),
      true,
    );
    // An earlier one no longer may
    resume();
    deepStrictEqual(await earlier, false);

    // Sealed again: no reply may reply
    const latest = exchangeOf.reply(async () => {
      exchangeOf.seal();
      await sleep(1);
      return exchangeOf.may_reply;
    });
    deepStrictEqual(await latest, false);
    ok(!exchangeOf.may_reply);
    response.end();
  });

  test("its tokens stay issued once revoked, those of another exchange never are", async () => {
    const [request, response] = await exchange();
    const exchangeOf = Exchange.for(request, response);
    const token = exchangeOf.token();
    ok(exchangeOf.issued(token));
    exchangeOf.seal();
    ok(exchangeOf.issued(token));
    ok(!exchangeOf.issued({}));
    response.end();
  });

  test("abort() aborts once", async () => {
    const [request, response] = await exchange();
    const exchangeOf = Exchange.for(request, response);

    ok(exchangeOf.abort("shutdown"));
    ok(!exchangeOf.abort("deadline"));
    const { reason } = exchangeOf.signal as { reason: BindenAbortError };
    deepStrictEqual(reason.reason, "shutdown");
    response.end();
    await rejects(
      Promise.reject(reason),
      (error: unknown) => error instanceof BindenAbortError,
    );
  });
});

suite("The connection of an exchange", () => {
  /** A request on a connection (a socket of its own), and its response */
  const detached = (
    socket = new Socket(),
  ): { socket: Socket; request: IncomingMessage; response: BindenResponse } => {
    const request = new IncomingMessage(socket);
    return { socket, request, response: new BindenResponse(request) };
  };

  /**
   * Gives a response a socket of its own, which closes it once destroyed
   * (on every Node.js, unlike a response without one)
   */
  const assigned = (response: BindenResponse): BindenResponse => {
    response.assignSocket(new Socket());
    return response;
  };

  test("a response that waits for its socket is closed once, when the connection closes", async () => {
    const { socket, request, response } = detached();
    const exchange = Exchange.for(request, response);
    let cleaned = 0;
    exchange.onCleanup(() => {
      cleaned += 1;
    });
    const closes: unknown[] = [];
    response.on("close", () => {
      closes.push(response.destroyed);
    });
    ok(!exchange.terminating);
    socket.emit("close");
    ok(exchange.terminating);
    socket.emit("close");
    await within(exchange.finished);
    deepStrictEqual([cleaned, closes], [1, [true]]);
    ok(response.closed);
    deepStrictEqual(
      (exchange.signal.reason as BindenAbortError).reason,
      "client_closed",
    );
  });

  test("a response whose socket never closes it is closed by the framework", async () => {
    const { socket, request, response } = detached();
    const exchange = Exchange.for(request, response);
    // A socket whose destroy does not close it (as Node.js 24.14 leaves a
    // response that has no socket)
    const lasting = new PassThrough();
    lasting.destroy = (): PassThrough => lasting;
    response.assignSocket(lasting as unknown as Socket);
    socket.emit("close");
    await within(exchange.finished);
    ok(response.closed && response.destroyed);
  });

  test("its responses share one listener of the connection, removed once they are closed", async () => {
    const socket = new Socket();
    const before = socket.listenerCount("close");
    const first = detached(socket);
    const second = detached(socket);
    const one = Exchange.for(first.request, first.response);
    const two = Exchange.for(second.request, second.response);
    deepStrictEqual(socket.listenerCount("close"), before + 1);
    assigned(first.response).destroy();
    await within(one.finished);
    deepStrictEqual(socket.listenerCount("close"), before + 1);
    assigned(second.response).destroy();
    await within(two.finished);
    deepStrictEqual(socket.listenerCount("close"), before);
    // A new exchange of the connection observes it again
    const third = detached(socket);
    const exchange = Exchange.for(third.request, third.response);
    deepStrictEqual(socket.listenerCount("close"), before + 1);
    socket.emit("close");
    await within(exchange.finished);
    deepStrictEqual(socket.listenerCount("close"), before);
  });

  test("a request without a socket has no connection to observe", async () => {
    const request = new IncomingMessage(null as unknown as Socket);
    const response = new BindenResponse(request);
    const exchange = Exchange.for(request, response);
    assigned(response).destroy();
    await within(exchange.finished);
    ok(!exchange.terminating);
  });

  test("a shutdown terminates it before its abort listeners run", () => {
    const { request, response } = detached();
    const exchange = Exchange.for(request, response);
    const seen: boolean[] = [];
    exchange.signal.addEventListener("abort", () => {
      seen.push(exchange.terminating);
    });
    ok(exchange.abort("shutdown"));
    deepStrictEqual(seen, [true]);
    // Not another reason
    const other = detached();
    const deadline = Exchange.for(other.request, other.response);
    ok(deadline.abort("deadline"));
    ok(!deadline.terminating);
  });
});
