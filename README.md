# Mitra Platform SDK

[![Quality Gate Status](https://sonar.mitralab.ai/api/project_badges/measure?project=mitra-platform-sdk&metric=alert_status&token=sqb_203da0d84eec5dab002ebc06d34d6ff798847314)](https://sonar.mitralab.ai/dashboard?id=mitra-platform-sdk)
[![Coverage](https://sonar.mitralab.ai/api/project_badges/measure?project=mitra-platform-sdk&metric=coverage&token=sqb_203da0d84eec5dab002ebc06d34d6ff798847314)](https://sonar.mitralab.ai/dashboard?id=mitra-platform-sdk)

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

- `auth`: login com Google (`signInWithGoogle`), Microsoft (`signInWithMicrosoft`), código por e-mail ou e-mail e senha (`signInWithPassword` no popup da Mitra, ou `signInWithPasswordForm` no formulário do próprio app), mais `currentUser`, `onAuthStateChange` e `signOut`.
- `entities.<Tabela>`: `list`, `filter`, `get`, `create`, `bulkCreate`, `update`, `delete` e `deleteMany` nas tabelas do app.
- `files.upload(file, { authorize, onProgress?, signal? })` e `files.download(fileId, { authorize, signal? })`: arquivos privados, com autorização de negócio numa Server Function do app.
- `queries.execute(id, params)`: roda uma query salva no app.
- `functions`: `execute` espera o resultado da Server Function; `executeAsync` devolve a execução para acompanhar com `getExecution` ou parar com `cancelExecution`. `publicFunctions` chama as Functions publicadas como públicas, sem login.
- `integration.executeByAlias(alias, request)`: chama uma API externa configurada no app. A credencial do provedor fica na Mitra e não passa pelo browser.
- `agentTasks.session(...)`: chat com agente, com `send`, `sendAndWait`, `cancel` e eventos como `delta`, `turnEnd` e `error`.
  `send` devolve o id da mensagem; com o browser offline a mensagem espera a rede e `send` devolve `undefined`.
  `loadOlder()` traz a página anterior do histórico e põe antes de `history`; `hasOlder` diz se ainda há mais antiga.
- `agentCredentials`: credenciais de provedor de IA e modelos disponíveis. `providers(agentId?)` devolve numa chamada só os provedores em que o próximo turno pode rodar, cada um com os modelos e a última leitura da assinatura.
- `aiProviders.get()`: consulta tipada de `GET /copilot/api/v1/ai-providers`, com o token da sessão e o `X-App-Id` do cliente. Retorna engine ativa, quota pessoal, provedores personalizados, conexão OpenCode e `managedAiProfile`. O módulo oferece somente leitura: não altera preferências, cria tarefas ou conecta provedores.

`managedAiProfile` é `null` quando inelegível e pode estar ausente em backends anteriores. Quando o Copilot oferece Immersion, o perfil traz `profile: "IMMERSION"`, `agentType: "IMMERSION"`, `selectionMode: "FORCED"`, `model: "immersion"` e `requiredScope: "ACCOUNT"`. A leitura preserva a engine ativa e a quota pessoal; não calcula elegibilidade com base nelas. Falhas, inclusive `404` de backend sem a rota, chegam como `MitraApiError`.

Os tipos `AiProviders`, `AiProvidersModule`, `ManagedAiProfile`, `IncludedAiQuota`, `IncludedAiQuotaWindow` e `OpencodeAiProvider` são exportados pelo pacote.

Login por código no e-mail, para quem monta a própria tela:

```typescript
const { receipt } = await mitra.auth.requestEmailCode({ email })
const user = await mitra.auth.verifyEmailCode({ receipt, code })
```

### Login por e-mail e senha

Só em app com contas próprias (modo exclusivo) e quando `mitra.passwordLoginEnabled` for `true`. O dono do app escolhe um de dois modos, app a app.

**Tela da Mitra (recomendado).** A senha é digitada no popup da Mitra e não passa pelo código do app. Chame direto do clique, antes de qualquer `await`, para o browser não bloquear o popup:

```typescript
const user = await mitra.auth.signInWithPassword()   // ou signUpWithPassword()
await mitra.auth.changePassword()                     // com a pessoa logada
const { resendAfterSeconds } = await mitra.auth.requestPasswordReset(email)  // o link do e-mail abre a página da Mitra
```

**Formulário no próprio app.** O app desenha a própria tela e o SDK chama o IAM direto, sem popup. Só funciona com esse modo ligado no app: desligado, o IAM recusa com `PASSWORD_FORM_NOT_ENABLED` o login, a confirmação do cadastro, a troca e a confirmação do reset. O pedido do código de cadastro e o pedido do link de reset não levam senha e passam nos dois modos.

> A senha passa pelo código do app. Não guarde, não registre em log e não envie a senha a nenhum outro lugar além do método do SDK. O padrão mais seguro é `signInWithPassword()`, que usa a tela da Mitra.

```typescript
// login
const user = await mitra.auth.signInWithPasswordForm({ email, password })

// cadastro em dois passos: o código vai por e-mail, a senha vai junto do código
const { receipt } = await mitra.auth.startPasswordSignUp({ email })
const newUser = await mitra.auth.completePasswordSignUp({ receipt, code, password })

// troca, com a pessoa logada; o SDK entra de novo com a senha nova
await mitra.auth.changePasswordForm({ currentPassword, newPassword })
```

No reset, o link do e-mail abre `/reset-password` na origem do app, com o token no fragmento da URL. Crie essa rota no app, leia o token e confirme:

```typescript
await mitra.auth.requestPasswordReset(email)

// na rota /reset-password
const token = mitra.auth.readPasswordResetToken()   // tira o token da URL
if (token) await mitra.auth.confirmPasswordReset({ token, newPassword })
```

A troca e o reset encerram todas as sessões da conta. Depois do reset, a pessoa entra de novo com a senha nova.

### Login por conexão de identidade (Sankhya Pass)

Para app aberto dentro do iframe de outro sistema, como o SKW da Sankhya. O sistema hospedeiro abre a página de ponte da Mitra (`sankhya-auth.html`), que faz o login no IAM com o token dele e manda o iframe para a origem do app com um código de uso único no fragmento (`#codeMitra=...&stateMitra=connection.*&connectionMitra=sankhya-pass`). Nenhum token passa pela URL ou por `postMessage`.

O `await mitra.init()` troca esse código pela sessão sozinho, então o app abre logado sem código novo. Se a troca falhar, o `init()` rejeita; o fragmento já saiu da URL, e um reload não repete o erro. Fora desse fluxo, o `init()` não faz requisição a mais. Quem não chama `init()` usa `completeIdentityConnectionSignInRedirect()` no startup, que devolve `null` quando a URL não é dele.

O código só é aceito dentro de iframe e sob um sistema hospedeiro permitido: o SDK lê `location.ancestorOrigins` e confere toda a cadeia de páginas que embute o app contra os `allowedOrigins` da conexão (`GET /api/v1/auth/identity-connections/{slug}`). Aba de topo, qualquer origem da cadeia fora da lista ou browser que não expõe `ancestorOrigins` recusam o código sem trocá-lo. O requisito é a API, não a família do browser: Chromium e WebKit a expõem há anos, e o Firefox a partir da versão 148.

A sessão desse login fica no `sessionStorage`, na mesma chave `mitra_auth_{appId}`, e dura só enquanto a aba existe. É assim porque o sistema hospedeiro abre o app com a conta de cada base, e duas bases demo da Sankhya abertas no mesmo browser, dividindo o `localStorage`, trocavam a sessão e o alias uma da outra no reload, como já acontecia no legado.

- No startup, a sessão da aba vale antes da sessão compartilhada do `localStorage`. A sessão compartilhada não é apagada: ela é das outras abas do app, logadas do jeito normal. Se a aba não tem sessão própria, ela usa a compartilhada.
- `signOut()` numa aba assim encerra só a sessão da aba.
- Um login por outro método ou `setSession()` na mesma aba volta a gravar no `localStorage` e apaga a cópia da aba. Depois de `setToken()` o destino é sempre o `localStorage`, e a cópia da aba é apagada mesmo com `setToken(token, false)`.
- Se o login pela conexão for recusado, o `init()` rejeita e a sessão que o app tinha restaurado no startup deixa de valer naquela página, para o iframe não seguir logado com outra pessoa. Ela continua guardada onde estava: no `localStorage`, ou no `sessionStorage` se era uma sessão por aba.
- Os exports legados do `mitra-interactions-sdk` recebem dessa sessão só o access token. O refresh token não vai para eles, porque o SDK legado grava o refresh token no `localStorage` (`mitra-session`), onde ele sobreviveria à aba. Por isso, numa sessão por aba, os exports legados não renovam sozinhos, e o SDK novo também não renova em segundo plano: ele renova antes de uma requisição dele mesmo, em `ensureFreshSession()` ou em `refreshSession()`. Um app que só usa os exports legados recebe `401` quando o access token vence, a menos que faça uma chamada pelo SDK novo ou chame `refreshSession()`; o token renovado chega ao legado na hora.

#### Modo redirect, fora do iframe

Para um botão "Entrar com Sankhya Pass" num app aberto direto no browser, sem sistema hospedeiro. O SDK manda a página para o provedor de identidade da conexão (o Keycloak do Sankhya Pass), com Authorization Code e PKCE (Proof Key for Code Exchange, a prova que amarra o código a quem pediu), e o provedor devolve a pessoa ao app com um código na query.

```typescript
await mitra.auth.signInWithIdentityConnection("sankhya-pass", { mode: "redirect" })
```

- No retorno, o `await mitra.init()` completa o login sozinho. Quem não chama `init()` usa `completeIdentityConnectionRedirect()` no startup, que devolve `null` quando a query não é dele. Se o login falhar, o `init()` rejeita; a query já saiu da URL, e um reload não repete o erro.
- O app volta para a origem e o caminho atuais, sem query e sem fragmento, ou para o `redirectUri` passado nas opções, que precisa ser http ou https, estar na origem do app e não ter query nem fragmento (o SDK recusa antes de sair da página).
- O client público da conexão no provedor precisa de duas liberações para a origem do app: o redirect URI, para o provedor devolver a pessoa, e a origem em Web Origins (CORS, a regra que deixa o browser ler a resposta de outro domínio), porque o SDK troca o código no token endpoint direto do browser. Sem a segunda, essa troca falha com `TypeError` de rede. Peça à Mitra para liberar as duas.
- O pedido pendente (`state` e `code_verifier`) fica no `sessionStorage` da aba e vale uma vez. Retorno sem pedido pendente na aba, ou com `state` diferente, é recusado sem requisição. Sem pedido pendente, como num link forjado, a sessão que a página já tinha continua valendo.
- A troca no token endpoint espera até 15 segundos; passado isso, o login rejeita.
- O token do provedor serve só para o IAM validar quem é a pessoa e é descartado em seguida. O `id_token` e o `refresh_token` do provedor não são guardados.
- A sessão fica no `sessionStorage`, como no login pelo iframe, com as mesmas regras de sessão por aba descritas acima.
- Como não há iframe, não há requisito de `ancestorOrigins`: funciona em Chromium, WebKit e Firefox.

Chat com agente:

```typescript
const chat = mitra.agentTasks.session({ taskId })
chat.on("delta", ({ delta, kind }) => {
  if (kind === "text") render(delta)
})
const { content } = await chat.sendAndWait("Resuma os pedidos de hoje")
chat.close()
```

## Arquivos privados

O app autoriza cada operação numa Function privada JavaScript/Python, cuja execução recebe automaticamente a credencial quando tem ator autenticado elegível e não vem de chamada pública, agenda ou workflow. Não há habilitação individual. O SDK encapsula checksum, resgate autenticado, multipart e conclusão. O módulo de backend está no [`functions-sdk`](https://www.npmjs.com/package/@mitralab.io/functions-sdk); não injete a credencial de arquivos no browser.

```typescript
import type { FileUpload, FileGrant } from '@mitralab.io/platform-sdk';

const controller = new AbortController();
const idempotencyKey = crypto.randomUUID();
const staged = await mitra.files.upload(selectedFile, {
  signal: controller.signal,
  onProgress: ({ loaded, total }) => renderProgress(loaded / total),
  authorize: async (metadata) => {
    const execution = await mitra.functions.execute(uploadFunctionId, {
      conversationId, metadata, idempotencyKey,
    });
    if (execution.status !== 'COMPLETED') throw new Error('Upload authorization failed');
    return execution.output as unknown as FileUpload;
  },
});

// The app backend accepts the message, stores its fileId link and calls files.commit.
const saved = await mitra.functions.execute(saveMessageFunctionId, {
  conversationId, fileId: staged.fileId,
});
if (saved.status !== 'COMPLETED') throw new Error('Message is still pending');

const downloaded = await mitra.files.download(staged.fileId, {
  signal: controller.signal,
  authorize: async (fileId) => {
    const execution = await mitra.functions.execute(readFunctionId, {
      conversationId, fileId, idempotencyKey: crypto.randomUUID(),
    });
    if (execution.status !== 'COMPLETED') throw new Error('Read authorization failed');
    return execution.output as unknown as FileGrant;
  },
});
const objectUrl = URL.createObjectURL(downloaded.blob);
const link = document.createElement('a');
link.href = objectUrl;
link.download = downloaded.file.name;
link.textContent = 'Save file';
document.body.append(link);
// Revoke the object URL when the link or preview is removed.
```

As Functions e variáveis do exemplo pertencem ao seu app. A de upload recebe `metadata`, aplica a política e chama `mitra.files.createUpload(metadata, { idempotencyKey })` no Functions SDK. A de leitura valida o vínculo do `fileId` com a conversa e a permissão do ator autenticado antes de `createReadGrant`. Nunca confie em `userId` enviado pelo browser. O resultado `execution.output` passa por validação de contrato no helper, além da tipagem do exemplo.

- Upload aceita `File` de 1 byte a 25 MiB. Calcula SHA-256 em base64 por `Blob.slice` de 5 MiB antes de chamar `authorize` uma vez. Usa 1 a 5 partes, duas em paralelo por upload, com até três tentativas por parte e espera crescente. O mesmo manifesto e os mesmos bytes são usados nas repetições. Para lotes, limite também quantos `upload()` seu app inicia ao mesmo tempo.
- `onProgress` informa bytes de partes concluídas com sucesso, sem contar retries duas vezes. Não é estimativa de bytes em trânsito: um arquivo pequeno atualiza ao terminar sua única parte. Progresso de 100% ainda precede a validação final na API.
- Upload retorna `FileMetadata` em `STAGED`. Uma repetição da autorização ou do resgate com a mesma chave pode devolver `STAGED`: o SDK confere identidade, tamanho e checksum e retorna sem reenviar bytes, enquanto a concessão ainda estiver válida. Se já estiver `READY`, retorna `FILE_ALREADY_COMMITTED`; reconcilie o vínculo existente em vez de criar outro upload. Somente o backend pode fazer `commit`, depois de aceitar o vínculo. Não há transação distribuída entre mensagem e arquivo: mantenha vínculo pendente, repita `commit` e reconcilie com `get` se a resposta se perder. `pendingExpiresAt` limita a retenção sem commit.
- `controller.abort()` cancela requests em andamento e a espera daquela chamada pela renovação da sessão, sem interromper a renovação compartilhada. Antes de enviar `complete`, um cancelamento explícito também tenta descartar o upload por até cinco segundos com sinal independente. Conflitos concorrentes, arquivos já `STAGED` e falhas após enviar `complete` não provocam descarte automático: a conclusão pode ter sido aceita mesmo sem resposta. Repita com a mesma chave para recuperar o estado, ou reconcilie no backend. O callback `authorize` pertence ao app e não pode ser interrompido pelo SDK; se devolver um upload ainda pendente depois do cancelamento, o SDK tenta descartá-lo. O cleanup do servidor cobre fechamento de aba e perda de rede. `files.cancel(grantId)` permite descarte explícito quando o app decidiu abandonar o upload, inclusive se ele já estiver `STAGED`.
- Download retorna `{ file, blob }`, após conferir tamanho e SHA256 COMPOSITE em partes. O Blob é `application/octet-stream`; limite de leitura é 25 MiB, sem buffering ilimitado de resposta. Use `URL.createObjectURL` apenas localmente e `URL.revokeObjectURL` ao desmontar. Prévia de rascunho pode usar o `File` original. Não execute HTML/SVG nem confie no MIME declarado para embutir conteúdo ativo na origem autenticada.
- A transferência usa `globalThis.fetch` com `credentials: 'omit'`, `redirect: 'error'`, sem token, cookies, referrer ou headers da API. Só aceita HTTPS e os headers de conteúdo/checksum previstos. `Content-Length` vem do tamanho exato do Blob, calculado pelo browser, nunca de `setRequestHeader`. CORS e assinatura precisam ser homologados na infraestrutura real.
- Metadados e grants não contêm URL de armazenamento; resgate usa a sessão comum e as URLs ficam apenas em memória durante a chamada. Guarde `fileId` no histórico. A versão original é baixada diretamente, sem transformação. Arquivos validados são imutáveis; substituir conteúdo cria outro arquivo.
- `FILE_GRANT_EXPIRED` pede nova autorização: chame `download` novamente, com nova chave de idempotência na Function, depois de decidir tentar de novo. Não há renovação silenciosa nem loop infinito. `FILE_INTEGRITY_FAILED` recusa conteúdo divergente; `INVALID_RESPONSE` recusa contrato inválido; `FILE_TRANSFER_FAILED` indica falha de rede/servidor após tentativas; `FILE_TRANSFER_REJECTED` indica recusa do armazenamento. Erros de API preservam `status` e `code`, sem mensagens/detalhes que exponham grants ou URLs.

Os tipos `FileMetadata`, `FileChecksum`, `FileGrant`, `FileUploadInput`, `FileUpload`, `FileUploadOptions`, `FileDownloadOptions`, `FileDownload` e `FilesModule` são exportados. Datas são strings ISO UTC. SHA256 COMPOSITE é o SHA-256 da concatenação dos hashes binários das partes, em base64 com sufixo `-N`, inclusive `-1`; não é o hash simples do arquivo inteiro.

## Configuração

| Campo | Obrigatório | Uso |
|---|---|---|
| `appId` | sim | ID do app no Code Studio |
| `apiUrl` | sim | URL do API gateway da Mitra |
| `onError` | não | callback com o `MitraApiError` das falhas de `entities`, `queries`, `functions`, `integration`, `agentTasks`, `agentCredentials` e `aiProviders`; `init()`, login, `publicFunctions` e falha de rede não passam por ele e são tratados no `catch` de cada chamada |
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
| `UNSUPPORTED_AUTH_METHOD` | `signIn` ou `signUp` antigos | use `signInWithPassword()` ou `signUpWithPassword()`; no formulário próprio, `signInWithPasswordForm()` ou `startPasswordSignUp()` |
| `PASSWORD_FORM_NOT_ENABLED` | `403` em `signInWithPasswordForm()`, `completePasswordSignUp()`, `changePasswordForm()` ou `confirmPasswordReset()`, com o app no modo da tela da Mitra | ligue o modo "Formulário no próprio app" no login por senha do app, ou use os métodos da tela da Mitra (`signInWithPassword()`, `signUpWithPassword()`, `changePassword()`) |
| `INVALID_CREDENTIALS` | `401` de e-mail ou senha errados, conta bloqueada ou sem senha, todos com a mesma resposta; na troca, a senha atual errada | mostre uma mensagem só, sem dizer qual dado errou |
| `WEAK_PASSWORD` | a senha nova não passa na política; a mensagem diz a regra | mostre a mensagem e peça outra senha |
| `CURRENT_PASSWORD_REQUIRED` | `changePasswordForm()` sem a senha atual, numa conta que já tem senha | peça a senha atual |
| `PASSWORD_ALREADY_SET` | `completePasswordSignUp()` numa conta que já tem senha | leve a pessoa ao login ou ao reset |
| `SSO_ACCOUNT` | `changePasswordForm()`, `completePasswordSignUp()` ou `confirmPasswordReset()` numa conta que entra com Google ou Microsoft | leve a pessoa ao login pelo provedor dela |
| `RESET_TOKEN_USED`, `RESET_TOKEN_EXPIRED` | o link de reset já foi usado ou venceu; token desconhecido também chega como `RESET_TOKEN_EXPIRED` | peça um link novo com `requestPasswordReset()` |
| `PASSWORD_CHANGED_SIGN_IN_AGAIN` | `changePassword()` ou `changePasswordForm()` trocou a senha, mas o novo login falhou; a sessão local já foi limpa | leve a pessoa ao login com a senha nova |
| `RATE_LIMITED`, `RATE_LIMIT_EXCEEDED` | `requestPasswordReset()` ou `startPasswordSignUp()` pedido vezes demais para o mesmo endereço (`RATE_LIMITED`), ou rotas de senha chamadas vezes demais da mesma rede, nos métodos do formulário próprio também (`RATE_LIMIT_EXCEEDED`); no login, na confirmação do cadastro, na troca e na confirmação do reset do formulário próprio, `RATE_LIMIT_EXCEEDED` também sai quando o IAM está no limite de senhas em processamento | espere `retryAfterSeconds`, quando vier |
| `INVALID_CODE` | o código digitado não confere | peça para a pessoa conferir o código |
| `MAGIC_LINK_EXPIRED`, `MAGIC_LINK_USED`, `MAGIC_LINK_INVALID` | o link do e-mail venceu, já foi usado ou não vale | peça um código novo |
| `REDIRECT_NOT_ALLOWED` | o servidor respondeu com redirect | confira o `apiUrl` |
| `INVALID_RESPONSE` | resposta fora do formato esperado | atualize o SDK; se continuar, abra uma issue |

Falha de rede chega como o erro do próprio `fetch` (`TypeError`), sem passar por `onError`.

## Boas práticas

- Chame `await mitra.init()` no startup, antes de montar a tela de login: `allowSignup`, `emailLoginEnabled`, `passwordLoginEnabled` e o login por e-mail dependem dele.
- Com `mode: "redirect"`, chame no startup o `completeGoogleSignInRedirect()`, `completeMicrosoftSignInRedirect()` ou `completeEmailSignInRedirect()` do método que você usa. Cada um devolve `null` quando a URL não é dele. O link do e-mail completa o login no mesmo browser que pediu o código; em outro aparelho, a pessoa digita o código. O login por conexão de identidade (Sankhya Pass), pelo iframe ou por redirect, dispensa essa chamada: o `init()` já completa.
- A sessão fica no `localStorage` do domínio do app, na chave `mitra_auth_{appId}`, e é renovada sozinha antes de vencer. A do login por conexão de identidade fica no `sessionStorage` da aba, na mesma chave. `signOut()` limpa a sessão e, em app com contas próprias, encerra a sessão no servidor: o refresh token deixa de renovar, e o access token já emitido vale até vencer.
- Alguns apps recebem tokens extras junto da sessão, em `auth.allTokens`, liberados app por app pela Mitra. O de backoffice é o mais sensível: ele carrega os acessos que a pessoa tem no backoffice da Mitra, vale uma hora e fica no mesmo storage da sessão, onde qualquer script do domínio do app consegue ler. Leia ele por `auth.ensureFreshBackofficeToken()`, que renova o token quando está perto de vencer e devolve `null` quando o app ou a pessoa não têm esse acesso. Use só contra o backoffice e não repasse para outro serviço.
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
