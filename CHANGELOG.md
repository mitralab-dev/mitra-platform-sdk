# Changelog

All notable changes to this project are documented in this file.

## 1.2.0-beta.2

- On the direct channel the message and the interrupt are written on the box socket, as the
  client frames the box already reads, instead of `POST /copilot/api/v1/tasks/{id}/inputs`. The
  box asks the Copilot for admission itself and answers on the same socket, so the Copilot's host
  socket buffer no longer bounds the message: the only limit is the box channel's own. REST stays
  for a chat with no box socket, for a socket not open at the moment of the send, a redial in
  progress included, and for every approval answer. A frame written on a socket that closes
  before the box acknowledges it is not resent over REST, since the box may have admitted the
  turn already; the redial's replay recovers it.

## 1.1.3

- A chat created through `session({ create: true })` over the `auto` or `websocket` transport is
  born on the T3 box: the create request carries `runtime: "T3"`. A chat created with
  `transport: "http"` stays on the runner, and an explicit `runtime` is forwarded as given.
- The box channel is asked for once. The Copilot now holds the channel request while the box
  boots, so the 2 s polling on a 202 answer is gone; a 202 from an older Copilot means the chat
  follows the Copilot socket.
- Depend on `@mitralab.io/sdk-core@0.2.4`, which carries the `runtime` session option into the
  create request, exports `AgentTaskRuntime`, and sends a prompt whose task already exists even
  when the session was closed inside its `taskCreated` handler.

## 1.2.0-beta.1

- Add `signInWithEmail()`: the platform auth page collects the address and the one-time code, and
  the single-use exchange code it returns is redeemed at IAM's `/auth/magic-link/exchange` for the
  same app session Google and Microsoft SSO already produce.
- Add `completeEmailSignInRedirect()`, which finishes both the mobile redirect and the tab opened
  by the link in the message.
- Keep the pending email request, the one-time state and the auth page URL and never a token, in
  `localStorage` for 10 minutes, so the tab opened by the link in the message finishes the flow
  through the same state check the redirect uses. Writing it is best effort for a popup and
  required for a redirect.
- Consume a fragment of the flow's own provider even when it cannot be completed, so a rejected or
  expired redirect is reported once instead of on every reload. A fragment of another flow stays
  untouched, and a pending request is still dropped only when it expires.
- Name the flow in the one-time state (`google.<random>`, `microsoft.<random>`, `email.<random>`),
  which the auth page echoes verbatim, so every `complete*SignInRedirect()` recognizes its own
  fragment: a fragment from another method returns `null` untouched, whatever this browser has
  pending, and an application that offers all three can call all three at startup in any order. A
  fragment that names this flow without matching its pending request is rejected as forged.
- Generalize the auth page handshake into `AuthPageFlow`, parameterized by provider, exchange
  route, and where the pending request lives, instead of a second copy for email.
- Upgrading mid-flow: a redirect started by an earlier version stored a state without the provider
  name, so the completion after the upgrade returns `null` and the person signs in again. Nothing
  is lost beyond that one attempt, and only for redirects in flight during the upgrade.
- Give each provider its own popup window name.
- Point the deprecated `signIn` and `signUp` failures at `signInWithEmail()`.
- Add `mitra.emailLoginEnabled`, read from `/info` during `init()` next to `allowSignup`, so an
  application only offers "sign in with email" when this app is inside the platform's rollout.
  A Code Studio older than the field answers without it, and any value that is not a boolean is
  read as `false`, so `init()` keeps working and an app that cannot prove it is enabled stops
  offering the option.

## 1.1.2

- Move the `@mitralab.io/sdk-core` pin from `0.2.1` to `0.2.2`: same surface, published with the
  contract corpus that consumers pin, so every SDK released that day sits on the same core.

## 1.1.1

- Depend on `@mitralab.io/sdk-core@0.2.1`, which replays `textChunk` and late deltas after an
  interrupted turn.
- Serve the Agent chat from the T3 box over the direct channel when the Copilot offers it.
- Treat a half-open Agent session channel as a disconnect instead of a live one.

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
