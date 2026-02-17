/** Result of a serverless function execution. */
export interface FunctionExecution {
  /** Unique execution ID. */
  id: string;
  /** ID of the executed function. */
  functionId: string;
  /** ID of the function version that was executed. */
  functionVersionId: string;
  /** Execution status: PENDING, RUNNING, COMPLETED, or FAILED. */
  status: string;
  /** Input data passed to the function. */
  input: Record<string, unknown>;
  /** Output data returned by the function. */
  output: Record<string, unknown> | null;
  /** Error message if execution failed. */
  errorMessage: string | null;
  /** Execution logs. */
  logs: string | null;
  /** Duration in milliseconds. */
  durationMs: number | null;
  /** When execution started (ISO 8601). */
  startedAt: string | null;
  /** When execution finished (ISO 8601). */
  finishedAt: string | null;
  /** When the execution record was created (ISO 8601). */
  createdAt: string;
}
