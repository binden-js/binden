/** The options of a `MultipartFile`: those of a `File`, and whether it is truncated */
export interface IMultipartFileOptions extends NonNullable<
  ConstructorParameters<typeof File>[2]
> {
  /** Whether the content has been truncated to `fileSize` (`false`) */
  truncated?: boolean | undefined;
}

/**
 * A file of the memory storage: a `File` that tells whether its content has
 * been truncated (`fileSize`, with `throw_limits: false`)
 */
export class MultipartFile extends File {
  readonly #truncated: boolean;

  /** A file of the content, the name and the options of a `File`, and `truncated` */
  public constructor(
    bits: ConstructorParameters<typeof File>[0],
    name: string,
    { truncated = false, ...options }: IMultipartFileOptions = {},
  ) {
    super(bits, name, options);
    this.#truncated = truncated;
  }

  /** Whether the content has been truncated to `fileSize` */
  public get truncated(): boolean {
    return this.#truncated;
  }
}
