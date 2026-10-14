import { isDeepStrictEqual } from "node:util";
import type { IParams } from "./context.js";
import { type IMiddleware, Middleware } from "./middleware.js";
import { compile, type IPattern, type IRouteParams } from "./route.js";
import { Router } from "./router.js";

/** A middleware or a router of a stack, for its state and its parameters */
export type IStackItem<
  State extends object = Record<string, unknown>,
  Params extends IParams = IParams,
> = IMiddleware<State, Params> | Router<State, Params>;

/**
 * A middleware or a router that is not typed for a state (e.g. of another
 * package): it may be used in a stack of any state
 */
export type IUntypedItem = Middleware | Router;

/** The path of a layer of the stack (see `Stack.stack`) */
export type IStackPath =
  | RegExp
  | string
  | {
      /** The prefix of a `mount()` layer, as registered */
      readonly mount: string;
    }
  | {
      /** The pattern of a `route()` layer, as registered */
      readonly route: string;
    }
  | null;

/** A layer of the stack: its items, and the path they are used for */
export type IStack = [(IStackItem | Stack)[], IStackPath];

/** A layer of `use()`: an exact path, a RegExp, or any path (`null`) */
interface IUseLayer {
  readonly kind: "use";
  readonly path: RegExp | string | null;
  readonly items: IStackItem[];
}

/** A layer of `route()` */
interface IRouteLayer {
  readonly kind: "route";
  readonly pattern: IPattern;
  readonly items: IStackItem[];
}

/** A layer of `mount()`: its items see the rest of the path */
interface IMountLayer {
  readonly kind: "mount";
  readonly pattern: IPattern;
  readonly items: (IStackItem | Stack)[];
}

/** A layer of a stack, as the routing uses it */
export type ILayer = IMountLayer | IRouteLayer | IUseLayer;

/** The applications (`Binden`), which cannot be mounted */
const roots = new WeakSet<object>();

/** Marks the root of an application, which cannot be mounted */
export function markRoot(stack: object): void {
  roots.add(stack);
}

// eslint-disable-next-line init-declarations -- set by the static block of `Stack`
let layersOf: (stack: object) => ILayer[];

/** Whether a value is a middleware or a router */
function isItem(item: unknown): item is IStackItem {
  return (
    item instanceof Middleware ||
    item instanceof Router ||
    typeof item === "function"
  );
}

/**
 * A RegExp path with its flags (e.g. `i`), except those that make `test()`
 * stateful (`g` and `y`)
 */
function clone(path: RegExp): RegExp {
  return new RegExp(path.source, path.flags.replaceAll(/[gy]/gu, ""));
}

/** The path of `use()`: `null` for any path */
function usePath(path: unknown): RegExp | string | null {
  return path instanceof RegExp
    ? clone(path)
    : typeof path === "string" && path
      ? path
      : null;
}

/**
 * A container of middlewares and routers, by path: `use()` for an exact path
 * (or a RegExp, or any path), `route()` for a pattern with parameters and
 * `mount()` for a prefix, whose items (other stacks among them) see the rest
 * of the path. It has no options: those of the application (`Binden`, which
 * is a stack too) apply.
 */
export class Stack<State extends object = Record<string, unknown>> {
  readonly #layers: ILayer[] = [];

  static {
    // Any stack, whatever its state
    layersOf = (stack: object): ILayer[] => (stack as Stack).#layers;
  }

  /** A copy of the layers of the stack */
  public get stack(): IStack[] {
    return this.#layers.map((layer): IStack => {
      const items = [...layer.items];
      if (layer.kind === "use") {
        const { path } = layer;
        return [items, path instanceof RegExp ? clone(path) : path];
      } else if (layer.kind === "route") {
        return [items, { route: layer.pattern.source }];
      }
      return [items, { mount: layer.pattern.source }];
    });
  }

  /** Adds middlewares and routers for every path */
  public use(...items: (IStackItem<State> | IUntypedItem)[]): this;
  /**
   * Adds middlewares and routers for an exact path (a string) or for the
   * paths that a RegExp matches
   */
  public use(
    path: RegExp | string,
    ...items: (IStackItem<State> | IUntypedItem)[]
  ): this;
  public use(_path: unknown, ...rest: unknown[]): this {
    const items = isItem(_path) ? [_path, ...rest] : rest;
    if (!items.length) {
      return this;
    }
    for (const item of items) {
      if (!isItem(item)) {
        throw new TypeError("Unsupported Middleware/Router");
      }
    }
    this.#add({
      kind: "use",
      path: usePath(_path),
      items: items as IStackItem[],
    });
    return this;
  }

  /**
   * Adds middlewares and routers for the paths that a pattern matches, with
   * its parameters in `context.params`: `:name` matches a segment, `*name`
   * (last) the rest of the path, and `\:` and `\*` are literal
   */
  public route<Pattern extends string>(
    pattern: Pattern,
    ...items: (IStackItem<State, IRouteParams<Pattern>> | IUntypedItem)[]
  ): this {
    const compiled = compile(pattern, "route");
    if (!items.length) {
      return this;
    }
    for (const item of items) {
      if (!isItem(item)) {
        throw new TypeError("Unsupported Middleware/Router");
      }
    }
    this.#add({
      kind: "route",
      pattern: compiled,
      items: items as IStackItem[],
    });
    return this;
  }

  /**
   * Adds middlewares, routers and stacks for the paths under a prefix (on a
   * segment boundary, with `:name` parameters): they see the rest of the path
   * (`/` when there is none), and `context.mount_path` is the matched prefix
   */
  public mount(
    prefix: string,
    ...items: (IStackItem<State> | IUntypedItem | Stack<State>)[]
  ): this {
    const compiled = compile(prefix, "mount");
    if (!items.length) {
      return this;
    }
    for (const item of items) {
      if (item instanceof Stack) {
        if (roots.has(item)) {
          throw new TypeError("An application (`Binden`) cannot be mounted");
        } else if (item === this || Stack.#reaches(item, this)) {
          throw new TypeError("A stack cannot be mounted in itself");
        }
      } else if (!isItem(item)) {
        throw new TypeError("Unsupported Middleware/Router/Stack");
      }
    }
    this.#add({
      kind: "mount",
      pattern: compiled,
      items: items as (IStackItem | Stack)[],
    });
    return this;
  }

  /**
   * Removes middlewares and routers added by `use()` for every path: the
   * removed ones
   */
  public off(...items: (IStackItem<State> | IUntypedItem)[]): IStackItem[];
  /**
   * Removes middlewares and routers added by `use()` for an exact path or a
   * RegExp: the removed ones
   */
  public off(
    path: RegExp | string,
    ...items: (IStackItem<State> | IUntypedItem)[]
  ): IStackItem[];
  public off(_path: unknown, ...rest: unknown[]): IStackItem[] {
    const items = isItem(_path) ? [_path, ...rest] : rest;
    const path = usePath(_path);
    const removed: IStackItem[] = [];
    const layers = this.#layers;

    for (const item of items) {
      const { length } = layers;

      for (let i = length - 1; i >= 0; i -= 1) {
        const layer = layers[i];

        if (layer.kind === "use" && isDeepStrictEqual(layer.path, path)) {
          const index = layer.items.lastIndexOf(item as IStackItem);

          if (index !== -1) {
            removed.push(...layer.items.splice(index, 1));

            if (!layer.items.length) {
              const previous = layers[i - 1];
              const next = layers[i + 1];
              if (
                typeof previous !== "undefined" &&
                typeof next !== "undefined" &&
                Stack.#same(previous, next)
              ) {
                // The neighbours are one layer again
                (previous.items as unknown[]).push(...next.items);
                layers.splice(i, 2);
              } else {
                layers.splice(i, 1);
              }
            }

            break;
          }
        }
      }
    }

    return removed;
  }

  /** Adds a layer, or its items to the last layer when it has the same path */
  #add(layer: ILayer): void {
    const last = this.#layers.at(-1);
    if (typeof last !== "undefined" && Stack.#same(last, layer)) {
      (last.items as unknown[]).push(...layer.items);
    } else {
      this.#layers.push(layer);
    }
  }

  /** Whether two layers have the same path */
  static #same(a: ILayer, b: ILayer): boolean {
    if (a.kind === "use" && b.kind === "use") {
      return isDeepStrictEqual(a.path, b.path);
    }
    return (
      a.kind !== "use" &&
      a.kind === b.kind &&
      a.pattern.source === b.pattern.source
    );
  }

  /** Whether a stack has another one mounted in it (at any depth) */
  static #reaches(
    stack: object,
    target: object,
    seen = new Set<object>(),
  ): boolean {
    seen.add(stack);
    for (const layer of layersOf(stack)) {
      if (layer.kind === "mount") {
        for (const item of layer.items) {
          if (
            item instanceof Stack &&
            (item === target ||
              (!seen.has(item) && Stack.#reaches(item, target, seen)))
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }
}

export { layersOf };
