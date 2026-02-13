import { HttpClient } from '../utils/http-client';
import type { FunctionExecution } from './functions.types';

export type { FunctionExecution } from './functions.types';

/**
 * Module for executing serverless functions.
 *
 * @example
 * ```typescript
 * const result = await mitra.functions.execute('function-id', { orderId: '123' });
 * if (result.status === 'COMPLETED') {
 *   console.log(result.output);
 * }
 * ```
 */
export class FunctionsModule {
  private httpClient: HttpClient;

  constructor(httpClient: HttpClient) {
    this.httpClient = httpClient;
  }

  /**
   * Executes a serverless function by ID.
   *
   * Triggers the function's current published version with the provided input.
   *
   * @param functionId - UUID of the function to execute.
   * @param input - Input data to pass to the function.
   * @returns The execution result with status, output, and metadata.
   * @throws {MitraApiError} On function not found (404) or unauthorized (401).
   *
   * @example
   * ```typescript
   * const execution = await mitra.functions.execute('fn-id', { key: 'value' });
   * console.log(execution.status, execution.output);
   * ```
   */
  async execute(
    functionId: string,
    input?: Record<string, unknown>
  ): Promise<FunctionExecution> {
    return this.httpClient.post<FunctionExecution>(
      `/api/v1/functions/${functionId}/execute`,
      input ? { input } : undefined
    );
  }
}
