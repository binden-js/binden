import Logger from "./logger.js";
import KauaiError, { IKauaiErrorOptions } from "./error.js";

import type { Readable } from "stream";
import type KauaiRequest from "./request.js";
import type KauaiResponse from "./response.js";

export interface IKauaiResponse extends KauaiResponse {
  req: KauaiRequest;
}

export interface IBaseContext {
  readonly request: KauaiRequest;
  readonly response: IKauaiResponse;
}

export class Context implements IBaseContext {
  readonly #request: KauaiRequest;
  readonly #response: IKauaiResponse;
  readonly #logger: typeof Logger;
  #done: boolean;

  public constructor({ request, response }: IBaseContext) {
    this.#request = request;
    this.#response = response;
    this.#done = false;
    this.#logger = Logger.child({ trace_id: request.id });
  }

  public get log(): typeof Logger {
    return this.#logger;
  }

  public status(code: number): this {
    this.response.status(code);
    return this;
  }

  public get request(): KauaiRequest {
    return this.#request;
  }

  public get response(): IKauaiResponse {
    return this.#response;
  }

  public get id(): string {
    return this.request.id;
  }

  public get done(): boolean {
    return this.#done;
  }

  public set done(done: unknown) {
    if (!this.#done && done) {
      this.#done = true;
    }
  }

  public get url(): URL {
    return this.request.URL;
  }

  public async send(
    data?: string | number | Buffer | bigint | Readable
  ): Promise<void> {
    await this.response.send(data);
    this.done = true;
  }

  public async json(data: Record<string, unknown>): Promise<void> {
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

  public throw(status: number, opts?: IKauaiErrorOptions): never {
    throw new KauaiError(status, opts);
  }
}

export default Context;
