import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';

const consumerDirectory = mkdtempSync(join(tmpdir(), 'mitra-platform-sdk-smoke-'));
const typeScriptCompiler = join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
const coreTarball = process.env.MITRA_SDK_CORE_TARBALL;
const npmCli = process.env.npm_execpath
  ?? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');

if (!existsSync(npmCli)) {
  throw new Error('npm CLI was not found; run this smoke test through an npm script');
}

function npm(args, options = {}) {
  return execFileSync(process.execPath, [npmCli, ...args], options);
}
// The pinned legacy dependency currently exposes 66 public types. A surface
// change must add an equally deprecated identity alias before this can pass.
const legacyTypeAliasPattern =
  /\/\*\* @deprecated Legacy compatibility type\. \*\/\s+type (\w+) = LegacyTypes\.\1;/g;

for (const declarationFile of ['index.d.ts', 'index.d.cts']) {
  const declarations = readFileSync(join(process.cwd(), 'dist', declarationFile), 'utf8');
  const deprecatedLegacyTypes = [...declarations.matchAll(legacyTypeAliasPattern)];
  if (deprecatedLegacyTypes.length !== 66) {
    throw new Error(
      `${declarationFile} exposes ${deprecatedLegacyTypes.length} deprecated legacy types; expected 66`
    );
  }
}

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
  const packOutput = npm(
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
  npm(
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
    `import type { MitraConfig as InteractionsMitraConfig } from "mitra-interactions-sdk"
import {
  createClient,
  MitraApiError,
  executeServerFunctionMitra,
  loginWithGoogleMitra,
  type EntityTable,
  type FunctionExecution,
  type GoogleSignInOptions,
  type NativeAgentTaskSession,
  type PublicFunctionExecutionResult,
  type LoginResponse,
  type MitraClient,
  type MitraConfig,
  type ProxyInput,
  type QueryResult,
  type User,
} from "@mitralab.io/platform-sdk"

const client: MitraClient = createClient({ appId: "app", apiUrl: "https://api.example.com" })
const user: User = { id: "user", tenantId: "tenant", email: "user@example.com", name: null }
const query: QueryResult = { rows: [], affectedRows: null, durationMs: 0 }
const proxy: ProxyInput = { method: "GET", endpoint: "/", queryParams: { limit: "10" } }
const table: EntityTable = client.entities.getTable("Task")
const execution: FunctionExecution | undefined = undefined
const googleOptions: GoogleSignInOptions = { mode: "popup" }
// @ts-expect-error Google account creation is not a browser SDK option.
const unsupportedGoogleCreate: GoogleSignInOptions = { create: false }
const error = new MitraApiError("message", 400, "CODE", {})

void client.auth.currentUser
void client.auth.isAuthenticated
void client.auth.onAuthStateChange(() => undefined)
void client.auth.checkAuth()
void client.auth.ensureFreshSession()
void client.auth.ensureFreshSession(15_000)
void client.auth.signIn({ email: user.email, password: "password" })
void client.auth.signUp({ email: user.email, password: "password" })
void client.auth.signInWithGoogle(googleOptions)
void client.auth.completeGoogleSignInRedirect()
const publicExecution = {} as PublicFunctionExecutionResult
client.auth.signOut()
client.auth.redirectToLogin()
void client.init()
void client.functions.execute("function-id")
void client.functions.executeAsync("function-id")
void client.functions.getExecution("execution-id")
void client.functions.cancelExecution("execution-id")
void client.publicFunctions.execute("public-function-id")
void client.publicFunctions.executeAsync("public-function-id")
void client.integration.executeByAlias("billing", { method: "GET", endpoint: "/invoices" })
void client.integration.list({ page: 0, size: 20 })
void client.agentCredentials.list()
void client.agentCredentials.listModels()
void client.agentCredentials.startOAuth("ANTHROPIC")
void client.agentCredentials.startDeviceAuthorization("OPENAI")
// @ts-expect-error Session recovery is internal to Platform transports.
void client.auth.handleUnauthorized(null)
// @ts-expect-error Preview handoff is not part of the public template auth contract.
void client.auth.signInFromPreview()
// @ts-expect-error OpenAI OAuth is not a supported producer flow.
void client.agentCredentials.startOAuth("OPENAI")
const agentSession: NativeAgentTaskSession = client.agentTasks.session({ create: true, agentType: "CLAUDE" })
agentSession.send("hello")
agentSession.close()
const legacyConfig: MitraConfig = { baseURL: "https://api.example.com", projectId: "app" }
const interactionsConfig: InteractionsMitraConfig = legacyConfig
const structurallyIdenticalConfig: MitraConfig = interactionsConfig
const legacySession: Promise<LoginResponse> = loginWithGoogleMitra({ projectId: "app" })

void table
void query
void proxy
void execution
void publicExecution
void unsupportedGoogleCreate
void error
void legacyConfig
void interactionsConfig
void structurallyIdenticalConfig
void legacySession
void executeServerFunctionMitra
`
  );
  writeFileSync(
    join(consumerDirectory, 'consumer.cts'),
    `import sdk = require("@mitralab.io/platform-sdk")
const client: sdk.MitraClient = sdk.createClient({ appId: "app", apiUrl: "https://api.example.com" })
const user: sdk.User = { id: "user", tenantId: "tenant", email: "user@example.com", name: null }
const query: sdk.QueryResult = { rows: [], affectedRows: null, durationMs: 0 }
const proxy: sdk.ProxyInput = { method: "GET", endpoint: "/", queryParams: { limit: "10" } }
const error = new sdk.MitraApiError("message", 400, "CODE", {})
const googleOptions: sdk.GoogleSignInOptions = { mode: "redirect" }
// @ts-expect-error Google language is not a browser SDK option.
const unsupportedGoogleLanguage: sdk.GoogleSignInOptions = { language: "pt-BR" }
const legacyConfig: sdk.MitraConfig = { baseURL: "https://api.example.com", projectId: "app" }
void client.auth.signInWithGoogle(googleOptions)
void client.auth.completeGoogleSignInRedirect()
void client.auth.ensureFreshSession()
void client.publicFunctions.execute("public-function-id")
void client.integration.list()
const agentSession: sdk.NativeAgentTaskSession = client.agentTasks.session({ taskId: "task-id" })
agentSession.close()
void client
void user
void query
void proxy
void error
void unsupportedGoogleLanguage
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
