import type { Server as HttpServer, ServerResponse } from "node:http";
import type { Exchange } from "./exchange.js";
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
  readonly sockets: Set<Socket>;
  /** The requests in progress, with their response */
  readonly exchanges: Map<Exchange, ServerResponse>;
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
    sockets: new Set<Socket>(),
    exchanges: new Map<Exchange, ServerResponse>(),
    drained: [],
  };
  registrations.set(server, registration);
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
 * Tracks a request of a server until its cleanups have run: once the server
 * is closing, its connection is closed as soon as it is idle
 */
export function track(
  server: IServer,
  exchange: Exchange,
  response: ServerResponse,
): void {
  const registration = register(server);
  registration.exchanges.set(exchange, response);
  response.once("close", () => {
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

/** The shutdown of a server */
async function close(
  server: IServer,
  registration: IRegistration,
  timeout: number,
  cleanup_timeout: number,
): Promise<void> {
  registration.closing = true;
  for (const response of registration.exchanges.values()) {
    if (!response.headersSent) {
      // The connection closes once the response is complete
      response.setHeader("Connection", "close");
    }
  }

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
  if (!done) {
    const error = new Error(
      `The cleanup of the requests has not completed within ${cleanup_timeout} ms`,
    );
    // The report of an application does not throw
    registration.report?.("The shutdown has failed", error);
    throw error;
  }
}

/**
 * Closes a server gracefully: it stops accepting connections, closes those
 * that are idle (and every other one once its response is complete), and
 * lets the requests in progress complete within `timeout`, after which they
 * are aborted (`shutdown`) and every connection is closed. Resolves once the
 * server has closed and the cleanups of its requests have run, or rejects
 * when they take longer than `cleanup_timeout`. Another call returns the same
 * promise.
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
