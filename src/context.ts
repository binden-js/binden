import { Logger } from "@binden/logger";
import { BindenError, IBindenErrorOptions } from "./error.js";
import { serializers, base } from "./logger.js";

import type { Readable } from "node:stream";
import type { BindenRequest } from "./request.js";
import type { IHeadersValue, BindenResponse } from "./response.js";

export interface IBindenResponse extends BindenResponse {
  req: BindenRequest;
}

export interface IBaseContext {
  readonly request: BindenRequest;
  readonly response: IBindenResponse;
}

export class Context implements IBaseContext {
  readonly #request: BindenRequest;
  readonly #response: IBindenResponse;
  readonly #logger: Logger;
  #done: boolean;

  public constructor({ request, response }: IBaseContext) {
    this.#request = request;
    this.#response = response;
    this.#done = false;
    const { id: trace_id } = request;
    this.#logger = new Logger({ serializers, base: { ...base, trace_id } });
  }

  public get log(): Logger {
    return this.#logger;
  }

  public setHeader(name: string, value: IHeadersValue): this {
    this.response.setHeader(name, value);
    return this;
  }

  public status(code: number): this {
    this.response.status(code);
    return this;
  }

  public get request(): BindenRequest {
    return this.#request;
  }

  public get response(): IBindenResponse {
    return this.#response;
  }

  public get id(): string {
    return this.request.id;
  }

  public get done(): boolean {
    return this.#done;
  }

  public set done(done: unknown) {
    if (!this.#done && Boolean(done)) {
      this.#done = true;
    }
  }

  public get url(): URL {
    return this.request.URL;
  }

  public async send(
    data?: Buffer | Readable | bigint | number | string
  ): Promise<void> {
    await this.response.send(data);
    this.done = true;
  }

  public async json(data: Record<string, unknown> | unknown[]): Promise<void> {
    await this.response.json(data);
    this.done = true;
  }

  public async text(data: string): Promise<void> {
    await this.response.text(data);
    this.done = true;
  }

  public async html(data: string): Promise<void> {
    await this.response.html(data);
    this.done = true;
  }

  public async form(data: URLSearchParams): Promise<void> {
    await this.response.form(data);
    this.done = true;
  }

  /** Send a file */
  public async sendFile(url: URL | string): Promise<void> {
    await this.response.sendFile(url);
    this.done = true;
  }

  // eslint-disable-next-line class-methods-use-this
  public throw(status: number, opts?: IBindenErrorOptions): never {
    throw new BindenError(status, opts);
  }
}
