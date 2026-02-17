import { HttpClient, MitraApiError } from '../utils/http-client';
import type {
  User,
  SignInCredentials,
  SignUpData,
  AuthTokenResponse,
  AuthStateChangeCallback,
} from './auth.types';

export type { User, SignInCredentials, SignUpData, AuthStateChangeCallback } from './auth.types';

/**
 * Authentication module for managing user sessions.
 *
 * Handles sign-in, sign-up, sign-out, and automatic token refresh.
 * Auth state is persisted to localStorage with key `mitra_auth_{appId}`
 * and restored on page reload.
 *
 * @example
 * ```typescript
 * await mitra.auth.signIn({ email: 'user@example.com', password: 'password' });
 * console.log(mitra.auth.currentUser);
 * ```
 */
export class AuthModule {
  private appId: string;
  private _currentUser: User | null = null;
  private _accessToken: string | null = null;
  private _refreshToken: string | null = null;
  private refreshPromise: Promise<boolean> | null = null;
  private listeners: Set<AuthStateChangeCallback> = new Set();
  private storageKey: string;
  private publicClient: HttpClient;
  private authedClient: HttpClient;

  constructor(appId: string, iamBaseUrl: string) {
    this.appId = appId;
    this.storageKey = `mitra_auth_${appId}`;
    this.publicClient = new HttpClient({ baseUrl: iamBaseUrl, getToken: () => null });
    this.authedClient = new HttpClient({ baseUrl: iamBaseUrl, getToken: () => this._accessToken });
    this.loadFromStorage();
  }

  /** The currently authenticated user, or null. */
  get currentUser(): User | null {
    return this._currentUser;
  }

  /** The current JWT access token, or null. */
  get accessToken(): string | null {
    return this._accessToken;
  }

  /** Whether a user is currently authenticated (local check, not server-validated). */
  get isAuthenticated(): boolean {
    return this._currentUser !== null && this._accessToken !== null;
  }

  /**
   * Signs in a user with email and password.
   *
   * On success, stores access token, refresh token, and user data.
   * Subsequent API requests use the token automatically.
   *
   * @param credentials - Email and password.
   * @returns The authenticated user.
   * @throws {MitraApiError} On invalid credentials (401).
   *
   * @example
   * ```typescript
   * const user = await mitra.auth.signIn({
   *   email: 'user@example.com',
   *   password: 'password123',
   * });
   * ```
   */
  async signIn(credentials: SignInCredentials): Promise<User> {
    const tokenResponse = await this.publicClient.post<AuthTokenResponse>(
      '/api/v1/auth/tokens',
      credentials
    );

    this._accessToken = tokenResponse.accessToken;
    this._refreshToken = tokenResponse.refreshToken;

    const user = await this.authedClient.get<User>('/api/v1/auth/me');

    this.setAuthState(user, tokenResponse.accessToken, tokenResponse.refreshToken);
    return user;
  }

  /**
   * Registers a new user and signs them in automatically.
   *
   * @param data - Email, password, and optional name.
   * @returns The newly created and authenticated user.
   * @throws {MitraApiError} On duplicate email (409) or validation error (400).
   *
   * @example
   * ```typescript
   * const user = await mitra.auth.signUp({
   *   email: 'new@example.com',
   *   password: 'securepassword',
   *   name: 'Jane Doe',
   * });
   * ```
   */
  async signUp(data: SignUpData): Promise<User> {
    await this.publicClient.post<User>('/api/v1/auth/users/register', {
      ...data,
      appId: this.appId,
    });

    return this.signIn({ email: data.email, password: data.password });
  }

  /**
   * Signs out the current user, clearing all auth state and localStorage.
   *
   * @param redirectUrl - Optional URL to navigate to after sign-out.
   *
   * @example
   * ```typescript
   * mitra.auth.signOut();
   * mitra.auth.signOut('/login');
   * ```
   */
  signOut(redirectUrl?: string): void {
    this.clearAuthState();

    if (typeof window !== 'undefined' && redirectUrl) {
      window.location.href = redirectUrl;
    }
  }

  /**
   * Refreshes the session using the stored refresh token.
   *
   * Called automatically by the SDK on 401 responses. Can also be called
   * manually. Multiple concurrent calls are deduplicated (only one refresh
   * request is made).
   *
   * @returns `true` if refresh succeeded, `false` otherwise.
   *
   * @example
   * ```typescript
   * const ok = await mitra.auth.refreshSession();
   * if (!ok) mitra.auth.redirectToLogin();
   * ```
   */
  async refreshSession(): Promise<boolean> {
    if (!this._refreshToken) return false;

    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = this.doRefresh();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  /**
   * Fetches the current user from the server and updates local state.
   *
   * Only clears auth state on 401 (expired/invalid token).
   * Transient errors (500, network) return null without clearing the session.
   *
   * @returns The user if authenticated, `null` otherwise.
   *
   * @example
   * ```typescript
   * const user = await mitra.auth.me();
   * if (!user) console.log('Not authenticated');
   * ```
   */
  async me(): Promise<User | null> {
    if (!this._accessToken) return null;

    try {
      const user = await this.authedClient.get<User>('/api/v1/auth/me');

      this._currentUser = user;
      this.saveToStorage();
      this.notifyListeners();
      return user;
    } catch (error) {
      if (error instanceof MitraApiError && error.status === 401) {
        this.clearAuthState();
      }
      return null;
    }
  }

  /**
   * Validates the current session with the server.
   *
   * @returns `true` if the session is valid, `false` otherwise.
   *
   * @example
   * ```typescript
   * const valid = await mitra.auth.checkAuth();
   * if (!valid) mitra.auth.redirectToLogin();
   * ```
   */
  async checkAuth(): Promise<boolean> {
    return (await this.me()) !== null;
  }

  /**
   * Sets the access token manually (e.g., from SSO/OAuth callback).
   *
   * Call `me()` afterwards to fetch the associated user data.
   *
   * @param token - JWT access token.
   * @param saveToStorage - Whether to persist to localStorage (default: true).
   *
   * @example
   * ```typescript
   * mitra.auth.setToken(tokenFromCallback);
   * await mitra.auth.me();
   * ```
   */
  setToken(token: string, saveToStorage: boolean = true): void {
    this._accessToken = token;
    if (saveToStorage) {
      this.saveToStorage();
    }
  }

  /**
   * Redirects to `/login?returnUrl=...` for unauthenticated users.
   *
   * @param returnUrl - URL to return to after login (default: '/').
   *
   * @example
   * ```typescript
   * if (!mitra.auth.isAuthenticated) {
   *   mitra.auth.redirectToLogin(window.location.pathname);
   * }
   * ```
   */
  redirectToLogin(returnUrl: string = '/'): void {
    if (typeof window === 'undefined') return;
    window.location.href = `/login?returnUrl=${encodeURIComponent(returnUrl)}`;
  }

  /**
   * Registers a callback for auth state changes.
   *
   * Called immediately with the current state, then on every sign-in/sign-out.
   *
   * @param callback - Receives the User on login, null on logout.
   * @returns Unsubscribe function.
   *
   * @example
   * ```typescript
   * useEffect(() => {
   *   const unsub = mitra.auth.onAuthStateChange((user) => {
   *     setUser(user);
   *     setLoading(false);
   *   });
   *   return unsub;
   * }, []);
   * ```
   */
  onAuthStateChange(callback: AuthStateChangeCallback): () => void {
    this.listeners.add(callback);
    callback(this._currentUser);

    return () => {
      this.listeners.delete(callback);
    };
  }

  private async doRefresh(): Promise<boolean> {
    try {
      const tokenResponse = await this.publicClient.post<AuthTokenResponse>(
        '/api/v1/auth/tokens/refresh',
        { refreshToken: this._refreshToken }
      );

      this._accessToken = tokenResponse.accessToken;
      this._refreshToken = tokenResponse.refreshToken;

      const user = await this.authedClient.get<User>('/api/v1/auth/me');

      this.setAuthState(user, tokenResponse.accessToken, tokenResponse.refreshToken);
      return true;
    } catch {
      this.clearAuthState();
      return false;
    }
  }

  private setAuthState(user: User, token: string, refreshToken: string): void {
    this._currentUser = user;
    this._accessToken = token;
    this._refreshToken = refreshToken;
    this.saveToStorage();
    this.notifyListeners();
  }

  private clearAuthState(): void {
    this._currentUser = null;
    this._accessToken = null;
    this._refreshToken = null;
    this.removeFromStorage();
    this.notifyListeners();
  }

  private notifyListeners(): void {
    this.listeners.forEach((callback) => {
      try {
        callback(this._currentUser);
      } catch (error) {
        console.error('Auth state change listener error:', error);
      }
    });
  }

  private saveToStorage(): void {
    if (typeof localStorage === 'undefined') return;

    try {
      localStorage.setItem(
        this.storageKey,
        JSON.stringify({
          user: this._currentUser,
          token: this._accessToken,
          refreshToken: this._refreshToken,
        })
      );
    } catch {
      // Storage might be full or disabled
    }
  }

  private loadFromStorage(): void {
    if (typeof localStorage === 'undefined') return;

    try {
      const stored = localStorage.getItem(this.storageKey);
      if (stored) {
        const { user, token, refreshToken } = JSON.parse(stored);
        this._currentUser = user;
        this._accessToken = token;
        this._refreshToken = refreshToken ?? null;
      }
    } catch {
      this.removeFromStorage();
    }
  }

  private removeFromStorage(): void {
    if (typeof localStorage === 'undefined') return;

    try {
      localStorage.removeItem(this.storageKey);
    } catch {
      // Storage might be disabled
    }
  }
}
