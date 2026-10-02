# Mitra Platform SDK

[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=mitra-platform-sdk&metric=alert_status&token=28d7be14b66d6f88d706347e2418af5ea39ab3e9)](https://sonarcloud.io/summary/new_code?id=mitra-platform-sdk)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=mitra-platform-sdk&metric=coverage&token=28d7be14b66d6f88d706347e2418af5ea39ab3e9)](https://sonarcloud.io/summary/new_code?id=mitra-platform-sdk)

SDK JavaScript e TypeScript para apps de browser feitos na Mitra: login e sessão da pessoa, entidades do Data Manager, Server Functions, custom queries, integrações e chats de agente. Os módulos de API e os contratos vêm de `@mitralab.io/sdk-core`; este pacote cuida do que é de browser (login, sessão, transporte HTTP, streams do Copilot). Código que roda dentro de Server Function usa `@mitralab.io/functions-sdk`.

## Instalação

```bash
npm install @mitralab.io/platform-sdk
```

Node 18 ou mais novo para desenvolvimento. No runtime, usa as Web APIs do browser (`fetch`, `WebSocket`, `localStorage`, `sessionStorage`, `crypto`, `atob`). Traz `@mitralab.io/sdk-core` com versão exata e `mitra-interactions-sdk` (o SDK legado) como dependências.

## Configuração

| Campo | Obrigatório | Uso |
|---|---|---|
| `appId` | sim | ID do app publicado no Code Studio, enviado em `X-App-Id` em toda chamada autenticada |
| `apiUrl` | sim | URL base do API gateway; os serviços saem dela: `/iam`, `/data-manager`, `/functions`, `/integration`, `/copilot`, `/code-studio` e `/legacy` |
| `authPageUrl` | não | URL absoluta do `sdk-auth.html`; sem ela, vale `window.__mitraEnv.authPageUrl` e depois `/sdk-auth.html` na origem do `apiUrl` |
| `apiKey` | não | chave padrão de `auth.signInWithApiKey()`; só em código de servidor |
| `onError` | não | callback com o `MitraApiError` de toda requisição que falha |

No app gerado pelo Code Studio, os valores vêm de `VITE_MITRA_APP_ID` e `VITE_MITRA_API_URL`, injetados no build.

## Uso

```typescript
import { createClient, MitraApiError } from "@mitralab.io/platform-sdk"

export const mitra = createClient({
  appId: import.meta.env.VITE_MITRA_APP_ID,
  apiUrl: import.meta.env.VITE_MITRA_API_URL,
  onError: (error: MitraApiError) => console.error(error.status, error.code, error.message),
})

await mitra.init()
const user = await mitra.auth.signInWithGoogle({ mode: "popup" })

const { data: tasks } = await mitra.entities.Task.list({ sort: "-created_at", limit: 10 })
const execution = await mitra.functions.execute("function-id", { orderId: "order-123" })
const result = await mitra.queries.execute("query-id", { status: "active" })
const proxied = await mitra.integration.executeByAlias("billing", { method: "GET", endpoint: "/invoices" })
```

Login de pessoa é por Google, Microsoft (`signInWithMicrosoft`) ou e-mail (`requestEmailCode` e `verifyEmailCode`, ou `signInWithEmail` pela página da plataforma). Os antigos `signIn` e `signUp` falham com `UNSUPPORTED_AUTH_METHOD`, porque o IAM não tem login por senha. Processo sem pessoa (cron, coletor) usa `signInWithApiKey()` com uma chave criada em Configurações, API keys. Quem usa redirect chama o `complete...SignInRedirect()` de cada método no startup; cada um devolve `null` para fragmento que não é dele. Chats de agente usam `mitra.agentTasks.session(...)`, cuja máquina de estados e canal direto com a box são do Core.

## Contratos e armadilhas

- Chame `init()` no startup. Ele lê `/code-studio/api/v1/apps/{appId}/info`: sem ele, `emailLoginEnabled` fica `false`, `allowSignup` fica `true` e `requestEmailCode()` falha com `INVALID_CONFIGURATION`, porque a marca do e-mail vem dali. Entidades e queries não dependem do `init()`: o app sai do JWT (JSON Web Token).
- A sessão fica no `localStorage` sob `mitra_auth_{appId}`, junto com `auth.allTokens` (sessões do IAM em outro escopo e o token do mitraSpace, que dura décadas) quando o IAM manda. Qualquer script da mesma origem lê esses tokens. Token decodificável com `app_id` diferente do `appId` configurado é recusado.
- Antes de cada chamada autenticada, o SDK renova o token que vence em menos de 30 segundos. Em `401`, renova uma vez e repete a requisição. Falha de rede, `408`, `429` e `5xx` no refresh mantêm a sessão; outro `4xx` limpa.
- `signInWithApiKey()` recusa rodar quando existe `window`: no browser, a chave iria no bundle para todo visitante. A sessão por API key não é gravada e não tem refresh.
- O link do e-mail só completa no mesmo browser que pediu o código: o pedido pendente fica 10 minutos em `localStorage` sob `mitra_email_redirect_{appId}`. Em outro dispositivo, `completeEmailSignInRedirect()` devolve `null` e a pessoa digita o código.
- `functions.execute` manda `X-Invocation-Type: sync`, e chamada sem input vai sem corpo. `publicFunctions` usa um transporte anônimo, sem `Authorization` nem `X-App-Id`, e o `executeAsync` público não tem polling. Credencial de provedor de integração nunca passa pelo browser: o serviço de Integration injeta.

## SDK legado

Este pacote reexporta, como `@deprecated`, a superfície pública do `mitra-interactions-sdk`, para um app trocar a dependência sem reescrever as chamadas. O `createClient` configura o SDK legado em `${apiUrl}/legacy` e compartilha a sessão nos dois sentidos. Só `loginMitra('mitra')` ainda não tem equivalente nativo. Chamar `configureSdkMitra` direto substitui essa configuração; deixe o `createClient` como dono dela durante a migração.

## Erros

Falhas de API lançam `MitraApiError`, com `status`, `code`, `details` e `retryAfterSeconds` (lido de `Retry-After`; `null` quando o header não chega ao browser).

| `status` e `code` | Quando |
|---|---|
| status da resposta, `error_code` do corpo | resposta HTTP de erro |
| status da resposta, `REDIRECT_NOT_ALLOWED` | o servidor respondeu com redirect, que o transporte recusa |
| `0`, `INVALID_CONFIGURATION` | entrada inválida, como path vazio, ou `requestEmailCode()` antes do `init()` |
| `200`, `INVALID_RESPONSE` | resposta de sucesso fora do contrato |

O SDK remove o token da requisição, credenciais `Bearer` e campos como `accessToken`, `refreshToken`, `apiKey` e `password` da mensagem e dos detalhes do erro. Falha de rede chega como o erro original do `fetch`, sem passar por `onError`.

## Desenvolvimento

```bash
npm install
npm run check
```

O `@mitralab.io/sdk-core` fica fixado com integridade no `package-lock.json`. Para validar contra um Core ainda não publicado, aponte `MITRA_SDK_CORE_TARBALL` para o tarball dele no smoke test. Não commite dependência `file:`.
