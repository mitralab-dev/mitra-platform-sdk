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
    this.core = createFunctionsModule(httpClient, { emptyInput: 'omit-body' }, coreErrors);
  }

  /**
   * Executes a Function using the Platform SDK 1.x server-default invocation semantics.
   * The runtime SDK uses an explicit invocation header instead.
   */
  async execute(functionId: string, input?: Record<string, unknown>): Promise<FunctionExecution> {
    const execution = await this.core.execute(functionId, input);
    if (execution.input === null) {
      throw coreErrors.invalidResponse(
        'Function execution response has an invalid input field'
      );
    }
    return { ...execution, input: execution.input };
  }
}
