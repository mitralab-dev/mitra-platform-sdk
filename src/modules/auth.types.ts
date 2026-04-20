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
