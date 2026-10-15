// Type tests: compiled by `tsc` (the build of the package), where every
// `@ts-expect-error` must be an error. The test only checks that the typed
// values can be created.
import {
  Binden,
  type Context,
  type IBindenOptions,
  type IRouteParams,
  Middleware,
  Router,
  Stack,
} from "../index.js";
import { ok } from "node:assert/strict";
import { test } from "node:test";

interface IUser {
  user: string;
}

type IOptional = Partial<IUser>;

/** A middleware of another package: a class that is not typed for a state */
class Untyped extends Middleware {
  // eslint-disable-next-line class-methods-use-this -- a middleware that does nothing
  public run(): void {
    // Nothing
  }
}

/** Checks that a value has the type `T` */
function is<T>(value: T): T {
  return value;
}

const state = (): IUser => ({ user: "alice" });

test("types", () => {
  // A state with required fields needs its factory
  const app = new Binden<IUser>({ state });
  // @ts-expect-error -- no factory
  is(new Binden<IUser>());
  // @ts-expect-error -- no factory
  is(new Binden<IUser>({}));
  // @ts-expect-error -- a factory of another state
  is(new Binden<IUser>({ state: (): { name: string } => ({ name: "alice" }) }));
  // Not with optional fields only
  is(new Binden<IOptional>());
  is(new Binden());
  const options: IBindenOptions<IUser> = {
    state,
    error_handler: (context): void => {
      is<string>(context.state.user);
    },
  };
  is(new Binden<IUser>(options));

  // The parameters of a pattern
  app.route("/users/:id/files/*path", (context) => {
    is<string>(context.params.id);
    is<string>(context.params.path);
    is<string>(context.state.user);
    // @ts-expect-error -- not a parameter of the pattern
    is(context.params.other);
  });
  app.route("/a/\\:literal/:b", (context) => {
    is<string>(context.params.b);
    // @ts-expect-error -- an escaped `:` is literal
    is(context.params.literal);
  });
  is<IRouteParams<"/users/:id">>({ id: "1" });
  // @ts-expect-error -- a missing parameter
  is<IRouteParams<"/users/:id">>({});
  // A pattern that is not a literal type: any parameters
  const dynamic: string = "/x";
  app.route(dynamic, (context) => {
    is<string>(context.params.anything);
  });

  // A middleware typed for parameters needs them
  const byId = (context: Context<IUser, { id: string }>): void => {
    is<string>(context.params.id);
  };
  app.route("/users/:id", byId);
  // @ts-expect-error -- no `id` in `use()`
  app.use(byId);
  // @ts-expect-error -- no `id` in this pattern
  app.route("/users/:name", byId);

  // A middleware typed for another state
  const other = (context: Context<{ other: number }>): void => {
    is<number>(context.state.other);
  };
  // @ts-expect-error -- another state
  app.use(other);

  // Routers and stacks of the state
  const router = new Router<IUser, { id: string }>().get((context) => {
    is<string>(context.state.user);
    is<string>(context.params.id);
  });
  app.route("/routers/:id", router);
  const stack = new Stack<IUser>().use((context) => {
    is<string>(context.state.user);
  });
  app.mount("/stack", stack);
  // @ts-expect-error -- a stack of another state
  app.mount("/other", new Stack<{ other: number }>());

  // Middlewares that are not typed for a state are used with any state
  app.use(new Untyped());
  app.route("/untyped/:id", new Untyped(), new Router().get(new Untyped()));
  app.mount("/untyped", new Untyped());
  ok(app instanceof Binden);
});
