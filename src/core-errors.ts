import type { SdkCoreErrorFactory } from '@mitralab.io/sdk-core';
import { MitraApiError } from './utils/http-client';

export const coreErrors: SdkCoreErrorFactory = {
  configuration: (message) => new MitraApiError(message, 0, 'INVALID_CONFIGURATION'),
  invalidResponse: (message) => new MitraApiError(message, 200, 'INVALID_RESPONSE'),
};
