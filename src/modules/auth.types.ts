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

/** Options for a sign-in that runs through the brand auth page. */
export interface AuthPageSignInOptions {
  /** Opens a popup by default. Redirect mode navigates the current page. */
  mode?: 'popup' | 'redirect';
}

/** Options for Google SSO. */
export type GoogleSignInOptions = AuthPageSignInOptions;

/** Options for Microsoft SSO. Same handshake as Google, through the brand auth page. */
export type MicrosoftSignInOptions = AuthPageSignInOptions;

/**
 * Options for email sign-in. Same handshake as SSO, through the brand auth page,
 * which collects the address and the one-time code.
 */
export type EmailSignInOptions = AuthPageSignInOptions;

/** Language of the message IAM sends. The platform writes it in these two. */
export type EmailCodeLanguage = 'pt-BR' | 'en';

/** The address to send a one-time code to, and the language to write it in. */
export interface EmailCodeRequest {
  email: string;
  /** Defaults to the browser language, and to `pt-BR` when that is neither. */
  language?: EmailCodeLanguage;
}

/**
 * What IAM accepted. The answer is deliberately neutral about whether the
 * address exists, so it carries no verdict about the person.
 */
export interface EmailCodeRequestResult {
  /** Names this request when the code is verified. Not a credential. */
  receipt: string;
  /** How long to wait before offering to send another message. */
  resendAfterSeconds: number;
}

/** The code the person read in the message, against the request that sent it. */
export interface EmailCodeVerification {
  receipt: string;
  code: string;
}

/**
 * Response from authentication token endpoints.
 * @internal
 */
export interface AuthTokenResponse {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
}

/** Callback for auth state changes. Receives the user on login, null on logout. */
export type AuthStateChangeCallback = (user: User | null) => void;
