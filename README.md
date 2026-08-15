# Mitra Platform SDK

[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=mitra-platform-sdk&metric=alert_status&token=28d7be14b66d6f88d706347e2418af5ea39ab3e9)](https://sonarcloud.io/summary/new_code?id=mitra-platform-sdk)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=mitra-platform-sdk&metric=coverage&token=28d7be14b66d6f88d706347e2418af5ea39ab3e9)](https://sonarcloud.io/summary/new_code?id=mitra-platform-sdk)

SDK JavaScript/TypeScript para apps criados na plataforma Mitra. O código gerado pelo Code Studio usa este pacote para autenticar usuários, acessar entidades do Data Manager, executar server functions, rodar custom queries e chamar integrações.

O transporte de browser usa apenas Web APIs padrão (`fetch`, `localStorage`, `URL`, `Proxy`). Os contratos e módulos comuns vêm de `@mitralab.io/sdk-core`, sem trazer autenticação de browser para o core.

## O Que a SDK Entrega

- Client único criado por `createClient`.
- Auth com login, cadastro, refresh token, logout e estado em `localStorage`.
- CRUD dinâmico em tabelas via `mitra.entities.<TableName>`.
- Execução de server functions publicadas.
- Execução de custom queries.
- Proxy de integrações e resources com credential injection no servidor.
- Tipos TypeScript exportados para os contratos principais.

## Instalação

```bash
npm install @mitralab.io/platform-sdk
```

## Quick Start

```typescript
import { createClient } from '@mitralab.io/platform-sdk';

export const mitra = createClient({
  appId: import.meta.env.VITE_MITRA_APP_ID,
  apiUrl: import.meta.env.VITE_MITRA_API_URL,
  onError: (error) => console.error(error.status, error.code, error.message),
});

await mitra.init();
```

`init()` resolve a configuração pública do app no Code Studio, incluindo `dataSourceId` e `allowSignup`. Chame no boot da aplicação antes de usar `entities`, `queries` ou fluxo de cadastro.

## Configuração

| Campo     | Obrigatório | Uso                                |
| --------- | ----------- | ---------------------------------- |
| `appId`   | sim         | ID do app publicado no Code Studio |
| `apiUrl`  | sim         | URL base do Kong/API da plataforma |
| `onError` | não         | callback global para erros de API  |

O client deriva os endpoints dos serviços a partir de `apiUrl`: `/iam`, `/data-manager`, `/functions`, `/integration` e `/code-studio`.

## Estrutura de Arquivos

```text
src/
├── client.ts          # createClient, composição dos módulos e init
├── modules/           # auth de browser e fachadas compatíveis com a API 1.x
├── utils/http-client  # fetch wrapper, auth header, retry 401 e MitraApiError
└── index.ts           # exports públicos
```

`@mitralab.io/sdk-core` concentra entities, queries, Functions, integration, `auth.me`, paths seguros e validação estrutural de respostas. A Platform SDK continua responsável por login, cadastro, refresh, `localStorage`, listeners e o retry único após refresh em resposta `401`.

## Módulos

| Módulo        | Uso                                                                                     |
| ------------- | --------------------------------------------------------------------------------------- |
| `auth`        | `signIn`, `signUp`, `signOut`, `refreshSession`, `me`, `checkAuth`, `onAuthStateChange` |
| `entities`    | CRUD dinâmico por tabela, filtro, paginação, bulk create e deleteMany                   |
| `functions`   | disparo de server function por ID com a semântica assíncrona da API 1.x                 |
| `queries`     | execução de custom query por ID com parâmetros                                          |
| `integration` | execução de integration resource ou proxy direto por config                             |

## Auth

```typescript
const user = await mitra.auth.signIn({
  email: 'user@example.com',
  password: 'password123',
});

const unsubscribe = mitra.auth.onAuthStateChange((currentUser) => {
  console.log(currentUser?.email);
});

mitra.auth.signOut('/login');
unsubscribe();
```

Estado de auth é persistido no `localStorage` com chave `mitra_auth_{appId}`. Em resposta `401`, o SDK tenta `refreshSession()` uma vez e repete a request.

## Entities

```typescript
type Task = {
  id: string;
  title: string;
  status: 'pending' | 'done';
};

const tasks = await mitra.entities.getTable<Task>('Task').list({
  sort: '-created_at',
  limit: 10,
  fields: ['id', 'title', 'status'],
});

const pending = await mitra.entities.Task.filter({ status: 'pending' });
const created = await mitra.entities.Task.create({ title: 'New task' });
await mitra.entities.Task.update(created.id, { status: 'done' });
await mitra.entities.Task.delete(created.id);
```

Table names são case-sensitive e precisam bater com o nome da tabela no Data Manager.

Records usam `/api/v1/tables/{table}/records`. O app e o tenant vêm do contexto autenticado, não do `dataSourceId` no path.

## Functions

```typescript
const execution = await mitra.functions.execute('function-id', {
  orderId: 'order-123',
});

console.log(execution.id, execution.status);
```

Na API 1.x, `execute` não envia `X-Invocation-Type`. O serviço usa o default assíncrono e devolve a execução criada, normalmente com status `PENDING`; a chamada não espera a Function terminar.

## Queries

```typescript
const result = await mitra.queries.execute('query-id', {
  status: 'active',
});

console.log(result.rows, result.affectedRows);
```

## Integration

Resource pré-definido:

```typescript
const result = await mitra.integration.executeResource('resource-id', {
  descricao: 'Notebook',
  limit: 10,
});
```

Proxy direto por config:

```typescript
const result = await mitra.integration.execute('config-id', {
  method: 'GET',
  endpoint: '/users',
  queryParams: { limit: '10' },
});

console.log(result.status, result.body);
```

## Erros

Erros de API lançam `MitraApiError`:

```typescript
import { MitraApiError } from '@mitralab.io/platform-sdk';

try {
  await mitra.entities.Task.get('missing-id');
} catch (error) {
  if (error instanceof MitraApiError) {
    console.error(error.status, error.code, error.message);
  }
}
```

O transporte não segue redirects HTTP. Respostas 307, 308 ou respostas já
marcadas como redirecionadas falham sem replay. A única repetição automática é
a tentativa única após refresh bem-sucedido em resposta 401.

Antes de construir `MitraApiError`, a SDK remove o token usado na tentativa e
qualquer credencial no formato `Bearer` de `message`, `code` e `details`,
percorrendo recursivamente valores, arrays e chaves de objetos.

## Desenvolvimento

```bash
npm install
npm run build
npm run lint
npm test
```

Na adoção empilhada inicial, o core deve ser empacotado e instalado com `--no-save --package-lock=false` para validação local. Nenhum `file:` ou path de tarball entra no manifesto. Depois que `@mitralab.io/sdk-core@0.1.0` for publicado, o lockfile deve ser regenerado a partir do registry antes do PR da Platform SDK.

Build gera CommonJS, ESM e tipos TypeScript em `dist/`.
