type MitraEnvironmentWindow = Window & {
  __mitraEnv?: {
    authPageUrl?: unknown;
  };
};

/** Resolves and validates the shared native and legacy Google auth page URL. */
export function resolveAuthPageUrl(
  apiUrl: string,
  configuredAuthPageUrl?: string,
  browserWindow: MitraEnvironmentWindow | undefined = globalThis.window as MitraEnvironmentWindow | undefined
): URL {
  const injectedAuthPageUrl = browserWindow?.__mitraEnv?.authPageUrl;

  try {
    const candidate = configuredAuthPageUrl
      ?? (typeof injectedAuthPageUrl === 'string' && injectedAuthPageUrl.trim()
        ? injectedAuthPageUrl
        : new URL('/sdk-auth.html', apiUrl).toString());
    const url = new URL(candidate);
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new Error('authPageUrl must be an absolute HTTP or HTTPS URL.');
    return url;
  } catch {
    throw new Error('authPageUrl must be an absolute HTTP or HTTPS URL.');
  }
}
