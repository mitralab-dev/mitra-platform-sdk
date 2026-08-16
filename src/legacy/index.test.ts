import { describe, it, expect } from 'vitest';
import * as legacyPackage from 'mitra-interactions-sdk';
import * as platformSdk from '../index';
import {
  callIntegrationMitra,
  configureSdkMitra,
  createMitraInstance,
  createRecordMitra,
  createRecordsBatchMitra,
  deleteRecordMitra,
  exchangeSsoCodeMitra,
  executePublicServerFunctionAsyncMitra,
  executePublicServerFunctionMitra,
  executeServerFunctionAsyncMitra,
  executeServerFunctionMitra,
  getAgentTaskMitra,
  getConfig,
  getPublicServerFunctionExecutionMitra,
  getRecordMitra,
  listIntegrationsMitra,
  listRecordsMitra,
  loginMitra,
  loginWithGoogleMitra,
  loginWithMicrosoftMitra,
  manageAgentChatMitra,
  manageAgentCredentialMitra,
  patchRecordMitra,
  refreshTokenSilently,
  resolveProjectId,
  stopServerFunctionExecutionMitra,
  updateRecordMitra,
} from '../index';
import type {
  AgentTaskSession,
  ExecuteServerFunctionOptions,
  ListRecordsOptions,
  LoginResponse,
  MitraConfig,
  MitraInstance,
} from '../index';

/** Sessions produced by legacy login are routed through the bridge. */
const bridgedExports = [
  'exchangeSsoCodeMitra',
  'loginMitra',
  'loginWithGoogleMitra',
  'loginWithMicrosoftMitra',
];

describe('legacy surface', () => {
  it('should resolve every named import as a function', () => {
    const namedImports = {
      callIntegrationMitra,
      configureSdkMitra,
      createMitraInstance,
      createRecordMitra,
      createRecordsBatchMitra,
      deleteRecordMitra,
      exchangeSsoCodeMitra,
      executePublicServerFunctionAsyncMitra,
      executePublicServerFunctionMitra,
      executeServerFunctionAsyncMitra,
      executeServerFunctionMitra,
      getAgentTaskMitra,
      getConfig,
      getPublicServerFunctionExecutionMitra,
      getRecordMitra,
      listIntegrationsMitra,
      listRecordsMitra,
      loginMitra,
      loginWithGoogleMitra,
      loginWithMicrosoftMitra,
      manageAgentChatMitra,
      manageAgentCredentialMitra,
      patchRecordMitra,
      refreshTokenSilently,
      resolveProjectId,
      stopServerFunctionExecutionMitra,
      updateRecordMitra,
    };

    Object.entries(namedImports).forEach(([name, value]) => {
      expect(typeof value, name).toBe('function');
    });
  });

  it('should re-export the whole legacy runtime surface', () => {
    const legacyExports = Object.keys(legacyPackage).sort();
    const reExported = legacyExports.filter((name) => name in platformSdk);

    expect(reExported).toEqual(legacyExports);
  });

  it('should pass through every legacy export the bridge does not wrap', () => {
    Object.keys(legacyPackage)
      .filter((name) => !bridgedExports.includes(name))
      .forEach((name) => {
        expect(platformSdk[name as keyof typeof platformSdk], name).toBe(
          legacyPackage[name as keyof typeof legacyPackage]
        );
      });
  });

  it('should wrap the legacy exports that produce a session', () => {
    bridgedExports.forEach((name) => {
      expect(platformSdk[name as keyof typeof platformSdk], name).not.toBe(
        legacyPackage[name as keyof typeof legacyPackage]
      );
    });
  });

  it('should not shadow the new surface', () => {
    const legacyExports = new Set(Object.keys(legacyPackage));
    const newExports = ['createClient', 'MitraApiError'];

    newExports.forEach((name) => {
      expect(legacyExports.has(name), name).toBe(false);
      expect(platformSdk[name as keyof typeof platformSdk], name).toBeDefined();
    });
  });

  it('should resolve the legacy types', () => {
    const config: MitraConfig = { baseURL: 'https://api.mitra.io', projectId: 'app-1' };
    const session: LoginResponse = { token: 'token', baseURL: config.baseURL as string };
    const execute: ExecuteServerFunctionOptions = { serverFunctionId: 1 };
    const list: ListRecordsOptions = { tableName: 'Task' };
    const instance: MitraInstance | undefined = undefined;
    const task: AgentTaskSession | undefined = undefined;

    expect(session.token).toBe('token');
    expect(execute.serverFunctionId).toBe(1);
    expect(list.tableName).toBe('Task');
    expect(instance).toBeUndefined();
    expect(task).toBeUndefined();
  });
});
