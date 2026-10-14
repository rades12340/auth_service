# auth_service

Login service for the Blob_storage system. It stores users, issues short-lived JWT access tokens, and publishes its public key so other services (`blob_storage`, `todos_service`) can check tokens themselves without calling this service.

```
Browser ──login/refresh──▶ auth_service ──▶ SQLite (users, refresh tokens)
   │                          │ /.well-known/jwks.json (public key)
   │ Bearer access token      ▼
   ├──────────────▶ blob_storage  ─┐ verify signature locally
   └──────────────▶ todos_service ─┘
```

## Requirements

- Bun v1.3 or newer

## Getting started

```bash
bun install
cp .env.example .env
bun run gen-key >> .env   # adds AUTH_PRIVATE_KEY (keep it secret)
bun run dev               # http://localhost:4000
```

For local development over plain http, set `COOKIE_SECURE=false` in `.env`.

## Tokens

| Token | Lifetime | Where it lives |
| --- | --- | --- |
| Access token (JWT, EdDSA) | 15 min | In the frontend's memory. Sent as `Authorization: Bearer <token>` to the other services. |
| Refresh token (random, stored hashed) | 14 days, replaced on every refresh | `httpOnly`, `SameSite=Strict` cookie `refresh_token`. |

Access token claims: `sub` (user id), `iss` (`AUTH_ISSUER`), `aud` (`AUTH_AUDIENCE`), `iat`, `exp`.

If a refresh token that has already been replaced is used again, every session of that user is revoked (likely token theft).

## API

| Method & path | Body | Response |
| --- | --- | --- |
| `POST /register` | `{ email, password }` (password 8–256 chars) | `201 { id, email }`, `409` if the email exists |
| `POST /login` | `{ email, password }` | `200 { accessToken }` and sets the refresh cookie, `401` on bad credentials |
| `POST /refresh` | – (uses the cookie) | `200 { accessToken }` and a new cookie, `401` otherwise |
| `POST /logout` | – (uses the cookie) | `204`, revokes the refresh token |
| `GET /me` | – (`Authorization: Bearer …`) | `200 { id, email }`, `401` otherwise |
| `GET /.well-known/jwks.json` | – | `{ keys: [...] }` public keys |

`/register` and `/login` are rate limited to 20 requests per minute per IP. The browser must call the API with `credentials: "include"` so the refresh cookie is sent; CORS allows only `CORS_ORIGIN`.

```bash
curl -X POST localhost:4000/register -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"password123"}'
curl -i -X POST localhost:4000/login -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"password123"}'
```

## Verifying tokens in another service

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";

const jwks = createRemoteJWKSet(new URL("http://localhost:4000/.well-known/jwks.json"));
const { payload } = await jwtVerify(token, jwks, {
    issuer: "http://localhost:4000",
    audience: "blob_storage",
});
// payload.sub is the user id
```

## Project layout

| Path | What it is |
| --- | --- |
| `src/app.ts` | `startServer(options)`: reads config from options or env and starts `Bun.serve()`. |
| `src/routes.ts` | All routes, token signing, cookies, CORS. |
| `src/db.ts` | `bun:sqlite` schema and queries (`users`, `refresh_tokens`). |
| `src/keys.ts` | Loads the private JWK and derives the public JWK. |
| `src/rateLimit.ts` | In-memory per-IP rate limiter. |
| `scripts/gen-key.ts` | Prints a new Ed25519 key as an `.env` line. |

## Checks

| Command | What it does |
| --- | --- |
| `bun test` | Runs the tests (in-memory database, generated key). |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` / `lint:fix` | Biome |

Husky runs Biome on commit and typecheck + tests on push. GitHub Actions runs all three.

## Known limitations

- The rate limiter is in memory: it resets on restart and isn't shared between instances.
- Only one signing key at a time. To rotate, the JWKS would need to serve the old and new public keys for one access-token lifetime.
