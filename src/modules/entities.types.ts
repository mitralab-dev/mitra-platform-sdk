/**
 * Options for listing entities with sorting and pagination.
 */
export interface EntityListOptions {
  /**
   * Field to sort by. Prefix with '-' for descending order.
   *
   * @example
   * ```typescript
   * // Sort by created_at descending (newest first)
   * { sort: '-created_at' }
   *
   * // Sort by name ascending (A-Z)
   * { sort: 'name' }
   * ```
   */
  sort?: string;

  /**
   * Maximum number of records to return.
   * Defaults to 100. Maximum allowed is 1000.
   */
  limit?: number;

  /**
   * Number of records to skip for pagination.
   * Use with `limit` to implement pagination.
   *
   * @example
   * ```typescript
   * // Get page 2 (records 11-20)
   * { limit: 10, skip: 10 }
   * ```
   */
  skip?: number;

  /**
   * Array of field names to include in the response.
   * If not specified, all fields are returned.
   *
   * @example
   * ```typescript
   * // Only return id, title, and status
   * { fields: ['id', 'title', 'status'] }
   * ```
   */
  fields?: string[];
}

/**
 * Entity handler providing CRUD operations for a specific entity type.
 *
 * Each table in the database gets a handler with these methods for managing data.
 * Access tables dynamically using `mitra.entities.TableName`.
 *
 * @typeParam T - The shape of records in this table. Defaults to `Record<string, unknown>`.
 *
 * @example
 * ```typescript
 * // Dynamic access (no type safety)
 * const tasks = await mitra.entities.Task.list();
 *
 * // Typed access
 * interface Task {
 *   id: string;
 *   title: string;
 *   status: 'pending' | 'done';
 * }
 * const tasks = mitra.entities.getTable<Task>('Task');
 * const pending = await tasks.filter({ status: 'pending' });
 * ```
 */
export interface EntityTable<T = Record<string, unknown>> {
  /**
   * Lists records with optional pagination and sorting.
   *
   * Retrieves all records from the table with support for sorting,
   * pagination, and field selection. Supports both positional parameters
   * (for quick usage) and options object (for clarity).
   *
   * @param sortOrOptions - Sort field (e.g., '-created_at') or options object.
   * @param limit - Maximum number of results to return. Defaults to 100.
   * @param skip - Number of results to skip for pagination. Defaults to 0.
   * @param fields - Array of field names to include in the response.
   * @returns Promise resolving to an array of records.
   *
   * @example
   * ```typescript
   * // Get all records
   * const tasks = await mitra.entities.Task.list();
   * ```
   *
   * @example
   * ```typescript
   * // Get first 10 records sorted by date (newest first)
   * const tasks = await mitra.entities.Task.list('-created_at', 10);
   * ```
   *
   * @example
   * ```typescript
   * // Get paginated results (page 3, 10 items per page)
   * const tasks = await mitra.entities.Task.list('-created_at', 10, 20);
   * ```
   *
   * @example
   * ```typescript
   * // Using options object
   * const tasks = await mitra.entities.Task.list({
   *   sort: '-created_at',
   *   limit: 10,
   *   skip: 0,
   *   fields: ['id', 'title', 'status'],
   * });
   * ```
   */
  list(
    sortOrOptions?: string | EntityListOptions,
    limit?: number,
    skip?: number,
    fields?: string[]
  ): Promise<T[]>;

  /**
   * Filters records based on a query.
   *
   * Retrieves records that match specific criteria with support for
   * sorting, pagination, and field selection. All query conditions
   * are combined with AND logic.
   *
   * @param query - Query object with field-value pairs. Records matching
   *   all specified criteria are returned. Field names are case-sensitive.
   * @param sort - Sort field (prefix '-' for descending). Defaults to '-created_at'.
   * @param limit - Maximum number of results to return. Defaults to 100.
   * @param skip - Number of results to skip for pagination. Defaults to 0.
   * @param fields - Array of field names to include in the response.
   * @returns Promise resolving to an array of matching records.
   *
   * @example
   * ```typescript
   * // Filter by single field
   * const doneTasks = await mitra.entities.Task.filter({ status: 'done' });
   * ```
   *
   * @example
   * ```typescript
   * // Filter by multiple fields (AND logic)
   * const urgentTasks = await mitra.entities.Task.filter({
   *   status: 'pending',
   *   priority: 'high',
   * });
   * ```
   *
   * @example
   * ```typescript
   * // Filter with sorting and pagination
   * const tasks = await mitra.entities.Task.filter(
   *   { status: 'pending' },
   *   '-priority',  // sort by priority descending
   *   10,           // limit
   *   0             // skip
   * );
   * ```
   *
   * @example
   * ```typescript
   * // Filter with specific fields
   * const tasks = await mitra.entities.Task.filter(
   *   { assignee: 'user-123' },
   *   '-created_at',
   *   20,
   *   0,
   *   ['id', 'title', 'status']
   * );
   * ```
   *
   * @example
   * ```typescript
   * // Comparison operators: $gt, $gte, $lt, $lte, $ne
   * const expensive = await mitra.entities.Product.filter({ price: { $gt: 100 } });
   * const recent = await mitra.entities.Order.filter({ created_at: { $gte: '2025-01-01' } });
   * const notDone = await mitra.entities.Task.filter({ status: { $ne: 'done' } });
   * ```
   *
   * @example
   * ```typescript
   * // Range query (combines with AND)
   * const midRange = await mitra.entities.Product.filter({
   *   price: { $gte: 50, $lte: 200 },
   * });
   * ```
   *
   * @example
   * ```typescript
   * // Mix equality and operators
   * const results = await mitra.entities.Order.filter({
   *   status: 'shipped',
   *   total: { $gt: 1000 },
   * });
   * ```
   */
  filter(
    query: Record<string, unknown>,
    sort?: string,
    limit?: number,
    skip?: number,
    fields?: string[]
  ): Promise<T[]>;

  /**
   * Gets a single record by ID.
   *
   * Retrieves a specific record using its unique identifier.
   *
   * @param id - The unique identifier of the record.
   * @returns Promise resolving to the record.
   * @throws {MitraApiError} When record is not found (404).
   *
   * @example
   * ```typescript
   * const task = await mitra.entities.Task.get('task-123');
   * console.log(task.title);
   * ```
   *
   * @example
   * ```typescript
   * // With error handling
   * try {
   *   const task = await mitra.entities.Task.get(taskId);
   *   setTask(task);
   * } catch (error) {
   *   if (error.status === 404) {
   *     console.error('Task not found');
   *   }
   * }
   * ```
   */
  get(id: string | number): Promise<T>;

  /**
   * Creates a new record.
   *
   * Creates a new record in the table with the provided data.
   * The server will generate an `id` and timestamps automatically.
   *
   * @param data - Object containing the record data.
   * @returns Promise resolving to the created record (including generated id).
   * @throws {MitraApiError} When validation fails (400).
   *
   * @example
   * ```typescript
   * const task = await mitra.entities.Task.create({
   *   title: 'Complete documentation',
   *   status: 'pending',
   *   priority: 'high',
   * });
   * console.log('Created task:', task.id);
   * ```
   *
   * @example
   * ```typescript
   * // With error handling
   * try {
   *   const task = await mitra.entities.Task.create(formData);
   *   toast.success('Task created!');
   *   navigate(`/tasks/${task.id}`);
   * } catch (error) {
   *   toast.error(error.message);
   * }
   * ```
   */
  create(data: Partial<T>): Promise<T>;

  /**
   * Updates an existing record.
   *
   * Updates a record by ID with the provided data. Only the fields
   * included in the data object will be updated; other fields remain
   * unchanged (partial update).
   *
   * @param id - The unique identifier of the record to update.
   * @param data - Object containing the fields to update.
   * @returns Promise resolving to the updated record.
   * @throws {MitraApiError} When record is not found (404).
   *
   * @example
   * ```typescript
   * // Update single field
   * const updated = await mitra.entities.Task.update('task-123', {
   *   status: 'completed',
   * });
   * ```
   *
   * @example
   * ```typescript
   * // Update multiple fields
   * const updated = await mitra.entities.Task.update('task-123', {
   *   status: 'done',
   *   completedAt: new Date().toISOString(),
   *   completedBy: currentUser.id,
   * });
   * ```
   */
  update(id: string | number, data: Partial<T>): Promise<T>;

  /**
   * Deletes a single record by ID.
   *
   * Permanently removes a record from the database. This action cannot
   * be undone.
   *
   * @param id - The unique identifier of the record to delete.
   * @returns Promise resolving when deletion is complete.
   * @throws {MitraApiError} When record is not found (404).
   *
   * @example
   * ```typescript
   * await mitra.entities.Task.delete('task-123');
   * console.log('Task deleted');
   * ```
   *
   * @example
   * ```typescript
   * // With confirmation
   * if (confirm('Delete this task?')) {
   *   await mitra.entities.Task.delete(task.id);
   *   toast.success('Task deleted');
   *   navigate('/tasks');
   * }
   * ```
   */
  delete(id: string | number): Promise<void>;

  /**
   * Deletes multiple records matching a query.
   *
   * Permanently removes all records that match the provided query.
   * Use with caution as this action cannot be undone.
   *
   * @param query - Query object with field-value pairs. Records matching
   *   all specified criteria will be deleted.
   * @returns Promise resolving to object with count of deleted records.
   *
   * @example
   * ```typescript
   * // Delete all completed tasks
   * const result = await mitra.entities.Task.deleteMany({ status: 'done' });
   * console.log(`Deleted ${result.deleted} tasks`);
   * ```
   *
   * @example
   * ```typescript
   * // Delete by multiple criteria
   * const result = await mitra.entities.Task.deleteMany({
   *   status: 'archived',
   *   createdAt: { $lt: '2024-01-01' },
   * });
   * ```
   */
  deleteMany(query: Record<string, unknown>): Promise<{ deleted: number }>;

  /**
   * Creates multiple records in a single request.
   *
   * Efficiently creates multiple records at once. This is faster than
   * calling `create()` multiple times as it uses a single API request.
   *
   * @param data - Array of record data objects.
   * @returns Promise resolving to an array of created records.
   *
   * @example
   * ```typescript
   * const tasks = await mitra.entities.Task.bulkCreate([
   *   { title: 'Task 1', status: 'pending' },
   *   { title: 'Task 2', status: 'pending' },
   *   { title: 'Task 3', status: 'pending' },
   * ]);
   * console.log(`Created ${tasks.length} tasks`);
   * ```
   *
   * @example
   * ```typescript
   * // Import from external source
   * const importedData = parseCSV(csvContent);
   * const records = await mitra.entities.Product.bulkCreate(importedData);
   * toast.success(`Imported ${records.length} products`);
   * ```
   */
  bulkCreate(data: Partial<T>[]): Promise<T[]>;
}
