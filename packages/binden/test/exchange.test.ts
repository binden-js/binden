/* eslint-disable init-declarations */
import { deepStrictEqual, ok, rejects, throws } from "node:assert";
import { once } from "node:events";
import { type Server, createServer, get } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, suite, test } from "node:test";

import {
  BindenAbortError,
  BindenRequest,
  BindenResponse,
  Context,
} from "../index.js";
import { Exchange } from "../src/exchange.js";

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
    const client = get({ port, path: "/" }, (response) => response.resume());
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
    server.listen(0);
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
    deepStrictEqual(
      errors.map(([, extra]) => (extra?.error as Error).message),
      ["A rejected cleanup", "A failing cleanup"],
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

    context.onCleanup(() => {
      ran = true;
    });
    context.onCleanup(() => {
      throw new Error("A failing cleanup");
    });

    response.end();
    await Exchange.for(request, response).finished;
    ok(ran);
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
