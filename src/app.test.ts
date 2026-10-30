import { afterEach, expect, test } from "bun:test";
import { createLocalJWKSet, jwtVerify } from "jose";
import { generatePrivateJwk } from "../scripts/gen-key";
import { startServer } from "./app";
import { createLogger } from "./log";

const servers: { stop: (force?: boolean) => unknown }[] = [];

afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
});

type LogLine = Record<string, unknown>;

async function setup(options: Parameters<typeof startServer>[0] = {}) {
    const lines: LogLine[] = [];
    const raw: string[] = [];
    const server = await startServer({
        logger: createLogger({
            service: "auth",
            level: "debug",
            write: (line) => {
                raw.push(line);
                lines.push(JSON.parse(line));
            },
        }),
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

    const find = (message: string) =>
        lines.filter((line) => line.message === message);

    return { base, post, lines, raw, find };
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

test("logs startup and an access line per request with the route pattern", async () => {
    const { base, post, find } = await setup();
    expect(find("listening")[0]).toMatchObject({
        level: "info",
        service: "auth",
        port: expect.any(Number),
    });

    await post("/register", credentials);
    const { accessToken } = await (await post("/login", credentials)).json();
    const me = await fetch(`${base}/me?secret=abc`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    const { id } = await me.json();
    await fetch(`${base}/nope?x=1`);

    const access = find("request");
    expect(access.map((line) => line.route)).toEqual([
        "/register",
        "/login",
        "/me",
        "unmatched",
    ]);
    const meLine = access[2];
    expect(meLine).toMatchObject({
        level: "info",
        method: "GET",
        route: "/me",
        status: 200,
        userId: id,
        requestId: me.headers.get("x-request-id"),
    });
    expect(Number.isInteger(meLine?.ms)).toBe(true);
    expect(new Date(String(meLine?.time)).toISOString()).toBe(
        String(meLine?.time),
    );
    expect(access[3]).toMatchObject({ status: 404 });
    expect(access[3]?.userId).toBeUndefined();
});

test("echoes a valid X-Request-Id and replaces a missing or invalid one", async () => {
    const { base, lines } = await setup();
    const jwks = `${base}/.well-known/jwks.json`;

    const echoed = await fetch(jwks, {
        headers: { "X-Request-Id": "gw-1.a_b" },
    });
    expect(echoed.headers.get("x-request-id")).toBe("gw-1.a_b");

    const generated = await fetch(jwks);
    const invalid = await fetch(jwks, {
        headers: { "X-Request-Id": "bad id\\n{}" },
    });
    const tooLong = await fetch(jwks, {
        headers: { "X-Request-Id": "a".repeat(129) },
    });
    const uuid = /^[0-9a-f-]{36}$/;
    for (const response of [generated, invalid, tooLong]) {
        expect(response.headers.get("x-request-id")).toMatch(uuid);
    }

    // Errors and preflights carry it too.
    const notFound = await fetch(`${base}/nope`, {
        headers: { "X-Request-Id": "r404" },
    });
    expect(notFound.headers.get("x-request-id")).toBe("r404");
    const options = await fetch(`${base}/login`, {
        method: "OPTIONS",
        headers: { "X-Request-Id": "r-opt" },
    });
    expect(options.status).toBe(204);
    expect(options.headers.get("x-request-id")).toBe("r-opt");

    const ids = lines
        .filter((line) => line.message === "request")
        .map((line) => line.requestId);
    expect(ids).toEqual([
        "gw-1.a_b",
        generated.headers.get("x-request-id"),
        invalid.headers.get("x-request-id"),
        tooLong.headers.get("x-request-id"),
        "r404",
        "r-opt",
    ]);
});

test("logs register and login audit events with masked emails", async () => {
    const { post, find } = await setup();

    const user = await (await post("/register", credentials)).json();
    await post("/register", credentials);
    await post("/register", { email: "nope", password: "12345678" });
    await post("/login", { ...credentials, password: "wrong pass" });
    await post("/login", { email: "x@y.zz", password: "whatever1" });
    await post("/login", credentials);

    expect(find("user registered")).toEqual([
        expect.objectContaining({ level: "info", userId: user.id }),
    ]);
    expect(find("register rejected")).toEqual([
        expect.objectContaining({
            level: "warn",
            reason: "duplicate",
            email: "u***@example.com",
        }),
        expect.objectContaining({ reason: "invalid_email", email: "***" }),
    ]);
    expect(find("login failed")).toEqual([
        expect.objectContaining({
            level: "warn",
            reason: "wrong_password",
            email: "u***@example.com",
            clientIp: expect.any(String),
        }),
        expect.objectContaining({
            reason: "unknown_email",
            email: "x***@y.zz",
        }),
    ]);
    expect(find("login succeeded")).toEqual([
        expect.objectContaining({
            level: "info",
            userId: user.id,
            clientIp: expect.any(String),
        }),
    ]);
    // Every audit line belongs to its request.
    for (const line of find("login failed")) {
        expect(line.requestId).toBeString();
    }
});

test("logs rate limiting with the proxy-aware client IP", async () => {
    const { base, find } = await setup({
        rateLimit: { limit: 1, windowMs: 60_000 },
        trustProxy: true,
    });
    const login = () =>
        fetch(`${base}/login`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Forwarded-For": "1.2.3.4, 10.0.0.7",
            },
            body: JSON.stringify(credentials),
        });
    await login();
    expect((await login()).status).toBe(429);
    expect(find("login rate limited")).toEqual([
        expect.objectContaining({ level: "warn", clientIp: "10.0.0.7" }),
    ]);
});

test("logs refresh, reuse detection, rejections and logout", async () => {
    const { post, find } = await setup();
    const { id } = await (await post("/register", credentials)).json();
    const first = cookieFrom(await post("/login", credentials));
    const second = cookieFrom(await post("/refresh", undefined, first));
    await post("/refresh", undefined, first);
    await post("/refresh");

    expect(find("token refreshed")).toEqual([
        expect.objectContaining({ level: "debug", userId: id }),
    ]);
    expect(find("refresh token reuse detected")).toEqual([
        expect.objectContaining({ level: "warn", userId: id }),
    ]);
    expect(find("refresh rejected")).toEqual([
        expect.objectContaining({ level: "info", reason: "no_cookie" }),
    ]);

    const third = cookieFrom(await post("/login", credentials));
    await post("/logout", undefined, third);
    await post("/logout", undefined, second);
    expect(find("logged out")).toEqual([
        expect.objectContaining({ level: "info", userId: id }),
        expect.objectContaining({ level: "info", userId: id }),
    ]);
    await post("/logout");
    expect(find("logged out")[2]?.userId).toBeUndefined();
});

test("logs expired refresh tokens", async () => {
    const { post, find } = await setup({ refreshTtlSeconds: -1 });
    await post("/register", credentials);
    await post(
        "/refresh",
        undefined,
        cookieFrom(await post("/login", credentials)),
    );
    expect(find("refresh rejected")).toEqual([
        expect.objectContaining({ reason: "expired" }),
    ]);
});

test("never logs passwords, tokens, cookies or the plain email", async () => {
    const { base, post, raw } = await setup();
    await post("/register", credentials);
    await post("/login", { ...credentials, password: "wrong pass" });
    const login = await post("/login", credentials);
    const cookie = cookieFrom(login);
    const { accessToken } = await login.json();
    await fetch(`${base}/me`, {
        headers: { Authorization: `Bearer ${accessToken}`, Cookie: cookie },
    });
    const refreshed = await post("/refresh", undefined, cookie);
    const { accessToken: secondToken } = await refreshed.json();
    await post("/logout", undefined, cookieFrom(refreshed));

    const output = raw.join("\n").toLowerCase();
    const secrets = [
        credentials.password,
        "wrong pass",
        credentials.email,
        accessToken,
        secondToken,
        cookie.split("=")[1],
        cookieFrom(refreshed).split("=")[1],
    ];
    for (const secret of secrets) {
        expect(secret).toBeTruthy();
        expect(output).not.toContain(String(secret).toLowerCase());
    }
    expect(output).not.toContain("authorization");
    expect(output).not.toContain("cookie");
});

test("LOG_LEVEL drops lines below the configured level", () => {
    const write = (into: string[]) => (line: string) => into.push(line);
    const levels = (level: string | undefined) => {
        const out: string[] = [];
        const log = createLogger({ service: "auth", level, write: write(out) });
        log.debug("d");
        log.info("i");
        log.warn("w");
        log.error("e", { error: String(new Error("boom")) });
        return out.map((line) => JSON.parse(line).level);
    };
    expect(levels("debug")).toEqual(["debug", "info", "warn", "error"]);
    expect(levels("warn")).toEqual(["warn", "error"]);
    expect(levels("error")).toEqual(["error"]);
    expect(levels("")).toEqual(["info", "warn", "error"]);
    expect(levels("loud")).toEqual(["info", "warn", "error"]);
});
