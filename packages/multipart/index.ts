import {
  BindenError,
  type Context,
  type IMiddlewareParams,
  Middleware,
} from "binden";
import busboy, { type BusboyConfig } from "busboy";
import { finished } from "node:stream";

export type IMultipartConfig = Omit<BusboyConfig, "headers">;

export interface IMultipartOptions extends IMiddlewareParams {
  config?: IMultipartConfig;
  throw_limits?: boolean;
}

export class Multipart extends Middleware {
  readonly #config: IMultipartConfig;
  readonly #throw_limits: boolean;

  public constructor({
    config = {},
    throw_limits = true,
    ...rest
  }: IMultipartOptions = {}) {
    super(rest);
    this.#config = config;
    this.#throw_limits = throw_limits;
  }

  public async run(context: Context): Promise<void> {
    const { log, request } = context;
    const { headers, method, content_type } = request;

    /* eslint-disable @typescript-eslint/switch-exhaustiveness-check */
    switch (method) {
      case "GET":
      case "HEAD":
      case "OPTIONS":
      case "TRACE":
        log.trace("Method does not support incoming body", { method });
        return;
      default:
        break;
    }

    if (
      typeof content_type?.boundary === "undefined" ||
      content_type.boundary === null
    ) {
      log.trace("`Content-Type` is not `multipart/form-data`", {
        "Content-Type": content_type?.type,
      });
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const fd = new FormData();
      const bb = busboy({ headers, ...this.#config })
        .once("error", (cause) => {
          const message = "`busboy` internal error";
          reject(new BindenError(415, { message, cause }));
        })
        .once("close", () => {
          request.body = fd;
          resolve();
        })
        .on("field", (name, value, { valueTruncated }) => {
          // `nameTruncated` is never set for `multipart/form-data` (busboy applies
          // `fieldNameSize` to `application/x-www-form-urlencoded` only)
          if (this.#throw_limits && valueTruncated) {
            const cause = new Error("`busboy` reached `fieldSize` limit ");
            const error = new BindenError(415, { cause });
            reject(error);
          } else {
            fd.append(name, value);
          }
        })
        .on("file", (name, stream, { mimeType: type, filename }) => {
          const chunks: Buffer<ArrayBuffer>[] = [];
          stream
            .once("error", (cause) => {
              const message = "`busboy` file stream error";
              reject(new BindenError(415, { message, cause }));
            })
            .once("close", () => {
              // @types/busboy 1.5.5 types `filename` as optional; the value is passed through unchanged
              fd.append(name, new File(chunks, filename as string, { type }));
            })
            .on("data", (chunk: Buffer<ArrayBuffer>) => {
              chunks.push(chunk);
            })
            .once("limit", () => {
              if (this.#throw_limits) {
                const cause = new Error("`busboy` reached `fileSize` limit ");
                const error = new BindenError(415, { cause });
                reject(error);
              }
            });
        })
        .on("fieldsLimit", () => {
          if (this.#throw_limits) {
            const cause = new Error("`busboy` reached fields limit ");
            const error = new BindenError(415, { cause });
            reject(error);
          }
        })
        .on("filesLimit", () => {
          if (this.#throw_limits) {
            const cause = new Error("`busboy` reached files limit ");
            const error = new BindenError(415, { cause });
            reject(error);
          }
        })
        .once("partsLimit", () => {
          if (this.#throw_limits) {
            const cause = new Error("`busboy` reached parts limit ");
            const error = new BindenError(415, { cause });
            reject(error);
          } else {
            request.body = fd;
            resolve();
          }
        });
      // `pipe` does not forward a closed connection to busboy: destroy it, so
      // that its `error` rejects this promise
      finished(request, (error) => {
        if (error) {
          bb.destroy(error);
        }
      });
      request.pipe(bb);
    });
  }
}

export default (config: IMultipartConfig = {}): Multipart =>
  new Multipart({ config });
