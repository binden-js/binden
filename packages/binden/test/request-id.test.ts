import { type AddressInfo, Socket, connect } from "node:net";
import {
  BindenRequest,
  type IRequestIdOptions,
  type IRequestOptions,
  validateRequestOptions,
} from "../index.js";
import { after, suite, test } from "node:test";
import { deepStrictEqual, ok, throws } from "node:assert";
import { createServer } from "node:http";

const uuid =
  /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;

const sockets: Socket[] = [];

/** A class of requests with the options */
function withOptions(options: IRequestOptions): typeof BindenRequest {
  return class extends BindenRequest {
    // eslint-disable-next-line class-methods-use-this -- a fixture
    protected override get options(): IRequestOptions {
      return options;
    }
  };
}

/** A request with the field lines, and the request ids */
function create(
  request_id: IRequestIdOptions | null,
  fields: [string, string][] = [],
): BindenRequest {
  const options =
    request_id === null
      ? validateRequestOptions()
      : validateRequestOptions({ request_id });
  const Request = withOptions(options);
  const socket = new Socket();
  sockets.push(socket);
  const request = new Request(socket);
  const distinct: NodeJS.Dict<string[]> = {};
  for (const [name, value] of fields) {
    const key = name.toLowerCase();
    distinct[key] = [...(distinct[key] ?? []), value];
  }
  request.headersDistinct = distinct;
  return request;
}

suite("request ids", () => {
  test("new ids by default", () => {
    const fields: [string, string][] = [["X-Request-Id", "abc"]];
    for (const request_id of [null, {}, { trust_incoming: false }]) {
      const request = create(request_id, fields);
      const { id } = request;
      ok(uuid.test(id), id);
      // Found once
      deepStrictEqual(request.id, id);
    }
    const [first, second] = [create(null), create(null)];
    ok(first.id !== second.id);
  });

  test("trusted incoming ids", () => {
    const id = (value: string, header = "X-Request-Id"): string =>
      create({ trust_incoming: true }, [[header, value]]).id;

    for (const value of ["abc", "A-b_c.d:e", "1", "x".repeat(128)]) {
      deepStrictEqual(id(value), value);
    }
    // Not an id: a new one
    for (const value of [
      "",
      "a b",
      "a,b",
      "a/b",
      "é",
      "x".repeat(129),
      "a\tb",
    ]) {
      ok(uuid.test(id(value)), value);
    }
    // Another field
    ok(uuid.test(id("abc", "X-Correlation-Id")));
    deepStrictEqual(
      create({ trust_incoming: true, header: "X-Correlation-Id" }, [
        ["X-Correlation-Id", "abc"],
      ]).id,
      "abc",
    );
    // Several field lines: a new one
    ok(
      uuid.test(
        create({ trust_incoming: true }, [
          ["X-Request-Id", "abc"],
          ["X-Request-Id", "abc"],
        ]).id,
      ),
    );
    // Only `true` trusts an incoming id (e.g. not a value of unchecked options)
    const Request = withOptions({
      ...validateRequestOptions(),
      request_id: {
        header: "X-Request-Id",
        trust_incoming: 1 as unknown as boolean,
        echo: true,
      },
    });
    const request = new Request(new Socket());
    request.headersDistinct = { "x-request-id": ["abc"] };
    ok(uuid.test(request.id));
    // The name of the field in any case
    const Lower = withOptions({
      ...validateRequestOptions(),
      request_id: { header: "X-Request-Id", trust_incoming: true, echo: true },
    });
    const lower = new Lower(new Socket());
    lower.headersDistinct = { "x-request-id": ["abc"] };
    deepStrictEqual(lower.id, "abc");
  });

  test("a real connection", { timeout: 5000 }, async () => {
    const Request = withOptions(
      validateRequestOptions({ request_id: { trust_incoming: true } }),
    );
    const server = createServer({ IncomingMessage: Request });
    const ids: string[] = [];
    server.on("request", (request, response) => {
      ids.push(request.id);
      response.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });
    const { port } = server.address() as AddressInfo;
    const socket = connect(port, "127.0.0.1", () => {
      socket.end(
        "GET / HTTP/1.1\r\nHost: a.test\r\nX-Request-Id: abc\r\n\r\nGET / HTTP/1.1\r\nHost: a.test\r\nX-Request-Id: abc\r\nX-Request-Id: def\r\nConnection: close\r\n\r\n",
      );
    });
    socket.resume();
    try {
      await new Promise((resolve) => {
        socket.once("close", resolve);
      });
      deepStrictEqual(ids.length, 2);
      deepStrictEqual(ids[0], "abc");
      ok(uuid.test(ids[1]));
    } finally {
      socket.destroy();
      await new Promise((resolve) => {
        server.close(resolve);
      });
    }
  });

  test("validateRequestOptions()", () => {
    const check = (request_id: unknown): IRequestOptions["request_id"] =>
      validateRequestOptions({
        request_id: request_id as IRequestIdOptions,
      }).request_id;

    deepStrictEqual(validateRequestOptions().request_id, null);
    const defaults = check({});
    deepStrictEqual(defaults, {
      header: "x-request-id",
      trust_incoming: false,
      echo: true,
    });
    ok(Object.isFrozen(defaults));
    deepStrictEqual(
      check({ header: "X-Correlation-ID", trust_incoming: true, echo: false }),
      { header: "x-correlation-id", trust_incoming: true, echo: false },
    );
    for (const header of ["", "x request", "x:y", 1, null]) {
      throws(
        () => check({ header }),
        new TypeError("`request_id.header` is not a field name"),
      );
    }
    for (const trust_incoming of [1, "true", null]) {
      throws(
        () => check({ trust_incoming }),
        new TypeError("`request_id.trust_incoming` is not a boolean"),
      );
    }
    for (const echo of [0, "false", null]) {
      throws(
        () => check({ echo }),
        new TypeError("`request_id.echo` is not a boolean"),
      );
    }
    for (const request_id of [null, true, "x-request-id"]) {
      throws(
        () => check(request_id),
        new TypeError("`request_id` is not an object"),
      );
    }
  });

  after(() => {
    for (const socket of sockets.splice(0)) {
      socket.destroy();
    }
  });
});
