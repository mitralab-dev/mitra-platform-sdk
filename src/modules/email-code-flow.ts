import { expectObject } from '@mitralab.io/sdk-core';
import { coreErrors } from '../core-errors';
import { MitraApiError, type HttpClient } from '../utils/http-client';
import type {
  AuthTokenResponse,
  EmailCodeLanguage,
  EmailCodeRequest,
  EmailCodeRequestResult,
  EmailCodeVerification,
} from './auth.types';

const MAGIC_LINK_PATH = '/api/v1/auth/magic-link';
const VERIFY_PATH = `${MAGIC_LINK_PATH}/verify`;
const CONFIRM_PATH = `${MAGIC_LINK_PATH}/confirm`;
/** Fragment key the message's link carries when it lands on the application's own origin. */
const LINK_TOKEN_KEY = 'emailToken';
const DEFAULT_LANGUAGE: EmailCodeLanguage = 'pt-BR';

/** What IAM says about a link when it is inspected, before anything is consumed. */
type MagicLinkState = 'OK' | 'EXPIRED' | 'USED' | 'INVALID';

const LINK_FAILURES: Record<
  Exclude<MagicLinkState, 'OK'>,
  { status: number; code: string; message: string }
> = {
  EXPIRED: {
    status: 409,
    code: 'MAGIC_LINK_EXPIRED',
    message: 'This sign-in link expired. Ask for a new message.',
  },
  USED: {
    status: 409,
    code: 'MAGIC_LINK_USED',
    message: 'This sign-in link was already used. Ask for a new message.',
  },
  INVALID: {
    status: 401,
    code: 'MAGIC_LINK_INVALID',
    message: 'This sign-in link is not valid.',
  },
};

function linkFailure(state: Exclude<MagicLinkState, 'OK'>): MitraApiError {
  const failure = LINK_FAILURES[state];
  return new MitraApiError(failure.message, failure.status, failure.code);
}

interface MagicLinkInspection {
  state: MagicLinkState;
  origin: string | undefined;
  sdkState: string | undefined;
}

/**
 * The pending request this flow shares with the auth page flow of the same
 * provider. Both write it under the same key and read it the same way, so a
 * message is finished by the link whichever of the two asked for it, and the
 * one-time state keeps naming the email flow.
 *
 * @internal
 */
export interface PendingEmailRequest {
  newRequestState(): string;
  rememberPendingRequest(state: string, redirectUri: string): void;
  pendingRequestState(): string | null;
  discardPendingRequest(): void;
  redeemExchangeCode(code: string): Promise<AuthTokenResponse>;
}

interface EmailCodeFlowConfig {
  appId: string;
  client: HttpClient;
  pendingRequest: PendingEmailRequest;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isMagicLinkState(value: string): value is MagicLinkState {
  return value === 'OK' || value === 'EXPIRED' || value === 'USED' || value === 'INVALID';
}

function expectEmailCodeRequestResult(value: unknown): EmailCodeRequestResult {
  const response = expectObject<Record<string, unknown>>(
    value,
    'Email code request response',
    coreErrors
  );

  if (typeof response.receipt !== 'string' || !response.receipt.trim()) {
    throw coreErrors.invalidResponse('Email code request response has an invalid receipt field');
  }
  if (typeof response.resendAfterSeconds !== 'number' || !Number.isFinite(response.resendAfterSeconds)) {
    throw coreErrors.invalidResponse(
      'Email code request response has an invalid resendAfterSeconds field'
    );
  }

  return { receipt: response.receipt, resendAfterSeconds: response.resendAfterSeconds };
}

function expectExchangeCode(value: unknown): string {
  const response = expectObject<Record<string, unknown>>(
    value,
    'Email sign-in exchange code response',
    coreErrors
  );

  if (typeof response.exchangeCode !== 'string' || !response.exchangeCode.trim()) {
    throw coreErrors.invalidResponse(
      'Email sign-in exchange code response has an invalid exchangeCode field'
    );
  }

  return response.exchangeCode;
}

/**
 * A verdict this SDK does not recognize is read as `INVALID`: the link is only
 * spent against an answer that says, in so many words, that it can be.
 */
function expectMagicLinkInspection(value: unknown): MagicLinkInspection {
  const response = expectObject<Record<string, unknown>>(
    value,
    'Email sign-in link inspection response',
    coreErrors
  );

  const state = optionalString(response.state);
  if (!state?.trim()) {
    throw coreErrors.invalidResponse(
      'Email sign-in link inspection response has an invalid state field'
    );
  }

  return {
    state: isMagicLinkState(state) ? state : 'INVALID',
    origin: optionalString(response.origin),
    sdkState: optionalString(response.sdkState),
  };
}

/**
 * Which language IAM writes the message in. The application decides; when it
 * does not, the browser does; and when the browser asks for a language the
 * platform does not write, the message goes out in the platform's own.
 */
function resolveLanguage(
  requested: EmailCodeLanguage | undefined,
  browserWindow: Window
): EmailCodeLanguage {
  if (requested) return requested;
  const preferred = browserWindow.navigator?.language ?? '';
  return preferred.toLowerCase().startsWith('en') ? 'en' : DEFAULT_LANGUAGE;
}

/**
 * Sign-in by email with nothing of the platform on screen: the application
 * renders its own address and code screens, IAM sends a message branded as the
 * app, and the link in that message comes back to the application's own origin.
 *
 * The link is spent only by the browser that asked for the message, which is
 * what a pending request with the same one-time state proves. Another browser,
 * or a scanner opening links on the way to a mailbox, finds nothing pending,
 * consumes nothing, and leaves the link valid for the person who asked.
 */
export class EmailCodeFlow {
  private readonly appId: string;
  private readonly client: HttpClient;
  private readonly pendingRequest: PendingEmailRequest;

  constructor(config: EmailCodeFlowConfig) {
    this.appId = config.appId;
    this.client = config.client;
    this.pendingRequest = config.pendingRequest;
  }

  /**
   * Asks IAM to send a code to an address, and writes down that a request is in
   * flight so the tab the link opens can finish it. Calling it again replaces
   * the pending request, which is what resending is.
   *
   * The request is written only once IAM accepts it. A resend IAM refuses, a
   * rate limit being the everyday case, would otherwise replace the request the
   * message already in the mailbox names, and silently kill that link.
   */
  async requestCode(request: EmailCodeRequest, brand: string): Promise<EmailCodeRequestResult> {
    const browserWindow = this.requireBrowser();
    const origin = browserWindow.location.origin;
    const state = this.pendingRequest.newRequestState();

    const result = expectEmailCodeRequestResult(
      await this.client.post<unknown>(MAGIC_LINK_PATH, {
        email: request.email,
        brand,
        language: resolveLanguage(request.language, browserWindow),
        appId: this.appId,
        origin,
        state,
      })
    );

    this.pendingRequest.rememberPendingRequest(state, origin);
    return result;
  }

  /**
   * Turns the code the person typed into an app session. IAM answers the
   * verification with a single-use exchange code, redeemed here through the same
   * route the auth page handshake uses.
   */
  async verifyCode(verification: EmailCodeVerification): Promise<AuthTokenResponse> {
    this.requireBrowser();

    const exchangeCode = expectExchangeCode(
      await this.client.post<unknown>(VERIFY_PATH, {
        receipt: verification.receipt,
        code: verification.code,
      })
    );

    // The challenge is spent, and with it the link the same message carried.
    this.pendingRequest.discardPendingRequest();
    return this.pendingRequest.redeemExchangeCode(exchangeCode);
  }

  /**
   * Finishes the sign-in from a `#emailToken=` link that landed on this origin,
   * or returns `null` when the URL carries no link, or carries one this browser
   * cannot claim. A link that can be claimed but is expired, already used, or
   * unknown to IAM is reported as a {@link MitraApiError}.
   *
   * The link is inspected before it is consumed, so a browser without the
   * pending request never spends it.
   */
  async completeLink(): Promise<AuthTokenResponse | null> {
    const browserWindow = this.requireBrowser();
    const fragment = browserWindow.location.hash.replace(/^#/, '');
    const token = new URLSearchParams(fragment).get(LINK_TOKEN_KEY);
    // An empty `#emailToken=` is not a link to claim: inspecting it would spend a
    // round trip to be told, correctly, that nothing there is valid.
    if (!token?.trim()) return null;

    const pendingState = this.pendingRequest.pendingRequestState();
    if (pendingState === null) {
      // Nobody here asked for this message, or the request is too old to finish.
      // Nothing is inspected and nothing is consumed: the link stays valid.
      this.dropLinkFromFragment(browserWindow, fragment);
      this.pendingRequest.discardPendingRequest();
      return null;
    }

    let inspection: MagicLinkInspection;
    try {
      inspection = expectMagicLinkInspection(
        await this.client.get<unknown>(CONFIRM_PATH, { token })
      );
    } catch (error) {
      // Inspecting consumes nothing, so the link stays valid in the mailbox and
      // can be opened again. The token still leaves the URL, like on every other
      // path that cannot complete, instead of failing on every reload from the
      // address bar and the history.
      this.dropLinkFromFragment(browserWindow, fragment);
      throw error;
    }
    if (inspection.state !== 'OK') {
      this.dropLinkFromFragment(browserWindow, fragment);
      throw linkFailure(inspection.state);
    }
    // The link belongs to the origin IAM validated against the app's published
    // origins, and to the request pending here. Either one off and it is not
    // this browser's to spend, so the pending request is left where it is.
    if (
      inspection.origin !== browserWindow.location.origin
      || inspection.sdkState !== pendingState
    ) {
      this.dropLinkFromFragment(browserWindow, fragment);
      return null;
    }

    try {
      const exchangeCode = expectExchangeCode(
        await this.client.post<unknown>(CONFIRM_PATH, { token })
      );
      return await this.pendingRequest.redeemExchangeCode(exchangeCode);
    } finally {
      // A link is single use, so it leaves the URL either way: a failure here is
      // reported once instead of on every reload.
      this.dropLinkFromFragment(browserWindow, fragment);
      this.pendingRequest.discardPendingRequest();
    }
  }

  /**
   * Removes the link from the URL and leaves the rest of the fragment exactly as
   * it was found. An application may route on it, and rewriting the fragment as
   * parameters would turn a path like `#/orders/1` into something its router no
   * longer recognizes.
   */
  private dropLinkFromFragment(browserWindow: Window, fragment: string): void {
    const remaining = fragment
      .split('&')
      .filter((part) => part !== LINK_TOKEN_KEY && !part.startsWith(`${LINK_TOKEN_KEY}=`))
      .join('&');
    const hash = remaining ? `#${remaining}` : '';
    browserWindow.history.replaceState(
      {},
      '',
      `${browserWindow.location.pathname}${browserWindow.location.search}${hash}`
    );
  }

  private requireBrowser(): Window {
    if (globalThis.window === undefined) {
      throw new Error('Email sign-in is only available in a browser.');
    }
    return globalThis.window;
  }
}
