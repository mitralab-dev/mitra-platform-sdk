# Changelog

All notable changes to this project are documented in this file.

## 1.1.0-beta.2

`1.1.0-beta.1` was published from `main` before this change landed, so it still depends on Core `0.2.0-beta.0`; use `1.1.0-beta.2`.

- Depend on `@mitralab.io/sdk-core@0.2.0-beta.1`, which reads back integration configs with a
  null `templateId` (configs born from an inline definition). The browser adapter still only
  lists and executes integration configs; authoring stays in the studio SDK and the MCP.

## 1.1.0-beta.0

- Complete native Function sync, async, polling, cancellation, and anonymous public execution.
- Expose browser-safe Agent Tasks, restricted Agent Credentials, and model discovery through Core 0.2 contracts.
- Compose the Core-owned Agent task session manager with Platform WebSocket and HTTP/SSE adapters.
- Add native anonymous polling for executions created by the public async Function route.
- Keep business-Agent administration out of the browser adapter according to the app-role permission matrix.
- Expose app-scoped integration config listing and execution by alias from Core 0.2.
- Document the missing producer contract for native record selection by `jdbcConnectionConfigId` instead of inventing a browser-side translation.
- Document that entity `update` already implements the producer's partial PUT semantics, so no duplicate PATCH method is needed.
- Derive Function execution, integration proxy input, and custom query result types directly from Core without narrowing nullable or producer-returned fields.
- Preserve the complete Data Manager record envelope and execute Custom Queries with only
  producer parameters, without a caller-selected Data Source or an `init()` precondition.

- Refresh app sessions proactively through IAM before authenticated native requests, with a 30-second JWT expiry heuristic and one shared refresh flight.
- Preserve sessions on transient refresh failures, clear them on definitive IAM client failures, and retain the one-time reactive `401` retry.
- Rotate both tokens without fetching the current user or notifying public auth-state listeners, while keeping the legacy bridge synchronized.
- Reject decodable access and refresh tokens whose app scope is missing or differs from the configured app while keeping opaque tokens server-authoritative.
- Fence refresh responses by session generation so late success or failure cannot undo sign-out or overwrite a newer login or bridged session.
- Bind reactive `401` handling to the token used by the rejected request so an old response cannot refresh or clear a replacement session.
- Redact values under sensitive credential field names from recursive API error details.
- Preserve the retained session when `auth.me()` reaches `401` after transient proactive and reactive refresh failures.
- Add native Google SSO through popup and redirect flows with direct IAM code exchange.
- Validate Google SSO origin, popup source, one-time state, cancellation, timeout, and token response shape.
- Require redirect errors to bind to the stored state before exposing or consuming them.
- Keep Google options limited to popup or redirect mode; account creation and locale remain producer concerns.
- Leave legacy-only `returnTo` and `title` on the deprecated aliases because the old runtime did not implement them as native Google controls.
- Preserve the email/password methods already public in Platform SDK 1.0.9 without presenting them as the new template flow.
- Route deprecated calls and legacy authentication through `${apiUrl}/legacy`.
- Apply the native auth page URL precedence to the deprecated SSO bridge.
- Propagate native sign-in, refresh, token changes, and sign-out to the legacy SDK session.
- Re-export the deprecated `mitra-interactions-sdk` surface from the package entrypoint.
- Mark every legacy type alias as deprecated in generated declarations.
- Share one session between this SDK and the legacy SDK in both directions.
- Make the SonarCloud job wait for the Quality Gate result.
- Align the public package metadata and ESM, CommonJS, and TypeScript artifacts.
- Add package shape checks and public tarball smoke coverage.
- Correct public imports and required configuration in documentation examples.
- Add the MIT license.

## 1.0.8

- Share environment-neutral API contracts through `@mitralab.io/sdk-core`.
- Preserve the Platform SDK 1.x browser authentication and entity facade.
- Validate redirects, API errors, sensitive-value redaction, and package consumers.
