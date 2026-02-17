import { HttpClient } from '../utils/http-client';
import type { QueryResult } from './queries.types';

export type { QueryResult } from './queries.types';

/**
 * Module for executing reusable named queries.
 *
 * @example
 * ```typescript
 * const result = await mitra.queries.execute('query-id', { status: 'active' });
 * console.log(result.rows);
 * ```
 */
export class QueriesModule {
  private httpClient: HttpClient;
  private dataSourceId: string = '';

  constructor(httpClient: HttpClient) {
    this.httpClient = httpClient;
  }

  /** @internal Called by client.init() to set the resolved data source. */
  setDataSourceId(dataSourceId: string): void {
    this.dataSourceId = dataSourceId;
  }

  /**
   * Executes a named query.
   *
   * @param id - UUID of the custom query.
   * @param parameters - Named parameters for the prepared statement.
   * @returns Query result with rows and affected row count.
   * @throws {MitraApiError} On query not found (404).
   *
   * @example
   * ```typescript
   * const result = await mitra.queries.execute('query-id', { status: 'active' });
   * console.log(`Found ${result.rows.length} rows`);
   * ```
   */
  async execute(
    id: string,
    parameters?: Record<string, unknown>
  ): Promise<QueryResult> {
    return this.httpClient.post<QueryResult>(
      `/api/v1/custom-queries/${id}/execute`,
      { datasourceId: this.dataSourceId, parameters }
    );
  }
}
