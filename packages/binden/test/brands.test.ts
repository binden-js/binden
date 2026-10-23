import {
  Binden,
  BindenRequest,
  BindenResponse,
  Context,
  serializers,
} from "../index.js";
import { deepStrictEqual, ok } from "node:assert/strict";
import { listen, send, within } from "./helpers.js";
import { suite, test } from "node:test";
import type { ILogger } from "@binden/logger";
import { Socket } from "node:net";
import { createServer } from "node:http";
import { runInNewContext } from "node:vm";

/** A value of any type, given in place of the one that a method declares */
function given<T>(value: unknown): T {
  return value as T;
}

/** What `new Context()` throws for its options (or the context it creates) */
function refusal(options: object): Context | [string, string] {
  try {
    return new Context(given(options));
  } catch (error: unknown) {
    const { name, message } = error as Error;
    return [name, message];
  }
}

/** An object made with `Object.create()` of the prototype of a class */
function fabricated(type: { readonly prototype: object }): object {
  return Object.create(type.prototype) as object;
}

/** The same, made in another realm */
function foreign(type: { readonly prototype: object }): object {
  return runInNewContext("Object.create(prototype)", {
    prototype: type.prototype,
  }) as object;
}

/** A proxy that records the traps that run (none of which changes anything) */
function recording<T extends object>(target: T, traps: string[]): T {
  const handler = new Proxy(
    {},
    {
      get(_handler: object, trap: string): null {
        traps.push(trap);
        return null;
      },
    },
  );
  return new Proxy(target, handler);
}

suite(
  "binden tells its requests, responses and contexts by their private brands (R28-C2)",
  () => {
    test("new Context() refuses an object made with Object.create() of a prototype of binden, of another realm, or a proxy, without running a trap", () => {
      const request = new BindenRequest(new Socket());
      const response = new BindenResponse(request);
      const traps: string[] = [];
      deepStrictEqual(
        [
          refusal({ request: fabricated(BindenRequest), response }),
          // It was accepted, and crashed the process at the next tick
          refusal({ request, response: fabricated(BindenResponse) }),
          refusal({
            request: fabricated(BindenRequest),
            response: fabricated(BindenResponse),
          }),
          refusal({ request: foreign(BindenRequest), response }),
          refusal({ request, response: foreign(BindenResponse) }),
          refusal({ request: recording(request, traps), response }),
          refusal({ request, response: recording(response, traps) }),
          traps,
        ],
        [
          ["TypeError", "`request` is not a BindenRequest: (an object)"],
          ["TypeError", "`response` is not a BindenResponse: (an object)"],
          ["TypeError", "`request` is not a BindenRequest: (an object)"],
          ["TypeError", "`request` is not a BindenRequest: (an object)"],
          ["TypeError", "`response` is not a BindenResponse: (an object)"],
          ["TypeError", "`request` is not a BindenRequest: (an object)"],
          ["TypeError", "`response` is not a BindenResponse: (an object)"],
          [],
        ],
      );
    });

    test("new Context() accepts the instances of subclasses (also with frozen prototypes), and those of the classes of an application", () => {
      class Request extends BindenRequest {}
      class Response extends BindenResponse<BindenRequest> {}
      Object.freeze(Request.prototype);
      Object.freeze(Response.prototype);
      const request = new Request(new Socket());
      const response = new Response(request);
      const context = new Context({ request, response });
      ok(context.request === request && context.response === response);
      const { IncomingMessage: AppRequest, ServerResponse: AppResponse } =
        new Binden().serverOptions();
      const own = new AppRequest(new Socket());
      const reply = new AppResponse(own);
      const created = new Context({ request: own, response: reply });
      ok(created.request === own && created.response === reply);
    });

    test("the serializer of a context describes by its type an object made with Object.create() of the prototype of Context, and a proxy of one: a subclass is serialized", () => {
      const request = new BindenRequest(new Socket());
      request.method = "GET";
      request.url = "/path?query=secret";
      const response = new BindenResponse(request);
      class Derived extends Context {}
      const context = new Derived({ request, response });
      deepStrictEqual(
        [
          serializers.context(fabricated(Context)),
          serializers.context(foreign(Context)),
          serializers.context(new Proxy(context, {})),
          serializers.context(context),
        ],
        [
          { type: "object" },
          { type: "object" },
          { type: "object" },
          {
            id: context.id,
            request: { method: "GET", path: "/path" },
            response: { status: 200 },
          },
        ],
      );
    });

    test("the listener of callback() refuses an object made with Object.create() of the prototype of a class of the application, and an instance of a class of another one; it handles the instances of their subclasses", async () => {
      const errors: string[] = [];
      const ignore = (): null => null;
      const logger: ILogger = {
        fatal: ignore,
        error: (message: string): void => {
          errors.push(message);
        },
        warn: ignore,
        info: ignore,
        debug: ignore,
        trace: ignore,
        child: (): ILogger => logger,
      };
      const app = new Binden({ logger }).use((context) =>
        context.send("handled"),
      );
      const listener = app.callback(createServer());
      const { IncomingMessage: Request, ServerResponse: Response } =
        app.serverOptions();
      const other = new Binden().serverOptions();
      const destroyed: boolean[] = [];
      for (const kind of ["fabricated", "other request", "other response"]) {
        const socket = new Socket();
        const request =
          kind === "other request"
            ? new other.IncomingMessage(socket)
            : new Request(socket);
        const response =
          kind === "fabricated"
            ? given<BindenResponse>(fabricated(Response))
            : kind === "other response"
              ? new other.ServerResponse(request)
              : new Response(request);
        listener(request, response);
        destroyed.push(socket.destroyed);
      }
      deepStrictEqual(
        [destroyed, errors],
        [
          [true, true, true],
          Array.from(
            { length: 3 },
            () =>
              "The request and the response are not those of the application (`serverOptions()`)",
          ),
        ],
      );

      class SubRequest extends Request {}
      class SubResponse extends Response {}
      const classes: ReturnType<Binden["serverOptions"]> = {
        IncomingMessage: SubRequest,
        ServerResponse: given<typeof BindenResponse>(SubResponse),
      };
      const listening = await listen({
        createServer: () => {
          const server = createServer(classes);
          server.on("request", app.callback(server));
          return server;
        },
      });
      try {
        const { status, body } = await within(send(listening.port));
        deepStrictEqual([status, body, errors.length], [200, "handled", 3]);
      } finally {
        await listening.close();
      }
    });
  },
);
