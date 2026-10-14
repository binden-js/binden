import { once } from "node:events";
import {
  type IncomingHttpHeaders,
  IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  createServer,
  request as httpRequest,
} from "node:http";
import type { AddressInfo } from "node:net";

import { BindenRequest, BindenResponse } from "../index.js";

/** A response as the client receives it */
export interface IReply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

export interface IRequestOptions {
  readonly method?: string;
  readonly path?: string;
  readonly headers?: OutgoingHttpHeaders;
}

export type IHandler = (
  request: IncomingMessage,
  response: BindenResponse,
) => unknown;

/** A server of `BindenResponse` (and `BindenRequest`, unless `plain`) */
export interface ITestServer {
  readonly url: string;
  /**
   * Handles the next request: settles with `null` once the handler has
   * settled, or with what it has thrown (never rejects)
   */
  handle(handler: IHandler): Promise<unknown>;
  request(options?: IRequestOptions): Promise<IReply>;
  close(): Promise<void>;
}

export interface IListenOptions {
  /** `IncomingMessage` instead of `BindenRequest` */
  readonly plain?: boolean;
  readonly Response?: new (request: IncomingMessage) => BindenResponse;
}

/** Starts a server on a random port of `localhost` */
export async function listen({
  plain = false,
  Response = BindenResponse,
}: IListenOptions = {}): Promise<ITestServer> {
  const handlers: [IHandler, (outcome: unknown) => void][] = [];
  const server: Server = createServer({
    ServerResponse: Response as typeof BindenResponse,
    ...(plain ? {} : { IncomingMessage: BindenRequest }),
  });
  server.on("request", (request: IncomingMessage, response: BindenResponse) => {
    const next = handlers.shift();
    if (typeof next === "undefined") {
      response.statusCode = 500;
      response.end();
      return;
    }
    const [handler, settle] = next;
    new Promise((resolve) => {
      resolve(handler(request, response));
    }).then(
      () => {
        settle(null);
      },
      (error: unknown) => {
        settle(error);
      },
    );
  });
  server.listen(0, "localhost");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const url = `http://localhost:${port}`;

  return {
    url,
    handle: (handler) =>
      new Promise<unknown>((resolve) => {
        handlers.push([handler, resolve]);
      }),
    request: ({ method = "GET", path = "/", headers = {} } = {}) =>
      new Promise<IReply>((resolve, reject) => {
        const req = httpRequest(`${url}${path}`, {
          method,
          headers,
          signal: AbortSignal.timeout(5000),
        });
        req
          .on("response", (response) => {
            const chunks: Buffer[] = [];
            response
              .on("data", (chunk: Buffer) => chunks.push(chunk))
              .once("end", () => {
                resolve({
                  status: response.statusCode ?? 0,
                  headers: response.headers,
                  body: Buffer.concat(chunks),
                });
              })
              .once("error", reject);
          })
          .once("error", reject)
          .end();
      }),
    close: async (): Promise<void> => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}
