import type { HttpClient } from '../utils/http-client';
import { expectAuthTokenResponse } from './auth-page-flow';
import type { AuthTokenResponse } from './auth.types';

const STATE_PREFIX = 'connection.';
/** Same rule IAM applies to a connection slug; anything else would only build a strange path. */
export const SLUG_PATTERN = /^[a-z0-9-]{1,64}$/;
const WILDCARD_PREFIX = 'https://*.';
/** Any page can embed the app and write `errorMitra`, so only a code shaped like the bridge's reaches the message. */
const ERROR_CODE_PATTERN = /^[a-z_]{1,64}$/;

/**
 * Same rule the bridge page applies to the host system's origin: an exact
 * origin, or `https://*.domain` for any https subdomain without a port.
 */
export function isAllowedOrigin(origin: string, allowed: readonly string[]): boolean {
  const normalized = origin.toLowerCase();
  return allowed.some((candidate) => {
    if (!candidate.startsWith(WILDCARD_PREFIX)) return candidate === normalized;
    if (!normalized.startsWith('https://')) return false;
    const host = normalized.slice('https://'.length);
    const domain = candidate.slice(WILDCARD_PREFIX.length);
    return !host.includes(':') && !host.includes('/') && host.endsWith(`.${domain}`) && host.length > domain.length + 1;
  });
}

function readAllowedOrigins(response: unknown): string[] {
  const origins = (response as { allowedOrigins?: unknown } | null)?.allowedOrigins;
  return Array.isArray(origins) ? origins.filter((origin): origin is string => typeof origin === 'string') : [];
}

/**
 * Redeems the single-use code IAM issued for an identity connection sign-in.
 * Only a code issued against a PKCE challenge (SAML) takes a `codeVerifier`;
 * the others are issued without one, so the field is left out for them.
 */
export async function exchangeIdentityConnectionCode(
  client: HttpClient,
  slug: string,
  appId: string,
  code: string,
  codeVerifier?: string
): Promise<AuthTokenResponse> {
  const response = await client.post<unknown>(
    `/api/v1/auth/identity-connections/${slug}/exchange`,
    codeVerifier === undefined ? { appId, code } : { appId, code, codeVerifier }
  );
  return expectAuthTokenResponse(response);
}

interface IdentityConnectionFlowConfig {
  appId: string;
  client: HttpClient;
}

/**
 * Finishes a sign-in made through an identity connection, such as Sankhya Pass.
 *
 * The host system embeds the platform bridge page in an iframe and hands it its
 * own token. The bridge signs in at IAM and sends the iframe to this app's
 * origin with a single-use code in the fragment, which is redeemed here for the
 * app session. Tokens never travel in the URL or by `postMessage`.
 */
export class IdentityConnectionFlow {
  private readonly appId: string;
  private readonly client: HttpClient;

  constructor(config: IdentityConnectionFlowConfig) {
    this.appId = config.appId;
    this.client = config.client;
  }

  /**
   * Redeems the code the bridge put in the fragment, or returns `null` when the
   * fragment belongs to no identity connection. A fragment of another flow is
   * left exactly as it was found, so its own completion can still read it.
   *
   * A fragment of this flow is removed from the URL before anything can fail,
   * so a failure is reported once instead of on every reload, and the code is
   * never redeemed twice.
   */
  async completeRedirect(): Promise<AuthTokenResponse | null> {
    if (globalThis.window === undefined) {
      throw new Error('Identity connection sign-in is only available in a browser.');
    }
    const browserWindow = globalThis.window;
    const params = new URLSearchParams(browserWindow.location.hash.replace(/^#/, ''));
    const slug = params.get('connectionMitra');
    const state = params.get('stateMitra');
    if (slug === null || !state?.startsWith(STATE_PREFIX)) return null;

    const code = params.get('codeMitra');
    const error = params.get('errorMitra');
    browserWindow.history.replaceState(
      {},
      '',
      `${browserWindow.location.pathname}${browserWindow.location.search}`
    );

    // The bridge only runs inside the host system's iframe, so a code in a
    // top-level tab did not come through it. The fragment carries no state this
    // browser generated, and redeeming such a code would sign this browser in as
    // whoever obtained it.
    if (browserWindow.self === browserWindow.top) {
      throw new Error('Identity connection sign-in is only accepted inside the host system iframe.');
    }
    if (!SLUG_PATTERN.test(slug)) {
      throw new Error('Identity connection sign-in redirect names an invalid connection.');
    }
    if (error !== null) {
      const reason = ERROR_CODE_PATTERN.test(error) ? `: ${error}` : '';
      throw new Error(`Identity connection sign-in failed${reason}.`);
    }
    if (!code?.trim()) {
      throw new Error('Identity connection sign-in redirect is missing code.');
    }
    await this.requireAllowedHost(browserWindow, slug);

    return exchangeIdentityConnectionCode(this.client, slug, this.appId, code);
  }

  /**
   * A code is only redeemed when every page in the chain embedding this app is
   * a host system the connection allows. A page of someone else embedding the
   * app, directly or around an allowed host, with a code of another account
   * would otherwise sign this browser in as that account. The check mirrors
   * the one the bridge made on the message that carried the token.
   *
   * Only a browser that exposes `location.ancestorOrigins` can tell who embeds
   * the frame. Without it the host cannot be verified and the code is refused:
   * an unverifiable host is the exact case the check exists for.
   */
  private async requireAllowedHost(browserWindow: Window, slug: string): Promise<void> {
    const hostOrigins = Array.from(browserWindow.location.ancestorOrigins ?? []);
    if (hostOrigins.length === 0) {
      throw new Error('Identity connection sign-in needs a browser that exposes the host system origin.');
    }
    const connection = await this.client.get<unknown>(`/api/v1/auth/identity-connections/${slug}`);
    const allowedOrigins = readAllowedOrigins(connection);
    if (!hostOrigins.every((origin) => isAllowedOrigin(origin, allowedOrigins))) {
      throw new Error('Identity connection sign-in is not accepted under this host system.');
    }
  }
}
