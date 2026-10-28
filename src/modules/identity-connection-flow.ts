import type { HttpClient } from '../utils/http-client';
import { expectAuthTokenResponse } from './auth-page-flow';
import type { AuthTokenResponse } from './auth.types';

const STATE_PREFIX = 'connection.';
/** Same rule IAM applies to a connection slug; anything else would only build a strange path. */
const SLUG_PATTERN = /^[a-z0-9-]{1,64}$/;

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
      throw new Error(error.trim() || 'Identity connection sign-in failed.');
    }
    if (!code?.trim()) {
      throw new Error('Identity connection sign-in redirect is missing code.');
    }

    const response = await this.client.post<unknown>(
      `/api/v1/auth/identity-connections/${slug}/exchange`,
      { appId: this.appId, code }
    );
    return expectAuthTokenResponse(response);
  }
}
