import { type IMultipartConfig, Multipart } from "./src/multipart.js";

export * from "./src/multipart.js";

/** A `Multipart` with the configuration of busboy */
export default (config: IMultipartConfig = {}): Multipart =>
  new Multipart({ config });
