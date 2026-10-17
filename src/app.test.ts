import { afterEach, expect, test } from "bun:test";
import { createLocalJWKSet, jwtVerify } from "jose";
import { generatePrivateJwk } from "../scripts/gen-key";
import { startServer } from "./app";

const servers: { stop: (force?: boolean) => unknown }[] = [];

afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
});

async function setup(options: Parameters<typeof startServer>[0] = {}) {
    const server = await startServer({
        port: 0,
        dbPath: ":memory:",
        privateJwk: await generatePrivateJwk(),
        issuer: "http://auth.test",
        audience: ["blob_storage"],
        corsOrigin: "http://app.test",
        cookieSecure: false,
        ...options,
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;

    const post = (path: string, body?: unknown, cookie?: string) =>
        fetch(base + path, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(cookie ? { Cookie: cookie } : {}),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });

    return { base, post };
}

// "refresh_token=abc; Path=/; HttpOnly" -> "refresh_token=abc"
const cookieFrom = (response: Response) =>
    (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

const credentials = { email: "User@Example.com", password: "correct horse" };

test("register, login, /me, and the token verifies against the JWKS", async () => {
    const { base, post } = await setup();

    const registered = await post("/register", credentials);
    expect(registered.status).toBe(201);
    const user = await registered.json();
    expect(user.email).toBe("user@example.com");

    expect((await post("/register", credentials)).status).toBe(409);

    const login = await post("/login", credentials);
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    const { accessToken } = await login.json();

    const jwks = await (await fetch(`${base}/.well-known/jwks.json`)).json();
    expect(jwks.keys[0].d).toBeUndefined();
    const { payload } = await jwtVerify(accessToken, createLocalJWKSet(jwks), {
        issuer: "http://auth.test",
        audience: "blob_storage",
    });
    expect(payload.sub).toBe(user.id);

    const me = await fetch(`${base}/me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(await me.json()).toEqual({ id: user.id, email: "user@example.com" });
    expect((await fetch(`${base}/me`)).status).toBe(401);
});

test("rejects bad input and wrong passwords", async () => {
    const { post } = await setup();

    expect(
        (await post("/register", { email: "nope", password: "12345678" }))
            .status,
    ).toBe(400);
    expect(
        (await post("/register", { email: "a@b.co", password: "short" }))
            .status,
    ).toBe(400);
    expect((await post("/register", undefined)).status).toBe(400);

    await post("/register", credentials);
    expect(
        (await post("/login", { ...credentials, password: "wrong pass" }))
            .status,
    ).toBe(401);
    expect(
        (await post("/login", { email: "x@y.zz", password: "whatever1" }))
            .status,
    ).toBe(401);
});

test("refresh rotates the token; reusing an old one logs the user out everywhere", async () => {
    const { post } = await setup();
    await post("/register", credentials);
    const first = cookieFrom(await post("/login", credentials));

    const refreshed = await post("/refresh", undefined, first);
    expect(refreshed.status).toBe(200);
    expect((await refreshed.json()).accessToken).toBeString();
    const second = cookieFrom(refreshed);
    expect(second).not.toBe(first);

    // Replaying the rotated-out token revokes every session, including `second`.
    expect((await post("/refresh", undefined, first)).status).toBe(401);
    expect((await post("/refresh", undefined, second)).status).toBe(401);
});

test("logout revokes the refresh token", async () => {
    const { post } = await setup();
    await post("/register", credentials);
    const cookie = cookieFrom(await post("/login", credentials));

    expect((await post("/logout", undefined, cookie)).status).toBe(204);
    expect((await post("/refresh", undefined, cookie)).status).toBe(401);
    expect((await post("/refresh")).status).toBe(401);
});

test("expired refresh tokens are rejected", async () => {
    const { post } = await setup({ refreshTtlSeconds: -1 });
    await post("/register", credentials);
    const cookie = cookieFrom(await post("/login", credentials));
    expect((await post("/refresh", undefined, cookie)).status).toBe(401);
});

test("CORS preflight allows only the configured origin with credentials", async () => {
    const { base } = await setup();
    const response = await fetch(`${base}/login`, { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
        "http://app.test",
    );
    expect(response.headers.get("access-control-allow-credentials")).toBe(
        "true",
    );
});

test("rate limits login attempts per IP", async () => {
    const { post } = await setup({ rateLimit: { limit: 2, windowMs: 60_000 } });
    expect((await post("/login", credentials)).status).toBe(401);
    expect((await post("/login", credentials)).status).toBe(401);
    expect((await post("/login", credentials)).status).toBe(429);
});

test("with trustProxy, rate limits by the address the proxy appended", async () => {
    const { base } = await setup({
        rateLimit: { limit: 1, windowMs: 60_000 },
        trustProxy: true,
    });
    const login = (forwardedFor: string) =>
        fetch(`${base}/login`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Forwarded-For": forwardedFor,
            },
            body: JSON.stringify(credentials),
        });

    expect((await login("10.0.0.1")).status).toBe(401);
    expect((await login("10.0.0.2")).status).toBe(401);
    // A client-supplied first entry doesn't give a fresh budget.
    expect((await login("1.2.3.4, 10.0.0.1")).status).toBe(429);
});

test("without trustProxy, X-Forwarded-For is ignored", async () => {
    const { base } = await setup({ rateLimit: { limit: 1, windowMs: 60_000 } });
    const login = (forwardedFor: string) =>
        fetch(`${base}/login`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Forwarded-For": forwardedFor,
            },
            body: JSON.stringify(credentials),
        });

    expect((await login("10.0.0.1")).status).toBe(401);
    expect((await login("10.0.0.2")).status).toBe(429);
});
