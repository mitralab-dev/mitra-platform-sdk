import { HttpClient } from '../utils/http-client';
import type { EntityListOptions, EntityTable } from './entities.types';

// Re-export types for convenience
export type { EntityListOptions, EntityTable } from './entities.types';

/**
 * @internal
 */
interface EntityListResponse<T> {
  data: T[];
  limit: number;
  skip: number;
  total: number;
  hasMore: boolean;
}

/**
 * Module for database CRUD operations.
 *
 * Access any table dynamically: `mitra.entities.TableName.method()`.
 * Table names are case-sensitive and must match the Data Manager config.
 *
 * @example
 * ```typescript
 * // Dynamic access
 * const tasks = await mitra.entities.Task.list('-created_at', 10);
 * const task = await mitra.entities.Task.create({ title: 'New task' });
 *
 * // Typed access
 * const typed = mitra.entities.getTable<Task>('Task');
 * const pending = await typed.filter({ status: 'pending' });
 * ```
 */
export class EntitiesModule {
  private httpClient: HttpClient;
  private dataSourceId: string;
  private tableProxies: Map<string, EntityTable<unknown>> = new Map();

  constructor(httpClient: HttpClient, dataSourceId: string) {
    this.httpClient = httpClient;
    this.dataSourceId = dataSourceId;

    return new Proxy(this, {
      get: (target, prop: string) => {
        if (prop in target) {
          return (target as Record<string, unknown>)[prop];
        }
        return target.getTable(prop);
      },
    });
  }

  setDataSourceId(dataSourceId: string): void {
    this.dataSourceId = dataSourceId;
    this.tableProxies.clear();
  }

  getTable<T = Record<string, unknown>>(tableName: string): EntityTable<T> {
    if (!this.tableProxies.has(tableName)) {
      this.tableProxies.set(tableName, this.createTableAccessor<T>(tableName) as EntityTable<unknown>);
    }
    return this.tableProxies.get(tableName) as EntityTable<T>;
  }

  private createTableAccessor<T = Record<string, unknown>>(
    tableName: string
  ): EntityTable<T> {
    const basePath = `/api/v1/data-sources/${this.dataSourceId}/tables/${tableName}/records`;

    return {
      list: async (
        sortOrOptions?: string | EntityListOptions,
        limit?: number,
        skip?: number,
        fields?: string[]
      ): Promise<T[]> => {
        let params: Record<string, string | number | boolean | undefined>;

        if (typeof sortOrOptions === 'string' || sortOrOptions === undefined) {
          params = {
            sort: sortOrOptions,
            limit,
            skip,
            fields: fields?.join(','),
          };
        } else {
          params = {
            sort: sortOrOptions.sort,
            limit: sortOrOptions.limit,
            skip: sortOrOptions.skip,
            fields: sortOrOptions.fields?.join(','),
          };
        }

        const response = await this.httpClient.get<EntityListResponse<T>>(basePath, params);
        return response.data;
      },

      filter: async (
        query: Record<string, unknown>,
        sort?: string,
        limit?: number,
        skip?: number,
        fields?: string[]
      ): Promise<T[]> => {
        const params: Record<string, string | number | boolean | undefined> = {
          q: JSON.stringify(query),
          sort,
          limit,
          skip,
          fields: fields?.join(','),
        };

        const response = await this.httpClient.get<EntityListResponse<T>>(basePath, params);
        return response.data;
      },

      get: async (id: string | number): Promise<T> => {
        return this.httpClient.get<T>(`${basePath}/${id}`);
      },

      create: async (data: Partial<T>): Promise<T> => {
        return this.httpClient.post<T>(basePath, data);
      },

      update: async (id: string | number, data: Partial<T>): Promise<T> => {
        return this.httpClient.put<T>(`${basePath}/${id}`, data);
      },

      delete: async (id: string | number): Promise<void> => {
        return this.httpClient.delete<void>(`${basePath}/${id}`);
      },

      deleteMany: async (query: Record<string, unknown>): Promise<{ deleted: number }> => {
        return this.httpClient.delete<{ deleted: number }>(basePath, {
          q: JSON.stringify(query),
        });
      },

      bulkCreate: async (data: Partial<T>[]): Promise<T[]> => {
        return this.httpClient.post<T[]>(`${basePath}/bulk`, data);
      },
    };
  }
}

export type EntitiesProxy = EntitiesModule & {
  [tableName: string]: EntityTable;
};
