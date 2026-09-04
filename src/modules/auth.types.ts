/** Authenticated user in the Mitra Platform. */
export interface User {
  /** Unique identifier. */
  id: string;
  /** Tenant the user belongs to. */
  tenantId: string;
  /** Email address. */
  email: string;
  /** Display name (optional). */
  name: string | null;
}

/** Credentials for sign-in. */
export interface SignInCredentials {
  email: string;
  password: string;
}

/** Data for user registration. */
export interface SignUpData {
  email: string;
  password: string;
  name?: string;
}

/** App-scoped session received from a trusted platform boundary. */
export interface AuthSession {
  accessToken: string;
  refreshToken?: string | null;
}

/** Options for Google SSO. */
export interface GoogleSignInOptions {
  /** Opens a popup by default. Redirect mode navigates the current page. */
  mode?: 'popup' | 'redirect';
}

/** Options for Microsoft SSO. Same handshake as Google, through the brand auth page. */
export type MicrosoftSignInOptions = GoogleSignInOptions;

/** Session-scoped platform tokens, usable against the tenant endpoints of IAM. */
export interface PlatformSessionTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
}

/** Long-lived mitraSpace token issued at login. It has no refresh flow. */
export interface MitraSpaceToken {
  token: string;
  tokenType: string;
}

/** Extra tokens returned by IAM only for apps enabled server-side. */
export interface AllTokens {
  /** Null when the user has no membership in the tenant that owns the app. */
  platform: PlatformSessionTokens | null;
  /** Null when mitraSpace is unreachable or the user has no account there. */
  mitraSpace: MitraSpaceToken | null;
}

/**
 * Response from authentication token endpoints.
 * @internal
 */
export interface AuthTokenResponse {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  allTokens?: AllTokens;
}

/** Callback for auth state changes. Receives the user on login, null on logout. */
export type AuthStateChangeCallback = (user: User | null) => void;
