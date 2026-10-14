import type { IMultipartOptions } from "./src/options.js";
import { Multipart } from "./src/multipart.js";

export * from "./src/multipart.js";
export * from "./src/file.js";
export {
  type IMultipartInfo,
  type ILimitName,
  multipartInfo,
} from "./src/info.js";
export type { IMultipartConfig, IMultipartOptions } from "./src/options.js";

/** A `Multipart` of the options (see `IMultipartOptions`) */
export default (options?: IMultipartOptions): Multipart =>
  new Multipart(options);
