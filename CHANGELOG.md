# Changelog

All notable changes to this project are documented in this file.

## 1.2.0-beta.3

- `session({ create: true })`, `agentTasks.create()` and `session.send()` (with `sendAndWait()`
  and the queued sends) accept `model`, the catalog model id `listModels()` returns,
  `custom/<providerId>/<model>` for a provider the person added by API. It is passed through
  unchanged: in the create body, in the message frame on the box socket and in the `POST /inputs`
  body. The Copilot requires it when `agentType` is `CUSTOM_AI`. Without `model` nothing changes
  on the wire.
- `NativeAgentModel` carries `providerName`, the name the person chose for a custom provider,
  null on built-in models, and `AgentTask` carries the `model` the chat was created with.
- Depend on `@mitralab.io/sdk-core@0.2.6-beta.0`, which carries `model` through the create
  request and the message and adds custom providers to the connection module this package does
  not expose.

## 1.2.0-beta.2

- Add `requestEmailCode({ email, language? })` and `verifyEmailCode({ receipt, code })`: sign-in by
  email with no platform screen at all. The application renders its own address and code fields,
  IAM sends a message branded as the app, and the verification returns the single-use exchange
  code the SDK redeems for the same app session SSO produces.
- Land the link that message carries on the application's own origin, as `#emailToken=<token>`,
  completed by the same `completeEmailSignInRedirect()` at startup. The link is inspected before it
  is consumed and spent only when IAM reports the origin the page is on and the one-time state of
  the request pending in this browser, so another browser, another device, or a scanner opening
  links on the way to a mailbox consumes nothing and leaves the link valid for whoever asked.
- Keep the pending headless request under the same `mitra_email_redirect_{appId}` key the auth page
  flow uses, with the same 10 minutes and the same contents: the one-time state and the app origin,
  never a token. It is written once IAM accepts the request, so a resend IAM refuses, a rate limit
  being the everyday case, leaves the message already in the mailbox completable by its link.
- Take only `emailToken` out of the URL when the link lands, leaving the rest of the fragment
  exactly as it was found, so an application that routes on it keeps its route.
- Send `brand` and `language` with the request: the brand comes from the app info `init()` reads,
  and asking before `init()` fails with `INVALID_CONFIGURATION` instead of branding a message at
  random. The language is the caller's, then the browser's, then `pt-BR`.
- Add `MitraApiError.retryAfterSeconds`, read from `Retry-After`, so a `429` says how long to wait
  instead of leaving the application to guess. It is `null` when the response carries no delay,
  including when CORS keeps the header from reaching the browser. The field is the last constructor
  parameter and optional, so existing construction is unchanged.
- Keep `signInWithEmail()`, the platform page popup and redirect, working exactly as before, along
  with the `#codeMitra` completion and the Google and Microsoft flows.

## 1.1.5-beta.0

- The eight `agentCredentials` methods take a trailing `{ scope: "ACCOUNT" }`, sent as the
  `scope=ACCOUNT` query parameter, and `session({ create: true })` and `agentTasks.create()`
  accept `scope: "ACCOUNT"` in the create body, so the credential and the chat resolve against
  the person's own account instead of the app. Without `scope` nothing changes on the wire. The
  Copilot honors `ACCOUNT` only for apps listed by flag and answers
  `ACCOUNT_CREDENTIAL_NOT_ALLOWED` otherwise.
- Depend on `@mitralab.io/sdk-core@0.2.5-beta.0`, which carries the `scope` option through the
  credential calls and into the create request and exports `AgentCredentialScope` and
  `AgentCredentialOptions`.

## 1.1.4-beta.0

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
