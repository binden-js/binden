import { type EventEmitter, errorMonitor } from "node:events";
import { kFramework, kListen } from "./seal.js";
import type { BindenResponse } from "./response.js";
import type { Exchange } from "./exchange.js";
import type { Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import type { Socket } from "node:net";
import { validateDelay } from "./delay.js";

/** A server that `shutdown()` closes */
export type IServer = HttpServer | HttpsServer;

/** The options of `shutdown()` */
export interface IShutdownOptions {
  /**
   * The milliseconds that the requests in progress have to complete
   * (`10000`): then they are aborted (`shutdown`) and every connection closed
   */
  timeout?: number | undefined;
  /**
   * The milliseconds that the cleanups of the requests have to complete once
   * the server has closed (`1000`): then `shutdown()` rejects
   */
  cleanup_timeout?: number | undefined;
}

/** Reports a failure of a shutdown (e.g. to the logger of the application) */
export type IShutdownReport = (message: string, error: unknown) => void;

/** What is known of a server: its connections and requests, and its shutdown */
interface IRegistration {
  closing: boolean;
  promise: Promise<void> | null;
  report: IShutdownReport | null;
  /**
   * Whether a `listen()` has not completed yet (e.g. while the address of a
   * host name is looked up)
   */
  pending: boolean;
  readonly sockets: Set<Socket>;
  /** The requests in progress, with their response */
  readonly exchanges: Map<Exchange, BindenResponse>;
  /** The newest response of every connection (with the latest request) */
  readonly newest: WeakMap<Socket, BindenResponse>;
  /**
   * The responses that close their connection because the server is closing,
   * with their own `shouldKeepAlive`
   */
  readonly kept: WeakMap<BindenResponse, boolean>;
  /** Called once no connection is left */
  readonly drained: (() => void)[];
}

const registrations = new WeakMap<object, IRegistration>();

/**
 * Registers a server (once): its connections are tracked from now on,
 * including those that are upgraded (e.g. WebSocket) or tunnelled (`CONNECT`)
 */
export function register(
  server: IServer,
  report: IShutdownReport | null = null,
): IRegistration {
  const found = registrations.get(server);
  if (found) {
    found.report ??= report;
    return found;
  }
  const registration: IRegistration = {
    closing: false,
    promise: null,
    report,
    pending: false,
    sockets: new Set<Socket>(),
    exchanges: new Map<Exchange, BindenResponse>(),
    newest: new WeakMap<Socket, BindenResponse>(),
    kept: new WeakMap<BindenResponse, boolean>(),
    drained: [],
  };
  registrations.set(server, registration);
  const listen = server.listen.bind(server);
  server.listen = ((...args: unknown[]): IServer => {
    Reflect.apply(listen, server, args);
    // Bound later, e.g. once the address of a host name has been looked up
    // (a `listen()` that throws is not pending)
    registration.pending = !server.listening;
    return server;
  }) as typeof server.listen;
  const settled = (): void => {
    registration.pending = false;
  };
  // `errorMonitor`: an `error` without a listener of the application still
  // throws, as it would without this one
  server.on("listening", settled).on("close", settled);
  (server as EventEmitter).on(errorMonitor, settled);
  server.on("connection", (socket: Socket) => {
    registration.sockets.add(socket);
    socket.once("close", () => {
      registration.sockets.delete(socket);
      if (registration.sockets.size === 0) {
        for (const drained of registration.drained.splice(0)) {
          drained();
        }
      }
    });
  });
  return registration;
}

/**
 * Makes a response close its connection once it is complete (`Connection:
 * close`), unless its headers have been sent: decided by Node.js when they
 * are, so that it applies to the newest response of the connection then
 */
function closesConnection(
  registration: IRegistration,
  response: BindenResponse,
): void {
  if (!response.headersSent && !registration.kept.has(response)) {
    registration.kept.set(response, response.shouldKeepAlive);
    // Also once the response is sealed (e.g. for the reply of a deadline)
    response[kFramework](() => {
      response.shouldKeepAlive = false;
    });
  }
}

/**
 * Tracks a request of a server until its cleanups have run: once the server
 * is closing, its connection is closed as soon as it is idle
 */
export function track(
  server: IServer,
  exchange: Exchange,
  response: BindenResponse,
): void {
  const registration = register(server);
  registration.exchanges.set(exchange, response);
  // The requests of a connection are emitted in their order: once the server
  // is closing, its newest one closes it, so that the pipelined requests
  // before it get their responses
  const { socket } = response.req;
  const previous = registration.newest.get(socket);
  registration.newest.set(socket, response);
  if (
    typeof previous !== "undefined" &&
    registration.kept.has(previous) &&
    !previous.headersSent
  ) {
    // A request that arrives once closing (its `503` closes the connection):
    // the response before it, unless its headers have been sent, keeps the
    // connection open for it
    const kept = registration.kept.get(previous) as boolean;
    previous[kFramework](() => {
      previous.shouldKeepAlive = kept;
    });
    registration.kept.delete(previous);
  }
  response[kListen]("close", () => {
    if (registration.closing) {
      // Once the connection is idle (e.g. kept alive after its response)
      setImmediate(() => {
        server.closeIdleConnections();
      });
    }
  });
  const forget = (): void => {
    registration.exchanges.delete(exchange);
  };
  // Settles once the cleanups have run (it never rejects)
  exchange.finished.then(forget, forget);
}

/** Whether `shutdown()` has been called for a server */
export function isClosing(server: IServer): boolean {
  return registrations.get(server)?.closing ?? false;
}

/**
 * Settles once a pending `listen()` has completed: `null` once the server is
 * listening (or closed), or the error of a `listen()` that has failed (which
 * the shutdown reports). A `listen()` that has not completed within `timeout`
 * milliseconds is cancelled, with an error: the server is closed, so that an
 * address looked up later is not bound (Node.js ignores it). Its listeners are
 * removed then.
 */
async function bound(
  server: IServer,
  timeout: number,
): Promise<{ error: unknown } | null> {
  const { promise, resolve } = Promise.withResolvers<{
    error: unknown;
  } | null>();
  const settled = (): void => {
    resolve(null);
  };
  const failed = (error: unknown): void => {
    resolve({ error });
  };
  server
    .once("listening", settled)
    .once("close", settled)
    .once("error", failed);
  const timer = setTimeout(() => {
    const message = `The server has not started listening within ${timeout} ms`;
    resolve({ error: new Error(message) });
    server.close();
  }, timeout);
  try {
    return await promise;
  } finally {
    clearTimeout(timer);
    server.off("listening", settled).off("close", settled).off("error", failed);
  }
}

/**
 * Closes the server and its connections: those that are idle at once, the
 * others once their responses are complete or `timeout` has passed
 */
async function drain(
  server: IServer,
  registration: IRegistration,
  timeout: number,
): Promise<void> {
  // Before `listen()` (or once closed), there is nothing to close but the
  // connections that are left
  const closed = server.listening
    ? new Promise<void>((resolve) => {
        server.once("close", resolve);
      })
    : new Promise<void>((resolve) => {
        if (registration.sockets.size === 0) {
          resolve();
        } else {
          registration.drained.push(resolve);
        }
      });
  if (server.listening) {
    server.close();
  }
  server.closeIdleConnections();

  const timer = setTimeout(() => {
    for (const exchange of registration.exchanges.keys()) {
      exchange.abort("shutdown");
    }
    server.closeAllConnections();
    for (const socket of registration.sockets) {
      socket.destroy();
    }
  }, timeout);
  try {
    await closed;
  } finally {
    clearTimeout(timer);
  }
}

/** The shutdown of a server */
async function close(
  server: IServer,
  registration: IRegistration,
  timeout: number,
  cleanup_timeout: number,
): Promise<void> {
  registration.closing = true;
  for (const response of registration.exchanges.values()) {
    if (registration.newest.get(response.req.socket) === response) {
      closesConnection(registration, response);
    }
  }
  // A server that is about to listen is closed once it listens, but not
  // waited for when its `listen()` fails (or takes longer than `timeout`):
  // its error rejects the shutdown. The `timeout` covers both waits.
  const start = performance.now();
  const failure = registration.pending ? await bound(server, timeout) : null;
  if (failure === null) {
    const left = Math.max(0, timeout - (performance.now() - start));
    await drain(server, registration, left);
  }

  // The cleanups run once the responses are closed: they must not take long
  const { promise: expired, resolve } = Promise.withResolvers<boolean>();
  const cleanup = setTimeout(resolve, cleanup_timeout, false);
  const done = await Promise.race([
    Promise.all(
      [...registration.exchanges.keys()].map(
        async (exchange) => exchange.finished,
      ),
    ).then(() => true),
    expired,
  ]);
  clearTimeout(cleanup);
  const failed = done
    ? failure
    : {
        error: new Error(
          `The cleanup of the requests has not completed within ${cleanup_timeout} ms`,
        ),
      };
  if (failed !== null) {
    // The report of an application does not throw
    registration.report?.("The shutdown has failed", failed.error);
    throw failed.error;
  }
}

/**
 * Closes a server gracefully: it stops accepting connections, closes those
 * that are idle (and every other one once its response is complete), and
 * lets the requests in progress complete within `timeout`, after which they
 * are aborted (`shutdown`) and every connection is closed. Resolves once the
 * server has closed and the cleanups of its requests have run, or rejects
 * when they take longer than `cleanup_timeout`. Another call returns the same
 * promise. The server must be registered (see `Binden.callback()`) before its
 * `listen()`: a `listen()` in progress then is closed once it listens, or
 * cancelled (with an error) once `timeout` has passed.
 */
export function shutdown(
  server: IServer,
  { timeout = 10_000, cleanup_timeout = 1000 }: IShutdownOptions = {},
): Promise<void> {
  validateDelay("timeout", timeout, 1);
  validateDelay("cleanup_timeout", cleanup_timeout, 1);
  const registration = register(server);
  registration.promise ??= close(
    server,
    registration,
    timeout,
    cleanup_timeout,
  );
  return registration.promise;
}
