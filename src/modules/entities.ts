import {
  createEntitiesModule,
  type EntitiesProxy as CoreEntitiesProxy,
} from '@mitralab.io/sdk-core';
import { coreErrors } from '../core-errors';
import { HttpClient } from '../utils/http-client';
import type { EntityTable } from './entities.types';

export type { EntityListOptions, EntityTable } from './entities.types';

/**
 * Compatibility facade for the Platform SDK 1.x entity API.
 * Shared request behavior lives in `@mitralab.io/sdk-core`.
 */
export class EntitiesModule {
  private core: CoreEntitiesProxy;

  constructor(
    private readonly httpClient: HttpClient,
    dataSourceId: string
  ) {
    void dataSourceId;
    this.core = createEntitiesModule(httpClient, coreErrors);
  }

  static createProxy(httpClient: HttpClient, dataSourceId: string): EntitiesModule {
    const instance = new EntitiesModule(httpClient, dataSourceId);
    return new Proxy(instance, {
      get(target, property, receiver) {
        if (typeof property !== 'string' || property in target) {
          return Reflect.get(target, property, receiver) as unknown;
        }
        return target.getTable(property);
      },
    });
  }

  /**
   * Preserved for Platform SDK 1.x compatibility.
   * Records now resolve the app from authenticated context instead of a data source path.
   */
  setDataSourceId(dataSourceId: string): void {
    void dataSourceId;
    this.core = createEntitiesModule(this.httpClient, coreErrors);
  }

  getTable<T = Record<string, unknown>>(tableName: string): EntityTable<T> {
    return this.core.getTable<T>(tableName);
  }
}

export type EntitiesProxy = EntitiesModule & {
  [tableName: string]: EntityTable;
};
