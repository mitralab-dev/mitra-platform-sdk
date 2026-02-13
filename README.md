# Mitra Platform SDK

The Mitra Platform SDK provides a JavaScript/TypeScript interface for building apps on the Mitra Platform. When Mitra generates your app, the generated code uses this SDK to authenticate users, manage your app's data, execute serverless functions, and more. You can use the same SDK to modify and extend your app.

**Zero runtime dependencies.** Uses only standard Web APIs (`fetch`, `localStorage`, `URL`, `Proxy`).

## Modules

- **`auth`**: User authentication, registration, and session handling.
- **`entities`**: Database CRUD operations.
- **`functions`**: Serverless function execution.
- **`integration`**: Proxy HTTP requests to external APIs with automatic credential injection.
- **`queries`**: Execute reusable named queries.

## Installation

```bash
npm install mitra-platform-sdk
```

## Quick Start

```typescript
import { createClient } from 'mitra-platform-sdk';

const mitra = createClient({
  appId: 'your-app-id',
  apiUrl: 'https://api.mitra.io',
});

await mitra.init();
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `appId` | `string` | Yes | Your app's unique identifier |
| `apiUrl` | `string` | Yes | Base URL of the Mitra API |
| `onError` | `(error) => void` | No | Global error handler for all API requests |

`init()` must be called before using the client. Safe to call multiple times.

## Usage

All modules and methods are fully typed — explore the full API through your editor's autocomplete or read the JSDoc in the source code.

### Authentication

```typescript
// Sign up (auto-signs in after registration)
const user = await mitra.auth.signUp({
  email: 'user@example.com',
  password: 'password123',
  name: 'Jane Doe',
});

// Sign in
await mitra.auth.signIn({ email: 'user@example.com', password: 'password123' });

// Check state
console.log(mitra.auth.isAuthenticated, mitra.auth.currentUser);

// Listen for auth changes (fires immediately with current state)
const unsubscribe = mitra.auth.onAuthStateChange((user) => {
  console.log(user ? 'Logged in' : 'Logged out');
});

// Sign out
mitra.auth.signOut();
```

### Entities

```typescript
const tasks = await mitra.entities.Task.list('-created_at', 10);

const task = await mitra.entities.Task.create({
  title: 'New task',
  status: 'pending',
});

await mitra.entities.Task.update(task.id, { status: 'done' });

await mitra.entities.Task.delete(task.id);
```

### Functions

```typescript
const execution = await mitra.functions.execute('function-id', {
  to: 'user@example.com',
  subject: 'Welcome',
});

console.log(execution.status, execution.output);
```

### Queries

```typescript
const result = await mitra.queries.execute('query-id', { status: 'active' });
console.log(result.rows);
```

### Integration

```typescript
const result = await mitra.integration.execute('config-id', {
  method: 'GET',
  endpoint: '/users',
});
console.log(result.status, result.body);
```

## Error Handling

All API errors throw `MitraApiError`:

```typescript
import { MitraApiError } from 'mitra-platform-sdk';

try {
  await mitra.entities.Task.get('non-existent-id');
} catch (error) {
  if (error instanceof MitraApiError) {
    console.error(error.status, error.code, error.message);
  }
}
```

## Development

### Build the SDK

```bash
npm install
npm run build
```

### Run tests

```bash
npm test
```

## License

MIT
