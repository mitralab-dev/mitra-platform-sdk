import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const consumerDirectory = mkdtempSync(join(tmpdir(), 'mitra-platform-sdk-smoke-'));
const typeScriptCompiler = join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
const coreTarball = process.env.MITRA_SDK_CORE_TARBALL;

// The new surface, plus the deprecated mitra-interactions-sdk surface the
// package re-exports so legacy applications can swap the dependency.
const expectedExports = JSON.stringify(
  [
    'MitraApiError',
    'createClient',
    'callIntegrationMitra',
    'configureSdkMitra',
    'createMitraInstance',
    'createRecordMitra',
    'createRecordsBatchMitra',
    'deleteRecordMitra',
    'exchangeSsoCodeMitra',
    'executePublicServerFunctionAsyncMitra',
    'executePublicServerFunctionMitra',
    'executeServerFunctionAsyncMitra',
    'executeServerFunctionMitra',
    'getAgentTaskMitra',
    'getConfig',
    'getPublicServerFunctionExecutionMitra',
    'getRecordMitra',
    'listIntegrationsMitra',
    'listRecordsMitra',
    'loginMitra',
    'loginWithGoogleMitra',
    'loginWithMicrosoftMitra',
    'manageAgentChatMitra',
    'manageAgentCredentialMitra',
    'patchRecordMitra',
    'refreshTokenSilently',
    'resolveProjectId',
    'stopServerFunctionExecutionMitra',
    'updateRecordMitra',
  ].sort()
);

try {
  const packOutput = execFileSync(
    'npm',
    ['pack', '--json', '--pack-destination', consumerDirectory],
    { encoding: 'utf8' }
  );
  const [{ filename, files }] = JSON.parse(packOutput);
  const packedFiles = new Set(files.map(({ path }) => path));
  for (const expectedFile of [
    'CHANGELOG.md',
    'LICENSE',
    'README.md',
    'dist/index.cjs',
    'dist/index.d.cts',
    'dist/index.d.ts',
    'dist/index.js',
    'package.json',
  ]) {
    if (!packedFiles.has(expectedFile)) {
      throw new Error(`Package is missing ${expectedFile}`);
    }
  }
  const tarball = join(consumerDirectory, filename);

  writeFileSync(
    join(consumerDirectory, 'package.json'),
    JSON.stringify({ name: 'platform-sdk-smoke-consumer', private: true, type: 'module' })
  );
  execFileSync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      ...(coreTarball ? [coreTarball] : []),
      tarball,
    ],
    { cwd: consumerDirectory, stdio: 'inherit' }
  );

  writeFileSync(
    join(consumerDirectory, 'consumer.mts'),
    `import {
  createClient,
  MitraApiError,
  executeServerFunctionMitra,
  loginWithGoogleMitra,
  type EntityTable,
  type FunctionExecution,
  type LoginResponse,
  type MitraClient,
  type MitraConfig,
  type ProxyInput,
  type QueryResult,
  type User,
} from "@mitralab.io/platform-sdk"

const client: MitraClient = createClient({ appId: "app", apiUrl: "https://api.example.com" })
const user: User = { id: "user", tenantId: "tenant", email: "user@example.com", name: null }
const query: QueryResult = { rows: [], affectedRows: null }
const proxy: ProxyInput = { method: "GET", endpoint: "/", queryParams: { limit: "10" } }
const table: EntityTable = client.entities.getTable("Task")
const execution: FunctionExecution | undefined = undefined
const error = new MitraApiError("message", 400, "CODE", {})

void client.auth.currentUser
void client.auth.isAuthenticated
void client.auth.onAuthStateChange(() => undefined)
void client.auth.checkAuth()
void client.auth.signIn({ email: user.email, password: "password" })
void client.auth.signUp({ email: user.email, password: "password" })
client.auth.signOut()
client.auth.redirectToLogin()
void client.init()
void client.functions.execute("function-id")
const legacyConfig: MitraConfig = { baseURL: "https://api.example.com", projectId: "app" }
const legacySession: Promise<LoginResponse> = loginWithGoogleMitra({ projectId: "app" })

void table
void query
void proxy
void execution
void error
void legacyConfig
void legacySession
void executeServerFunctionMitra
`
  );
  writeFileSync(
    join(consumerDirectory, 'consumer.cts'),
    `import sdk = require("@mitralab.io/platform-sdk")
const client: sdk.MitraClient = sdk.createClient({ appId: "app", apiUrl: "https://api.example.com" })
const user: sdk.User = { id: "user", tenantId: "tenant", email: "user@example.com", name: null }
const query: sdk.QueryResult = { rows: [], affectedRows: null }
const proxy: sdk.ProxyInput = { method: "GET", endpoint: "/", queryParams: { limit: "10" } }
const error = new sdk.MitraApiError("message", 400, "CODE", {})
const legacyConfig: sdk.MitraConfig = { baseURL: "https://api.example.com", projectId: "app" }
void client
void user
void query
void proxy
void error
void legacyConfig
void sdk.executeServerFunctionMitra
`
  );
  execFileSync(
    process.execPath,
    [
      typeScriptCompiler,
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      'consumer.mts',
      'consumer.cts',
    ],
    { cwd: consumerDirectory, stdio: 'inherit' }
  );
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import * as sdk from "@mitralab.io/platform-sdk"; const keys = Object.keys(sdk).sort(); if (JSON.stringify(keys) !== ${JSON.stringify(expectedExports)}) process.exit(1)`,
    ],
    { cwd: consumerDirectory, stdio: 'inherit' }
  );
  execFileSync(
    process.execPath,
    [
      '--eval',
      `const sdk = require("@mitralab.io/platform-sdk"); const keys = Object.keys(sdk).sort(); if (JSON.stringify(keys) !== ${JSON.stringify(expectedExports)}) process.exit(1)`,
    ],
    { cwd: consumerDirectory, stdio: 'inherit' }
  );
} finally {
  rmSync(consumerDirectory, { recursive: true, force: true });
}
