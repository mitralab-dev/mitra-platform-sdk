# Mitra Platform SDK

[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=mitra-platform-sdk&metric=alert_status&token=28d7be14b66d6f88d706347e2418af5ea39ab3e9)](https://sonarcloud.io/summary/new_code?id=mitra-platform-sdk)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=mitra-platform-sdk&metric=coverage&token=28d7be14b66d6f88d706347e2418af5ea39ab3e9)](https://sonarcloud.io/summary/new_code?id=mitra-platform-sdk)

SDK JavaScript e TypeScript para apps de browser feitos na Mitra: login da pessoa, dados do app, Server Functions, queries, integrações e chats de agente. Para código que roda dentro de uma Server Function, use [`@mitralab.io/functions-sdk`](https://www.npmjs.com/package/@mitralab.io/functions-sdk).

## Instalação

```bash
npm install @mitralab.io/platform-sdk
```

Roda no browser, com as APIs dele (`fetch`, `WebSocket`, `localStorage`). Para desenvolver, Node 18 ou mais novo. Publicado em ESM e CommonJS, com tipos.

## Início rápido

```typescript
import { createClient } from "@mitralab.io/platform-sdk"

export const mitra = createClient({
  appId: import.meta.env.VITE_MITRA_APP_ID,
  apiUrl: import.meta.env.VITE_MITRA_API_URL,
})

await mitra.init()

if (!mitra.auth.isAuthenticated) {
  await mitra.auth.signInWithGoogle({ mode: "popup" })
}

const { data: tasks } = await mitra.entities.Task.list({ sort: "-created_at", limit: 10 })
```

No app gerado pelo Code Studio, `VITE_MITRA_APP_ID` e `VITE_MITRA_API_URL` já vêm preenchidos no build.

## O que dá para fazer

- `auth`: login com Google (`signInWithGoogle`), Microsoft (`signInWithMicrosoft`) ou código por e-mail, mais `currentUser`, `onAuthStateChange` e `signOut`.
- `entities.<Tabela>`: `list`, `filter`, `get`, `create`, `bulkCreate`, `update`, `delete` e `deleteMany` nas tabelas do app.
- `queries.execute(id, params)`: roda uma query salva no app.
- `functions`: `execute` espera o resultado da Server Function; `executeAsync` devolve a execução para acompanhar com `getExecution` ou parar com `cancelExecution`. `publicFunctions` chama as Functions publicadas como públicas, sem login.
- `integration.executeByAlias(alias, request)`: chama uma API externa configurada no app. A credencial do provedor fica na Mitra e não passa pelo browser.
- `agentTasks.session(...)`: chat com agente, com `send`, `sendAndWait`, `cancel` e eventos como `delta`, `turnEnd` e `error`.
- `agentCredentials`: credenciais de provedor de IA e modelos disponíveis.

Login por código no e-mail, para quem monta a própria tela:

```typescript
const { receipt } = await mitra.auth.requestEmailCode({ email })
const user = await mitra.auth.verifyEmailCode({ receipt, code })
```

Chat com agente:

```typescript
const chat = mitra.agentTasks.session({ taskId })
chat.on("delta", ({ delta, kind }) => {
  if (kind === "text") render(delta)
})
const { content } = await chat.sendAndWait("Resuma os pedidos de hoje")
chat.close()
```

## Configuração

| Campo | Obrigatório | Uso |
|---|---|---|
| `appId` | sim | ID do app no Code Studio |
| `apiUrl` | sim | URL do API gateway da Mitra |
| `onError` | não | callback com o `MitraApiError` das falhas de `entities`, `queries`, `functions`, `integration`, `agentTasks` e `agentCredentials`; `init()`, login, `publicFunctions` e falha de rede não passam por ele e são tratados no `catch` de cada chamada |
| `authPageUrl` | não | URL da página de login da Mitra; sem ela, o SDK descobre sozinho |
| `apiKey` | não | chave padrão de `auth.signInWithApiKey()`; só em código de servidor, nunca no bundle do browser |

## Erros

Falhas de API lançam `MitraApiError`, com `status`, `code`, `details` e `retryAfterSeconds`. O SDK mascara o token da sessão, credenciais `Bearer` e campos com nome sensível, como `password` ou `apiKey`, em `details`. Texto livre fora disso, como `password=...` dentro de uma mensagem, passa como veio: não trate mensagem e detalhes como saneados antes de mandar para log.

| `status` ou `code` | Quando | O que fazer |
|---|---|---|
| `401` | a sessão acabou e não deu para renovar | leve a pessoa ao login de novo |
| `403` | a pessoa não tem acesso ao recurso | confira as permissões dela no app |
| `429`, `5xx` | limite de requisições ou falha no servidor | espere `retryAfterSeconds`, quando vier, e repita se a operação puder ser repetida |
| `INVALID_CONFIGURATION` | argumento inválido, ou `requestEmailCode()` antes de `init()` | corrija o argumento ou chame `init()` no startup |
| `UNSUPPORTED_AUTH_METHOD` | `signIn` ou `signUp` com senha | use Google, Microsoft ou código por e-mail |
| `INVALID_CODE` | o código digitado não confere | peça para a pessoa conferir o código |
| `MAGIC_LINK_EXPIRED`, `MAGIC_LINK_USED`, `MAGIC_LINK_INVALID` | o link do e-mail venceu, já foi usado ou não vale | peça um código novo |
| `REDIRECT_NOT_ALLOWED` | o servidor respondeu com redirect | confira o `apiUrl` |
| `INVALID_RESPONSE` | resposta fora do formato esperado | atualize o SDK; se continuar, abra uma issue |

Falha de rede chega como o erro do próprio `fetch` (`TypeError`), sem passar por `onError`.

## Boas práticas

- Chame `await mitra.init()` no startup, antes de montar a tela de login: `allowSignup`, `emailLoginEnabled` e o login por e-mail dependem dele.
- Com `mode: "redirect"`, chame no startup o `completeGoogleSignInRedirect()`, `completeMicrosoftSignInRedirect()` ou `completeEmailSignInRedirect()` do método que você usa. Cada um devolve `null` quando a URL não é dele. O link do e-mail completa o login no mesmo browser que pediu o código; em outro aparelho, a pessoa digita o código.
- A sessão fica no `localStorage` do domínio do app, na chave `mitra_auth_{appId}`, e é renovada sozinha antes de vencer. `signOut()` limpa.
- O SDK só repete uma requisição depois de renovar o token num `401`. Fora isso, quem decide repetir é o app.
- Nunca coloque API key em código que vai para o browser, nem passe uma em `createClient({ apiKey })` num app de browser: o bundle entrega a chave a quem abrir o app. O `signInWithApiKey()` recusa rodar no browser, mas isso não tira do bundle uma chave escrita nele. Para processo sem pessoa, como cron ou coletor, use `@mitralab.io/functions-sdk` com `createClientFromApiKey`.

## Migração do `mitra-interactions-sdk`

Os exports do SDK legado continuam neste pacote, marcados `@deprecated`, e dividem a sessão com o cliente novo. Troque a dependência, crie o cliente com `createClient` e substitua as chamadas aos poucos: o aviso de cada export diz o método novo. Não chame `configureSdkMitra` direto, porque o `createClient` já configura o legado.

## Desenvolvimento

```bash
npm ci
npm run check
```

O `check` roda lint, typecheck, testes, build e um smoke test do pacote. A publicação no npm sai do workflow Release.
