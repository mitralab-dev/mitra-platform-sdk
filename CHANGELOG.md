# Changelog

All notable changes to this project are documented in this file.

## 1.8.5

- Depend on `@mitralab.io/sdk-core@0.3.6`: a session that loads the history while a turn runs, with
  a page that starts after that turn's question, no longer shows the question again at the end of
  `history`, nor twice after `loadOlder`.

## 1.8.4

- Depend on `@mitralab.io/sdk-core@0.3.5`: a second tab that sends a message to the queue of a chat
  whose turn runs now sees that turn end, and the `sendAndWait` of the queued message resolves only
  with its own turn; `FunctionVersion.code` accepts `null` when the Functions API redacts source.

## 1.8.3

- Depend on `@mitralab.io/sdk-core@0.3.4`: the `notification` history item carries `source`,
  `outcome`, `summary` and `detail` on top, as the live `notification` event does, with `payload`
  kept; and a redial the box opens with its state no longer leaves the session `streaming` with no
  `delta` and no `turnEnd`.

## 1.8.2

- Depend on `@mitralab.io/sdk-core@0.3.3`: background work that ended reaches the agent session as
  a `notification` event and a `notification` history item (`AgentTimelineItem` gains that member,
  with `payload` and no `text`), tool events and items carry the tool's `title`, and the README
  says a `send` without `mode` goes into the running turn.
- `NativeAgentTimelineItem` gains `kind: "notification"`, whose `payload` replaces `text`: code that
  handles the known kinds and reads `item.text` in a catch-all branch has to handle it (TypeScript
  says where). A patch release, as the 0.3.x core is: the runtime changes nothing for an app that
  does not receive the item, and the item only comes once the box and the Copilot that send it are
  live, after this release (mitra-core-sdk 0.3.3 CHANGELOG).

## 1.8.1

- Depend on `@mitralab.io/sdk-core@0.3.2`: a message still pending when the agent session closes
  is handed to the Copilot by REST with its `mode` instead of being dropped, and `sendAndWait`
  rejects instead of hanging; `providerUsage` readings carry `provider` when the box sends it.

## 1.8.0

Stable release of the 1.8.0-beta line, with `@mitralab.io/sdk-core@0.3.1`.

- Includes the password sign-in of 1.8.0-beta.0 (#171/#172) and 1.8.0-beta.1 (#173/#174), both
  detailed below: `signInWithPassword()`, `signUpWithPassword()`, `changePassword()` and
  `requestPasswordReset()` on the Mitra auth page, `signOut()` ending an exclusive app session on
  the server, `mitra.passwordLoginEnabled`, and the app's own form with
  `signInWithPasswordForm()`, `startPasswordSignUp()`, `completePasswordSignUp()`,
  `changePasswordForm()`, `readPasswordResetToken()` and `confirmPasswordReset()`.
- Depend on `@mitralab.io/sdk-core@0.3.1`. Both additions need the Copilot with
  mitra-copilot#549.
- `agentCredentials.providers(agentId?, options?)`: the providers the next turn can run on, in one
  call to the Copilot's `GET /api/v1/models/providers`, each with `provider`, `providerName`,
  `models` and `usage` (null on an API key, a custom provider, before a turn reported a window and
  when the Copilot could not read it). Export `AgentReadyProvider`.
- `agentTasks.session(...).loadOlder()` reads the page before the oldest row `history` holds and
  puts it before `history`; `hasOlder` says whether the last page read had more. Both come from the
  core session, which the offline gate passes through.

## 1.8.0-beta.1

Password login from the app's own form, for apps whose owner turns that mode on (the Mitra auth
page stays the default and the recommended one).

- `auth.signInWithPasswordForm({ email, password })` posts to `/auth/password/login` with
  `appId` and `origin: location.origin`, redeems the exchange code at `/auth/magic-link/exchange`
  and stores the session like the popup does. No popup is opened.
- `auth.startPasswordSignUp({ email, language })` asks for the code at `/auth/password/signup` and
  returns `{ receipt, resendAfterSeconds }`; `auth.completePasswordSignUp({ receipt, code, password })`
  verifies it at `/auth/password/signup/verify` and signs the person in.
- `auth.changePasswordForm({ currentPassword, newPassword })` sends `PUT /auth/password` with the
  access token of this session (`currentPassword` may be left out only for an account without a
  password). The request goes on a client that does not refresh and retry on `401`, so a wrong
  current password is tried once. IAM ends every session of the account, so the SDK signs in again
  with the address of this session and the new password. When that sign-in fails, the call rejects
  with `PASSWORD_CHANGED_SIGN_IN_AGAIN` and the local session is cleared, unless another session
  replaced it meanwhile.
- `auth.readPasswordResetToken()` returns the `resetToken` of the reset link that lands on
  `/reset-password` and removes the fragment from the URL; `auth.confirmPasswordReset({ token,
  newPassword })` posts it to `/auth/password/reset/confirm`.
- A `403 PASSWORD_FORM_NOT_ENABLED` from IAM in `signInWithPasswordForm()`,
  `completePasswordSignUp()`, `changePasswordForm()` or `confirmPasswordReset()` keeps its status
  and code and gets a message saying to turn on the "form in the app itself" mode in the app or to
  use the Mitra auth page methods. `startPasswordSignUp()` carries no password and IAM takes it in
  either mode.
- Nothing changes in the existing methods: `signInWithPassword()`, `signUpWithPassword()`,
  `changePassword()`, `requestPasswordReset()`, the email code, SSO, `signOut()` and the HTTP
  client send the same requests and fail with the same messages. Only the JSDoc of
  `requestPasswordReset()` changes: where its link opens now depends on the app's mode.
- The JSDoc of each form method opens with the warning that the password goes through the app's
  code, and the README documents both modes. The JSDoc of the deprecated `signIn` and `signUp` also
  points to the form methods; their error stays the same.
- Export `PasswordChange`, `PasswordResetConfirmation`, `PasswordSignUpCompletion`,
  `PasswordSignUpRequest` and `PasswordSignUpRequestResult`.

## 1.8.0-beta.0

Sign-in by email and password for apps whose accounts are their own (exclusive login mode).

- `auth.signInWithPassword()`, `auth.signUpWithPassword()` and `auth.changePassword()` open the
  Mitra auth page (`sdk-auth.html`) in a popup with `provider=password` and `view=login`, `signup`
  or `change`. The password is typed only there and never passes through the app's code. The page
  hands back the same single-use exchange code as the email sign-in, redeemed at
  `/auth/magic-link/exchange`. Popup only: there is no redirect mode for these methods.
- `changePassword()` needs a session. The page asks for it with a `mitra-auth-session-request`
  message, and the SDK answers `mitra-auth-session` with the access token through `postMessage`
  to the auth page origin, never in the URL. IAM ends every session of the account when the
  password changes, so the page signs in again and the new session replaces the current one. When
  the change goes through but that sign-in fails, the call rejects with
  `PASSWORD_CHANGED_SIGN_IN_AGAIN` and the local session is cleared.
- `auth.requestPasswordReset(email, { language })` asks IAM to email a reset link and returns
  `{ resendAfterSeconds }`, neutral about whether the address has an account. The link opens the
  Mitra auth page, where the new password is typed, so there is no `confirmPasswordReset`. Asking
  too often answers `RATE_LIMITED` (per address) or `RATE_LIMIT_EXCEEDED` (per network).
- `auth.signOut()` also ends the session on the server when it belongs to an exclusive app
  account: it sends the refresh token to `POST /auth/logout` with `keepalive`, ignores the answer,
  and clears the local state right away, as before. A shared app session, or one without a
  refresh token, is only cleared locally.
- `mitra.passwordLoginEnabled`, read from the app info by `init()`, `false` when the server omits it.
- `signIn` and `signUp` with a password stay deprecated and now point to the new methods.
- Export `PasswordResetOptions` and `PasswordResetRequestResult`.

## 1.7.0

Stable release of the 1.7.0-beta line, with `@mitralab.io/sdk-core@0.3.0`.

- Depend on `@mitralab.io/sdk-core@0.3.0`, the agent session that follows T3. A message sent while
  a reply runs no longer waits in a local queue of the SDK: it goes to the box at once, with no mode
  by default, and T3 decides, steering it into the running turn or queueing it.
  `send(prompt, { mode: "queue" | "steer" })` asks on purpose. `session.history` is the live
  conversation in the box's order (asked with `kinds=all`), with a tool's call and result as two
  items, as in 0.2.13, the question as the person wrote it, and T3's approvals and mid-turn
  questions where they came. `queue` mirrors T3's queue, with `steerQueueItem`, `resumeQueue` and
  `backgroundTasks`. The history keeps the 0.2.13 format; against an old box the new functions show
  nothing.
- `agentTasks.session(...).send` returns the id of the message the core sends (its
  `clientMessageId`); a prompt held while the browser is offline returns `undefined`.
- Includes `auth.allTokens.backoffice` and `auth.ensureFreshBackofficeToken()` from 1.7.0-beta.0.

## 1.7.0-beta.0

- `auth.allTokens` gains a fourth family, `backoffice`: the access token of the person's own
  backoffice grant (`accessToken`, `tokenType`, `expiresIn`), for an app that reaches the backoffice
  of the Mitra brand with the access they already have there. It is `null` unless IAM enabled the
  app for this token and the person is staff with a backoffice grant, and a malformed part reads as
  `null` without failing the login, as the other families already do.
- It is the only family without a `refreshToken`: the backoffice refresh is accepted only on an
  internal IAM route. IAM mints a new one on every app refresh instead, so on a refresh the field
  follows the `platform` rule and is replaced by what IAM sent, `null` included. A `null` there is
  how a grant the person lost, or an app taken out of the flag, arrives.
- `auth.ensureFreshBackofficeToken()` answers that token, refreshing the app session first when it
  is within 60 seconds of expiring, and `null` when this session has none. The backoffice access
  lives one hour while the app session lives far longer, so reading the field directly would hand
  out a dead token from the second hour on. The refresh is shared with every other caller, and a
  transient failure answers the token in hand instead of dropping it. A login by another person
  landing during the refresh answers `null`, never their token.
- An `allTokens` carrying only `backoffice` is no longer read as empty.
- A session stored by 1.6.0 or earlier carries no `backoffice` key, so it reads as `null` until the
  next app refresh. An app that needs the token right after the upgrade can call
  `auth.refreshSession()` once.
- Export `BackofficeToken`.

## 1.6.0

- Depend on `@mitralab.io/sdk-core@0.2.13`: `AgentTurnUsage` gains `contextTokens`, the tokens
  occupying the chat's context window at the end of the turn (subagents excluded), and
  `contextWindow`, the model's window size. Both show live in `turnEnd` and `sendAndWait` and in
  the `agent` item of the history, and are absent when the box does not report them.

## 1.5.0

Stable release of the 1.5.0-beta line, already on the `beta` tag.

- `auth.allTokens` for apps enabled server-side, as in 1.5.0-beta.0.
- Depend on `@mitralab.io/sdk-core@0.2.12`, the stable release of the 0.2.12-beta.1 surface: a
  `cancel()` pressed before the agent turn starts waits for the box to admit the prompt and goes out
  right after it.

## 1.5.0-beta.1

- Depend on `@mitralab.io/sdk-core@0.2.12-beta.1`: a `cancel()` pressed before the agent turn starts
  waits for the box to admit the prompt and goes out right after it, instead of being dropped while
  the answer kept coming. `cancelled` is only emitted once the stop was delivered, and a stop pressed
  for a prompt the box refuses never goes out, so it cannot stop a later turn.

## 1.5.0-beta.0

- Expose `auth.allTokens` for apps enabled server-side, with the three families IAM returns at
  login: `platform` and `b2bToken` session pairs and the `mitraSpace` token. It is `null` for every
  other app, and a malformed part reads as `null` without failing the login.
- Persist the field with the session. An app refresh replaces `platform` and keeps `mitraSpace` and
  `b2bToken` from login, and a refresh without the field clears it; a new login, `setSession`,
  `setToken` or a legacy login resets it, the legacy SDK's silent refresh keeps it, and `signOut()`
  clears it.
- Export `AllTokens`, `PlatformSessionTokens` and `MitraSpaceToken`, with `readonly` fields; the
  instances the SDK returns are frozen.
- Keep the field on the legacy SDK's silent refresh only when the renewed token has the same `sub`
  as the current one; a late refresh for another person, or a token without a readable `sub`,
  resets it.

## 1.4.1

Stable release of the 1.4.1-beta.0 line, already on the `beta` tag. It pins
`@mitralab.io/sdk-core` to `0.2.11`, the stable release of the `0.2.11-beta.0` surface this line
already followed. No code change since 1.4.1-beta.0; the entry below describes what moves from
1.4.0.

## 1.4.1-beta.0

- Depend on `@mitralab.io/sdk-core@0.2.11-beta.0`: the Agent message that closed a turn carries
  `usage` (`AgentTurnUsage`) from the Copilot history, `loadHistory` keeps it on that `agent` item,
  and `turnEnd` and `sendAndWait` carry the turn's `usage` from `stepFinish`.
- Export `AgentTurnUsage` and `AgentTurnUsageRequest`.

## 1.4.0

Stable release of the 1.4.0-beta.0 line, already on the `beta` tag. It pins
`@mitralab.io/sdk-core` to `0.2.10`, the stable release of the `0.2.10-beta.0` surface this line
already followed. No code change since 1.4.0-beta.0; the entry below describes what moves from
1.3.0.

## 1.4.0-beta.0

- `agentCredentials.usage("ANTHROPIC" | "OPENAI", { scope })` reads the last subscription reading
  a chat on that credential reported, with no chat open: `{ harness, observedAt, status, windows:
  [{ kind, usedPercent, resetsAt, windowSeconds }] }`, or `null` while none has. The session emits
  the same reading as `providerUsage` during a turn on the box.
- Depend on `@mitralab.io/sdk-core@0.2.10-beta.0` and export `CredentialUsage`,
  `CredentialUsageWindow` and `AgentProviderUsage`.

## 1.3.0

Stable release of the 1.3.0-beta.0 line, already on the `beta` tag. It pins
`@mitralab.io/sdk-core` to `0.2.9`, the stable release of the `0.2.9-beta.1` surface this line
already followed. No code change since 1.3.0-beta.0; the entry below describes what moves from
1.2.0.

## 1.3.0-beta.0

- The direct channel to the chat's box now comes from `@mitralab.io/sdk-core@0.2.9-beta.1`. This
  package passes it the API URL and keeps only the Copilot WebSocket and SSE streams a chat falls
  back to, and the offline outbox for what is sent over REST. The browser behavior is the same:
  same host rule, redial with replay, `channelDeclined`, `channelReconnecting` and
  `channelConnected` events, and message and interrupt on the box.
- Only a business agent's chat (one with an `agentId`) is born on the box (`runtime: "T3"`) and
  asks for the channel. Any other chat is created without `runtime` and stays on the Copilot
  stream, since the Copilot refuses T3 outside an agent chat.
- `transport: "http"` changes meaning: it now reaches the box over its HTTP routes (POST to send,
  SSE to read) instead of the Copilot SSE, which becomes its fallback, and an agent chat created
  with it is also born on the box. This is why the minor version moves.
- A message sent on the box counts as sent only when the box starts the admitted turn; the session
  emits `accepted` then. A box that confirms nothing within 35 seconds fails the send, and a box
  refusal rejects with the box's `error_code` and message.
- `channelDeclined` is emitted for every fallback, with the reasons `unavailable`, `body`, `host`,
  `websocket` and `http_unsupported`.
- The channel request is not reported to the client's global `onError`, and
  `agentTasks.channel(taskId)` is not part of the public surface: its answer carries the box grant.
- `inputUnsent`, `inputSent` and the `INPUT_UNSENT` error reach the session's `raw` and `error`
  listeners on a chat served by the box too, and a listener that throws no longer stops the outbox
  nor the session's `close()`.

## 1.2.0

Stable release of the 1.1.4-beta.0 to 1.2.0-beta.6 line. Everything below is already on the
`beta` tag; this entry consolidates it for the person moving from 1.1.3.

- On the direct channel the message and the interrupt go over the box socket, as the client
  frames the box already reads, instead of `POST /copilot/api/v1/tasks/{id}/inputs`. REST stays
  for a chat with no box socket, for a socket not open at the moment of the send, and for every
  approval answer. The channel the Copilot offers is followed when its `wss:` address is on the
  API host or on a fleet box host (`<port>-<box>.e2b.app` or
  `<port>-<box>.e2b-<fleet>.mitralab.ai`), and a refused offer emits a `raw` event of type
  `channelDeclined` before the chat follows the Copilot socket.
- The eight `agentCredentials` methods take a trailing `{ scope: "ACCOUNT" }`, and
  `session({ create: true })` and `agentTasks.create()` accept `scope: "ACCOUNT"` in the create
  body, so the credential and the chat resolve against the person's own account instead of the
  app. Without `scope` nothing changes on the wire.
- `agentCredentials` exposes the person's custom providers: `listCustomProviders(options?)`,
  `createCustomProvider(input, options?)` and `deleteCustomProvider(id, options?)`, passthroughs
  to `/api/v1/credentials/custom-providers`. `NativeAgentModel` carries `providerName`, null on
  built-in models. A custom provider is chosen by sending the `agentType` that the
  `agentCredentials.listModels()` row returns: there is no `model` field on chat creation or on
  the message send. A chat created over the `auto` or `websocket` transport keeps being born on
  the T3 box with `runtime: "T3"`, as in 1.1.3.
- Sign-in by email: `signInWithEmail()` through the platform auth page, and
  `requestEmailCode({ email, language? })` with `verifyEmailCode({ receipt, code })` for an
  application that renders its own address and code fields. Both are completed by
  `completeEmailSignInRedirect()` at startup, the link in the message lands on the application's
  own origin as `#emailToken=<token>`, and `mitra.emailLoginEnabled` says whether the app is inside
  the platform's rollout. `MitraApiError.retryAfterSeconds` reads `Retry-After` on a `429`.
- Depend on `@mitralab.io/sdk-core@0.2.8`, the stable release of the 0.2.8-beta.0 surface this
  package already followed.

## 1.2.0-beta.6

- Follow the box channel the Copilot offers when its `wss:` address is on a fleet box host
  (`<port>-<box>.e2b.app` or `<port>-<box>.e2b-<fleet>.mitralab.ai`, the allowlist the gateway
  trusts on `/__ide`), and not only when it is on the API host. The same-host rule assumed the
  proxy mode; alpha runs the sandbox in direct mode, so every chat there was silently falling back
  to the Copilot socket and none reached the T3 box.
- Say when an offer is refused: a 200 whose channel the SDK will not follow, because of its host
  or an unreadable body, emits a `raw` event of type `channelDeclined` (payload
  `reason: "host" | "body"`, `host`) before the chat follows the Copilot socket. A refusal by
  status and a request the network lost stay silent, as before.

## 1.2.0-beta.5

- Drop the `model` field 1.2.0-beta.3 accepted on `session({ create: true })`, `agentTasks.create()`
  and `session.send()` (with `sendAndWait()` and the queued sends). A chat is created and a message
  is sent with `agentType` and `reasoningEffort` only, as before 1.2.0-beta.3: nothing else is
  documented or tested in the create body, in the message frame on the box socket or in the
  `POST /inputs` body. A custom provider is chosen by sending the `agentType` that the
  `agentCredentials.listModels()` row returns. The optional `model` also leaves the option types
  this package re-exports from Core: the pin moves to `@mitralab.io/sdk-core@0.2.8-beta.0`, which
  drops it from task creation and the message send; the person's custom providers from
  1.2.0-beta.4 (`listCustomProviders`, `createCustomProvider`, `deleteCustomProvider`) are
  unchanged.

## 1.2.0-beta.4

- `agentCredentials` exposes the person's custom providers: `listCustomProviders(options?)`,
  `createCustomProvider(input, options?)` and `deleteCustomProvider(id, options?)`, plain
  passthroughs to `/api/v1/credentials/custom-providers` with the same trailing `{ scope: "ACCOUNT" }`
  the other credential calls take. The Copilot requires `scope: "ACCOUNT"` on an app token. No
  provider guard applies and the provider unions are unchanged. `AgentConnectionCustomProvider`
  and `AgentConnectionCustomProviderInput` are re-exported from the package index.
- Depend on `@mitralab.io/sdk-core@0.2.7-beta.0`, which adds the three methods to the credential
  module.

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
