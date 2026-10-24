import { MitraApiError, type HttpClient } from '../utils/http-client';
import { PASSWORD_CHANGED_SIGN_IN_AGAIN } from './auth-page-flow';
import { expectEmailCodeRequestResult, expectExchangeCode, resolveLanguage } from './email-code-flow';
import type {
  AuthTokenResponse,
  PasswordChange,
  PasswordResetConfirmation,
  PasswordSignUpCompletion,
  PasswordSignUpRequest,
  PasswordSignUpRequestResult,
  SignInCredentials,
} from './auth.types';

const PASSWORD_PATH = '/api/v1/auth/password';
const LOGIN_PATH = `${PASSWORD_PATH}/login`;
const SIGNUP_PATH = `${PASSWORD_PATH}/signup`;
const SIGNUP_VERIFY_PATH = `${SIGNUP_PATH}/verify`;
const RESET_CONFIRM_PATH = `${PASSWORD_PATH}/reset/confirm`;
/** Fragment key of the reset link IAM sends when the app has the form mode on. */
const RESET_TOKEN_KEY = 'resetToken';

/**
 * What IAM answers when a password route that carries a password or a reset
 * token is called from an origin that is not the Mitra auth page: from the
 * app's own origin with the form mode off, or from an origin that is not the
 * app's at all.
 */
const PASSWORD_FORM_NOT_ENABLED = 'PASSWORD_FORM_NOT_ENABLED';

/** @internal */
export interface ExchangeCodeRedeemer {
  redeemExchangeCode(code: string): Promise<AuthTokenResponse>;
}

interface PasswordFormFlowConfig {
  appId: string;
  client: HttpClient;
  exchange: ExchangeCodeRedeemer;
}

/**
 * Same message, status and code the popup's `changePassword()` rejects with, so
 * the application handles both the same way.
 *
 * @internal
 */
export function passwordChangedSignInAgain(cause: unknown): MitraApiError {
  const error = new MitraApiError(
    'The password was changed, but signing in again failed. Sign in with the new password.',
    401,
    PASSWORD_CHANGED_SIGN_IN_AGAIN
  );
  error.cause = cause;
  return error;
}

/**
 * The fix is in the app's settings, not in the code that called, so the
 * message says where the mode is turned on and which method works without it.
 */
function explainFormNotEnabled(error: unknown): unknown {
  if (!(error instanceof MitraApiError) || error.code !== PASSWORD_FORM_NOT_ENABLED) return error;
  return new MitraApiError(
    'This app does not accept the password from its own form. Turn on the "form in the app itself" '
      + 'mode of the password login in the app, or use the methods of the Mitra auth page: '
      + 'signInWithPassword(), signUpWithPassword() and changePassword().',
    error.status,
    error.code,
    error.details,
    error.retryAfterSeconds
  );
}

/**
 * Password login with the app's own screens: the app collects the password and
 * this flow sends it to IAM from the app's origin, with no Mitra page involved.
 * IAM accepts the steps that carry a password or a reset token only for an app
 * whose owner turned that mode on; asking for the sign-up code is free.
 */
export class PasswordFormFlow {
  private readonly appId: string;
  private readonly client: HttpClient;
  private readonly exchange: ExchangeCodeRedeemer;

  constructor(config: PasswordFormFlowConfig) {
    this.appId = config.appId;
    this.client = config.client;
    this.exchange = config.exchange;
  }

  async signIn(credentials: SignInCredentials): Promise<AuthTokenResponse> {
    const browserWindow = this.requireBrowser();
    return this.formRequest(async () => {
      const exchangeCode = expectExchangeCode(
        await this.client.post<unknown>(LOGIN_PATH, {
          email: credentials.email,
          password: credentials.password,
          appId: this.appId,
          origin: browserWindow.location.origin,
        }),
        'Password login response'
      );
      return this.exchange.redeemExchangeCode(exchangeCode);
    });
  }

  async startSignUp(request: PasswordSignUpRequest): Promise<PasswordSignUpRequestResult> {
    const browserWindow = this.requireBrowser();
    return expectEmailCodeRequestResult(
      await this.client.post<unknown>(SIGNUP_PATH, {
        email: request.email,
        appId: this.appId,
        origin: browserWindow.location.origin,
        language: resolveLanguage(request.language, browserWindow),
      }),
      'Password sign-up request response'
    );
  }

  async completeSignUp(completion: PasswordSignUpCompletion): Promise<AuthTokenResponse> {
    this.requireBrowser();
    return this.formRequest(async () => {
      const exchangeCode = expectExchangeCode(
        await this.client.post<unknown>(SIGNUP_VERIFY_PATH, {
          receipt: completion.receipt,
          code: completion.code,
          password: completion.password,
        }),
        'Password sign-up verification response'
      );
      return this.exchange.redeemExchangeCode(exchangeCode);
    });
  }

  /**
   * The token goes in the header by hand, on a client that never retries. IAM
   * answers a wrong current password with `401`, and a client that refreshes
   * and retries on `401` would spend a second guess against the account's
   * lockout with the same password.
   */
  async changePassword(change: PasswordChange, accessToken: string): Promise<void> {
    this.requireBrowser();
    return this.formRequest(async () => {
      await this.client.request<unknown>(PASSWORD_PATH, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: {
          ...(change.currentPassword === undefined ? {} : { currentPassword: change.currentPassword }),
          newPassword: change.newPassword,
        },
      });
    });
  }

  /**
   * The whole fragment leaves the URL, not only the token: the link IAM sends
   * to `/reset-password` carries only the token and the language of the
   * message, and the token would otherwise stay in the history and in every
   * reload.
   */
  readResetToken(): string | null {
    const browserWindow = this.requireBrowser();
    const params = new URLSearchParams(browserWindow.location.hash.replace(/^#/, ''));
    if (!params.has(RESET_TOKEN_KEY)) return null;

    browserWindow.history.replaceState(
      {},
      '',
      `${browserWindow.location.pathname}${browserWindow.location.search}`
    );
    const token = params.get(RESET_TOKEN_KEY)?.trim();
    return token || null;
  }

  async confirmReset(confirmation: PasswordResetConfirmation): Promise<void> {
    this.requireBrowser();
    return this.formRequest(async () => {
      await this.client.post<unknown>(RESET_CONFIRM_PATH, {
        token: confirmation.token,
        newPassword: confirmation.newPassword,
      });
    });
  }

  private async formRequest<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      throw explainFormNotEnabled(error);
    }
  }

  private requireBrowser(): Window {
    if (globalThis.window === undefined) {
      throw new Error('Password login is only available in a browser.');
    }
    return globalThis.window;
  }
}
