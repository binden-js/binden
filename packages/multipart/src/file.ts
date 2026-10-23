import { described, formatStack } from "binden";

/** The options of a `MultipartFile`: those of a `File`, and whether it is truncated */
export interface IMultipartFileOptions extends NonNullable<
  ConstructorParameters<typeof File>[2]
> {
  /** Whether the content has been truncated to `fileSize` (`false`) */
  truncated?: boolean | undefined;
}

/**
 * Whether the content of each `MultipartFile` has been truncated: a class
 * with private fields cannot call the constructor of `File` inside a `try`
 * (see `MultipartFile`)
 */
const truncations = new WeakMap<object, boolean>();

/**
 * A file of the memory storage: a `File` that tells whether its content has
 * been truncated (`fileSize`, with `throw_limits: false`)
 */
export class MultipartFile extends File {
  /**
   * A file of the content, the name and the options of a `File`, and
   * `truncated`, a boolean (anything else throws a `TypeError` that describes
   * it, before the constructor of `File` runs): what reading them throws, and
   * the errors of the constructor of `File` (e.g. for content that is not a
   * sequence), are formatted (see `formatStack()`)
   */
  public constructor(
    bits: ConstructorParameters<typeof File>[0],
    name: string,
    init: IMultipartFileOptions = {},
  ) {
    // Read before the constructor of `File`, which may throw
    const read = { truncated: false };
    try {
      const { truncated = false, ...options } = init;
      if (typeof truncated !== "boolean") {
        // Never converted
        throw formatStack(
          new TypeError(
            `\`truncated\` is not a boolean: ${described(truncated)}`,
          ),
        );
      }
      read.truncated = truncated;
      super(bits, name, options);
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
    truncations.set(this, read.truncated);
  }

  /** Whether the content has been truncated to `fileSize` */
  public get truncated(): boolean {
    return truncations.get(this) === true;
  }
}
