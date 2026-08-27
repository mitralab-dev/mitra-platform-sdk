import {
  createFunctionsModule,
  type FunctionsModule as CoreFunctionsModule,
} from '@mitralab.io/sdk-core';
import { coreErrors } from '../core-errors';
import { HttpClient } from '../utils/http-client';
import type { FunctionExecution } from './functions.types';

export type { FunctionExecution } from './functions.types';

/** Platform SDK 1.x facade over the shared Function contract. */
export class FunctionsModule {
  private readonly core: CoreFunctionsModule;

  constructor(httpClient: HttpClient) {
    this.core = createFunctionsModule(
      httpClient,
      { emptyInput: 'omit-body', executeInvocationType: 'sync' },
      coreErrors
    );
  }

  /**
   * Executes a Function synchronously and waits for its terminal result.
   */
  async execute(functionId: string, input?: Record<string, unknown>): Promise<FunctionExecution> {
    return this.core.execute(functionId, input);
  }

  /** Queues a Function and returns its initial execution record. */
  async executeAsync(
    functionId: string,
    input?: Record<string, unknown>
  ): Promise<FunctionExecution> {
    return this.core.executeAsync(functionId, input);
  }

  /** Reads the current state of an asynchronous Function execution. */
  async getExecution(executionId: string): Promise<FunctionExecution> {
    return this.core.getExecution(executionId);
  }

  /** Requests cancellation of a queued or running Function execution. */
  cancelExecution(executionId: string): Promise<void> {
    return this.core.cancelExecution(executionId);
  }
}
