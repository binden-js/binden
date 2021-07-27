import type { Context } from "./context.js";

export interface IMiddlewareParams {
  disabled?: boolean;
  ignore_errors?: boolean;
}

export abstract class Middleware {
  public disabled: boolean;
  public ignore_errors: boolean;

  public constructor({
    disabled = false,
    ignore_errors = false,
  }: IMiddlewareParams = {}) {
    this.disabled = disabled;
    this.ignore_errors = ignore_errors;
  }

  public abstract run(
    context: Context
  ): /* eslint-disable-next-line @typescript-eslint/no-invalid-void-type */
  Promise<Context> | Promise<void> | Context | void;
}

export default Middleware;
