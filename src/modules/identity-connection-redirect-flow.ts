import type { HttpClient } from '../utils/http-client';
import { stripTrailingSlashes } from '../utils/url';
import type { AuthTokenResponse, IdentityConnectionSignInOptions } from './auth.types';
import { resolveLanguage } from './email-code-flow';
import { SLUG_PATTERN, exchangeIdentityConnectionCode } from './identity-connection-flow';

const STATE_PREFIX = 'connection.';
const SCOPE = 'openid email profile';
/** Parameters the identity provider appends to the redirect URI on its way back. */
const CALLBACK_PARAMS = ['code', 'state', 'error', 'error_description', 'error_uri', 'session_state', 'iss'];
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;
const STORAGE_UNREADABLE = Symbol('storage-unreadable');

/**
 * A callback that arrived in a tab with no sign-in pending, such as a forged
 * link. Nobody was being signed in, so the session already in the page stays.
 */
export class UnsolicitedIdentityConnectionRedirectError extends Error {}

interface ConnectionEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
}

type ConnectionRoute = { protocol: 'OIDC_ASSERTION'; endpoints: ConnectionEndpoints } | { protocol: 'SAML' };

interface OidcRedirectContext {
  state: string;
  codeVerifier: string;
  slug: string;
  redirectUri: string;
  tokenEndpoint: string;
  clientId: string;
  language: string;
  // OIDC contexts, old and new, carry no protocol, so its absence means OIDC.
  protocol?: undefined;
}

interface SamlRedirectContext {
  state: string;
  codeVerifier: string;
  slug: string;
  redirectUri: string;
  language: string;
  protocol: 'SAML';
}

type RedirectContext = OidcRedirectContext | SamlRedirectContext;

interface IdentityConnectionRedirectFlowConfig {
  appId: string;
  client: HttpClient;
  /** Absolute IAM base URL; a SAML sign-in starts with a top-level navigation there, not a request. */
  iamUrl: string;
  storageKey: string;
}

function requireBrowser(): Window {
  if (globalThis.window === undefined) {
    throw new Error('Identity connection sign-in is only available in a browser.');
  }
  return globalThis.window;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function readRoute(connection: unknown): ConnectionRoute | null {
  const fields = (connection ?? {}) as Partial<Record<keyof ConnectionEndpoints | 'protocol', unknown>>;
  // An IAM that predates SAML sends no protocol, and every connection it has is OIDC.
  const protocol = fields.protocol ?? 'OIDC_ASSERTION';
  if (protocol === 'SAML') return { protocol };
  if (protocol !== 'OIDC_ASSERTION') return null;
  const { authorizationEndpoint, tokenEndpoint, clientId } = fields;
  if (!isNonEmptyString(authorizationEndpoint) || !isNonEmptyString(tokenEndpoint) || !isNonEmptyString(clientId)) {
    return null;
  }
  return { protocol, endpoints: { authorizationEndpoint, tokenEndpoint, clientId } };
}

function toQuery(params: Record<string, string>): string {
  return Object.entries(params).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('&');
}

function base64Url(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (byte) => String.fromCodePoint(byte)).join('');
  // The padding is at most two characters, so trimming it in a loop keeps the regex linear.
  let encoded = btoa(binary).replaceAll('+', '-').replaceAll('/', '_');
  while (encoded.endsWith('=')) encoded = encoded.slice(0, -1);
  return encoded;
}

function randomBytes(length: number): Uint8Array {
  if (!globalThis.crypto?.getRandomValues || !globalThis.crypto.subtle) {
    throw new Error('Identity connection sign-in requires the Web Crypto API.');
  }
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

async function codeChallengeOf(codeVerifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  return base64Url(new Uint8Array(digest));
}

/** RFC 6749 3.1.2: the redirection endpoint carries no fragment, and the callback query is the provider's. */
function requireBareRedirectUri(redirectUri: string, browserWindow: Window): string {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new Error('Identity connection sign-in redirectUri must be an absolute URL.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Identity connection sign-in redirectUri must be an http or https URL.');
  }
  // The pending request lives in this origin's sessionStorage, so a return to
  // another origin could never be completed.
  if (parsed.origin !== browserWindow.location.origin) {
    throw new Error('Identity connection sign-in redirectUri must be on the app origin.');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Identity connection sign-in redirectUri must have no query and no fragment.');
  }
  return redirectUri;
}

function readContext(value: string | null): RedirectContext | null {
  if (!value) return null;
  try {
    const context = JSON.parse(value) as Partial<OidcRedirectContext> | Partial<SamlRedirectContext>;
    const common = isNonEmptyString(context.state)
      && isNonEmptyString(context.codeVerifier)
      && isNonEmptyString(context.slug)
      && isNonEmptyString(context.redirectUri);
    if (!common) return null;
    if (context.protocol === 'SAML') return context as SamlRedirectContext;
    if (context.protocol !== undefined) return null;
    const oidc = context as Partial<OidcRedirectContext>;
    return isNonEmptyString(oidc.tokenEndpoint) && isNonEmptyString(oidc.clientId)
      ? (oidc as OidcRedirectContext)
      : null;
  } catch {
    return null;
  }
}

/**
 * Signs in through an identity connection, such as Sankhya Pass, by sending
 * the page to the connection's identity provider (Authorization Code with
 * PKCE) instead of relying on a host system iframe.
 *
 * The provider's access token is only the assertion IAM validates at
 * `/login`; it is used once and never kept. Its id token and refresh token are
 * ignored, so the only session left behind is the app session IAM issues.
 *
 * A SAML connection is spoken to by IAM, not by the browser: the page goes to
 * IAM's `/saml/login`, which sends it back with an IAM exchange code bound to
 * the PKCE challenge, so the verifier is the only proof this tab holds.
 */
export class IdentityConnectionRedirectFlow {
  private readonly appId: string;
  private readonly client: HttpClient;
  private readonly iamUrl: string;
  private readonly storageKey: string;

  constructor(config: IdentityConnectionRedirectFlowConfig) {
    this.appId = config.appId;
    this.client = config.client;
    this.iamUrl = stripTrailingSlashes(config.iamUrl);
    this.storageKey = config.storageKey;
  }

  async start(slug: string, options: Partial<IdentityConnectionSignInOptions> = {}): Promise<never> {
    const browserWindow = requireBrowser();
    if (!SLUG_PATTERN.test(slug)) {
      throw new Error('Identity connection sign-in names an invalid connection.');
    }
    const redirectUri = options.redirectUri === undefined
      ? `${browserWindow.location.origin}${browserWindow.location.pathname}`
      : requireBareRedirectUri(options.redirectUri, browserWindow);
    const route = readRoute(
      await this.client.get<unknown>(`/api/v1/auth/identity-connections/${slug}`)
    );
    if (!route) {
      throw new Error(`Identity connection ${slug} does not support redirect sign-in.`);
    }

    const random = Array.from(randomBytes(16), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const state = `${STATE_PREFIX}${slug}.${random}`;
    // 32 random bytes encode to a 43 character verifier, the minimum RFC 7636 allows.
    const codeVerifier = base64Url(randomBytes(32));
    const language = resolveLanguage(options.language, browserWindow);
    const context: RedirectContext = route.protocol === 'SAML'
      ? { state, codeVerifier, slug, redirectUri, language, protocol: 'SAML' }
      : {
        state,
        codeVerifier,
        slug,
        redirectUri,
        tokenEndpoint: route.endpoints.tokenEndpoint,
        clientId: route.endpoints.clientId,
        language,
      };
    try {
      browserWindow.sessionStorage.setItem(this.storageKey, JSON.stringify(context));
    } catch {
      throw new Error('Identity connection sign-in redirect requires sessionStorage.');
    }

    const codeChallenge = await codeChallengeOf(codeVerifier);
    if (route.protocol === 'SAML') {
      const query = toQuery({ appId: this.appId, returnTo: redirectUri, state, codeChallenge, language });
      browserWindow.location.assign(`${this.iamUrl}/api/v1/auth/identity-connections/${slug}/saml/login?${query}`);
    } else {
      const { authorizationEndpoint, clientId } = route.endpoints;
      const query = toQuery({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: SCOPE,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
      const separator = authorizationEndpoint.includes('?') ? '&' : '?';
      browserWindow.location.assign(`${authorizationEndpoint}${separator}${query}`);
    }

    return new Promise<never>(() => undefined);
  }

  /**
   * Finishes the sign-in from the query the identity provider sent back, or
   * returns `null` when the query belongs to no identity connection redirect,
   * leaving the URL as it was. The query of this flow is removed before
   * anything can fail, and the stored context is spent on the first read, so a
   * failure is reported once and a code is never redeemed twice.
   */
  async complete(): Promise<AuthTokenResponse | null> {
    const browserWindow = requireBrowser();
    const params = new URLSearchParams(browserWindow.location.search);
    const state = params.get('state');
    if (!state?.startsWith(STATE_PREFIX)) return null;

    const code = params.get('code');
    const error = params.get('error');
    const errorDescription = params.get('error_description');
    const context = this.takeContext(browserWindow);
    this.clearCallbackQuery(browserWindow, params);

    // `iss` (RFC 9207) and a `nonce` are not checked: each pending request
    // names the one provider it was sent to, and its id token is never used.
    if (context === STORAGE_UNREADABLE) {
      throw new UnsolicitedIdentityConnectionRedirectError(
        'Identity connection sign-in context was not found in this tab: sessionStorage is unreadable.'
      );
    }
    if (!context) {
      throw new UnsolicitedIdentityConnectionRedirectError(
        'Identity connection sign-in redirect does not match a pending request (possible CSRF).'
      );
    }
    if (context.state !== state) {
      throw new Error('Identity connection sign-in redirect does not match a pending request (possible CSRF).');
    }
    if (error !== null) {
      throw new Error(errorDescription?.trim() || error.trim() || 'Identity connection sign-in failed.');
    }
    if (!code?.trim()) {
      throw new Error('Identity connection sign-in redirect is missing code.');
    }

    if (context.protocol === 'SAML') {
      // IAM already issued the exchange code, so there is no provider redemption and no /login.
      return exchangeIdentityConnectionCode(this.client, context.slug, this.appId, code, context.codeVerifier);
    }

    const assertion = await this.redeemAuthorizationCode(context, code);
    const login = await this.client.post<{ exchangeCode?: unknown }>(
      `/api/v1/auth/identity-connections/${context.slug}/login`,
      { token: assertion, appId: this.appId, language: context.language }
    );
    if (!isNonEmptyString(login?.exchangeCode)) {
      throw new Error('Identity connection sign-in did not return an exchange code.');
    }
    return exchangeIdentityConnectionCode(this.client, context.slug, this.appId, login.exchangeCode);
  }

  private takeContext(browserWindow: Window): RedirectContext | null | typeof STORAGE_UNREADABLE {
    try {
      const context = readContext(browserWindow.sessionStorage.getItem(this.storageKey));
      browserWindow.sessionStorage.removeItem(this.storageKey);
      return context;
    } catch {
      return STORAGE_UNREADABLE;
    }
  }

  private clearCallbackQuery(browserWindow: Window, params: URLSearchParams): void {
    CALLBACK_PARAMS.forEach((name) => params.delete(name));
    const query = params.toString();
    const search = query ? `?${query}` : '';
    browserWindow.history.replaceState(
      {},
      '',
      `${browserWindow.location.pathname}${search}${browserWindow.location.hash}`
    );
  }

  private async redeemAuthorizationCode(context: OidcRedirectContext, code: string): Promise<string> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Error('Identity connection sign-in timed out redeeming the authorization code at the identity provider.');
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(timedOut);
      }, TOKEN_REQUEST_TIMEOUT_MS);
    });
    let response: Response;
    let body: { access_token?: unknown; error?: unknown; error_description?: unknown } | null;
    try {
      response = await Promise.race([
        fetch(context.tokenEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: context.clientId,
            code,
            redirect_uri: context.redirectUri,
            code_verifier: context.codeVerifier,
          }).toString(),
          credentials: 'omit',
          // The code and the verifier go to the token endpoint the connection named, never to a
          // host a redirect would pick.
          redirect: 'error',
          signal: controller.signal,
        }),
        timeout,
      ]);
      body = await Promise.race([response.json().catch(() => null), timeout]);
    } catch (error) {
      if (error === timedOut) throw error;
      // A provider that does not list the app origin in its Web Origins (CORS)
      // fails here as a bare network TypeError.
      throw new Error(
        'Identity connection sign-in could not reach the identity provider token endpoint; check that the app origin is in its Web Origins.'
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      // The provider's own text could echo the request, so the secrets it carried are masked.
      const reason = [body?.error, body?.error_description]
        .filter(isNonEmptyString)
        .join(': ')
        .split(code).join('[redacted]')
        .split(context.codeVerifier).join('[redacted]');
      const detail = reason ? `, ${reason}` : '';
      throw new Error(
        `Identity connection sign-in could not redeem the authorization code (status ${response.status}${detail}).`
      );
    }
    if (!isNonEmptyString(body?.access_token)) {
      throw new Error('Identity connection sign-in did not receive an access token from the identity provider.');
    }
    return body.access_token;
  }
}
