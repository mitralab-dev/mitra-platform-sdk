/** Result of executing a custom query. */
export interface QueryResult {
  /** Array of row objects returned by the query. */
  rows: Record<string, unknown>[];
  /** Number of affected rows (null for SELECT). */
  affectedRows: number | null;
}
