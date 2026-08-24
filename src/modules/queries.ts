import {
  createQueriesModule,
  type QueriesModule as CoreQueriesModule,
} from '@mitralab.io/sdk-core';
import { coreErrors } from '../core-errors';
import { HttpClient } from '../utils/http-client';
import type { QueryResult } from './queries.types';

export type { QueryResult } from './queries.types';

/** Platform SDK 1.x facade over the shared custom query contract. */
export class QueriesModule {
  private readonly core: CoreQueriesModule;

  constructor(httpClient: HttpClient) {
    this.core = createQueriesModule(httpClient, coreErrors);
  }

  /**
   * @deprecated Preserved for Platform SDK 1.x source compatibility. Data Manager now resolves
   * the Data Source from the authenticated app.
   */
  setDataSourceId(_dataSourceId: string): void {
    // Compatibility no-op.
  }

  async execute(id: string, parameters?: Record<string, unknown>): Promise<QueryResult> {
    return this.core.execute(id, parameters);
  }
}
