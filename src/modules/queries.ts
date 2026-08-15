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
  private dataSourceId = '';
  private readonly core: CoreQueriesModule;

  constructor(httpClient: HttpClient) {
    this.core = createQueriesModule(httpClient, () => this.dataSourceId, coreErrors);
  }

  /** Called by `client.init()` to set the app's resolved data source. */
  setDataSourceId(dataSourceId: string): void {
    this.dataSourceId = dataSourceId;
  }

  async execute(id: string, parameters?: Record<string, unknown>): Promise<QueryResult> {
    const result = await this.core.execute(id, parameters);
    return { ...result, affectedRows: result.affectedRows ?? null };
  }
}
