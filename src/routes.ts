import { jwtVerify, SignJWT } from "jose";
import type { Db } from "./db";
import { docsRoutes } from "./docs";
import { ALG, type SigningKey } from "./keys";
import type { LogFields, Logger } from "./log";
import { createRateLimiter } from "./rateLimit";

export type AuthConfig = {
    db: Db;
    key: SigningKey;
    issuer: string;
    audience: string[];
    corsOrigin: string;
    accessTtlSeconds: number;
    refreshTtlSeconds: number;
    cookieSecure: boolean;
    rateLimit: { limit: number; windowMs: number };
    // Only behind a proxy that sets X-Forwarded-For, such as api_gateway.
    trustProxy: boolean;
    logger: Logger;
};

// Per-request state: a logger that adds the request id to every line, and the
// user id once the request is authenticated (it goes on the access log line).
export type RequestContext = {
    log: Logger;
    requestId: string;
    userId?: string;
};

type Handler<R extends Request> = (
    request: R,
    server: Bun.Server<unknown>,
    ctx: RequestContext,
) => Response | Promise<Response>;

const REFRESH_COOKIE = "refresh_token";
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const requestIdPattern = /^[A-Za-z0-9._-]{1,128}$/;

// Compared against when the email is unknown, so a failed login takes the same
// time whether or not the account exists.
const dummyHash = await Bun.password.hash("timing-equalizer");

const sha256 = (value: string) =>
    new Bun.CryptoHasher("sha256").update(value).digest("hex");

// "alice@example.com" -> "a***@example.com", so logs can be correlated without
// holding the address.
export function maskEmail(email: string) {
    const at = email.lastIndexOf("@");
    return at > 0 ? `${email[0]}***${email.slice(at)}` : "***";
}

function withFields(log: Logger, base: LogFields): Logger {
    return {
        debug: (message, fields) => log.debug(message, { ...base, ...fields }),
        info: (message, fields) => log.info(message, { ...base, ...fields }),
        warn: (message, fields) => log.warn(message, { ...base, ...fields }),
        error: (message, fields) => log.error(message, { ...base, ...fields }),
    };
}

// Wraps a handler with the request id (taken from the gateway's X-Request-Id
// or generated), echoes it on the response, and writes one access log line.
// `route` is the pattern, never the raw URL, so query strings stay out of logs.
export function instrument<R extends Request>(
    logger: Logger,
    route: string,
    handler: Handler<R>,
) {
    return async (request: R, server: Bun.Server<unknown>) => {
        const start = performance.now();
        const incoming = request.headers.get("x-request-id") ?? "";
        const requestId = requestIdPattern.test(incoming)
            ? incoming
            : crypto.randomUUID();
        const ctx: RequestContext = {
            requestId,
            log: withFields(logger, { requestId }),
        };

        let response: Response;
        try {
            response = await handler(request, server, ctx);
        } catch (err) {
            ctx.log.error("unhandled error", { route, error: String(err) });
            response = Response.json(
                { error: "Internal server error" },
                { status: 500 },
            );
        }
        response.headers.set("X-Request-Id", requestId);
        ctx.log.info("request", {
            method: request.method,
            route,
            status: response.status,
            ms: Math.round(performance.now() - start),
            ...(ctx.userId ? { userId: ctx.userId } : {}),
        });
        return response;
    };
}

type RouteTable = Record<string, Record<string, Handler<Bun.BunRequest>>>;

function instrumentAll<T extends RouteTable>(logger: Logger, table: T) {
    return Object.fromEntries(
        Object.entries(table).map(([route, methods]) => [
            route,
            Object.fromEntries(
                Object.entries(methods).map(([method, handler]) => [
                    method,
                    instrument(logger, route, handler),
                ]),
            ),
        ]),
    ) as {
        [P in keyof T]: {
            [M in keyof T[P]]: (
                request: Bun.BunRequest,
                server: Bun.Server<unknown>,
            ) => Promise<Response>;
        };
    };
}

export function createRoutes(config: AuthConfig) {
    const { db, key } = config;
    const allow = createRateLimiter(config.rateLimit);

    const corsHeaders = {
        "Access-Control-Allow-Origin": config.corsOrigin,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Expose-Headers": "X-Request-Id",
        Vary: "Origin",
    };

    const json = (body: unknown, status = 200) =>
        Response.json(body, { status, headers: corsHeaders });

    const preflight = () =>
        new Response(null, { status: 204, headers: corsHeaders });

    async function readCredentials(request: Request) {
        const body = await request.json().catch(() => null);
        const email =
            typeof body?.email === "string"
                ? body.email.trim().toLowerCase()
                : "";
        const password =
            typeof body?.password === "string" ? body.password : "";
        return { email, password };
    }

    function signAccessToken(userId: string) {
        return new SignJWT({})
            .setProtectedHeader({ alg: ALG, kid: key.kid })
            .setSubject(userId)
            .setIssuer(config.issuer)
            .setAudience(config.audience)
            .setIssuedAt()
            .setExpirationTime(`${config.accessTtlSeconds}s`)
            .sign(key.privateKey);
    }

    function issueRefreshToken(request: Bun.BunRequest, userId: string) {
        const token = Buffer.from(
            crypto.getRandomValues(new Uint8Array(32)),
        ).toString("base64url");
        db.insertRefreshToken(
            userId,
            sha256(token),
            Date.now() + config.refreshTtlSeconds * 1000,
        );
        request.cookies.set(REFRESH_COOKIE, token, {
            httpOnly: true,
            secure: config.cookieSecure,
            sameSite: "strict",
            path: "/",
            maxAge: config.refreshTtlSeconds,
        });
    }

    function clearRefreshCookie(request: Bun.BunRequest) {
        request.cookies.delete({ name: REFRESH_COOKIE, path: "/" });
    }

    // Behind the API gateway every request comes from the gateway's address.
    // With trustProxy, the client is the last X-Forwarded-For entry: the one
    // the gateway appended, which a client can't forge.
    function clientIp(request: Request, server: Bun.Server<unknown>) {
        const forwarded = config.trustProxy
            ? request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim()
            : undefined;
        return forwarded || server.requestIP(request)?.address || "unknown";
    }

    return instrumentAll(config.logger, {
        ...docsRoutes,

        "/register": {
            OPTIONS: preflight,
            POST: async (request, server, { log }) => {
                const ip = clientIp(request, server);
                if (!allow(ip)) {
                    log.warn("register rejected", {
                        reason: "rate_limited",
                        clientIp: ip,
                    });
                    return json({ error: "Too many requests" }, 429);
                }
                const { email, password } = await readCredentials(request);
                const reject = (reason: string) =>
                    log.warn("register rejected", {
                        reason,
                        email: maskEmail(email),
                    });
                if (!emailPattern.test(email) || email.length > 254) {
                    reject("invalid_email");
                    return json({ error: "Invalid email" }, 400);
                }
                if (password.length < 8 || password.length > 256) {
                    reject("invalid_password");
                    return json(
                        { error: "Password must be 8-256 characters" },
                        400,
                    );
                }
                if (db.findUserByEmail(email)) {
                    reject("duplicate");
                    return json({ error: "Email already registered" }, 409);
                }

                const user = db.createUser(
                    email,
                    await Bun.password.hash(password),
                );
                log.info("user registered", { userId: user.id });
                return json({ id: user.id, email: user.email }, 201);
            },
        },

        "/login": {
            OPTIONS: preflight,
            POST: async (request, server, ctx) => {
                const ip = clientIp(request, server);
                if (!allow(ip)) {
                    ctx.log.warn("login rate limited", { clientIp: ip });
                    return json({ error: "Too many requests" }, 429);
                }
                const { email, password } = await readCredentials(request);
                const user = db.findUserByEmail(email);
                const valid = await Bun.password.verify(
                    password,
                    user?.password_hash ?? dummyHash,
                );
                if (!user || !valid) {
                    // The reason is for operators only; the client gets the
                    // same response either way.
                    ctx.log.warn("login failed", {
                        email: maskEmail(email),
                        clientIp: ip,
                        reason: user ? "wrong_password" : "unknown_email",
                    });
                    return json({ error: "Invalid email or password" }, 401);
                }

                issueRefreshToken(request, user.id);
                ctx.userId = user.id;
                ctx.log.info("login succeeded", {
                    userId: user.id,
                    clientIp: ip,
                });
                return json({ accessToken: await signAccessToken(user.id) });
            },
        },

        "/refresh": {
            OPTIONS: preflight,
            POST: async (request, _server, ctx) => {
                const token = request.cookies.get(REFRESH_COOKIE);
                const stored = token
                    ? db.findRefreshToken(sha256(token))
                    : null;
                if (!stored) {
                    ctx.log.info("refresh rejected", {
                        reason: token ? "unknown_token" : "no_cookie",
                    });
                    clearRefreshCookie(request);
                    return json({ error: "Not logged in" }, 401);
                }
                if (stored.revoked_at !== null) {
                    // A rotated-out token was used again: it was probably stolen.
                    // Log the user out everywhere.
                    db.revokeAllForUser(stored.user_id);
                    ctx.log.warn("refresh token reuse detected", {
                        userId: stored.user_id,
                    });
                    clearRefreshCookie(request);
                    return json({ error: "Not logged in" }, 401);
                }
                if (stored.expires_at <= Date.now()) {
                    ctx.log.info("refresh rejected", {
                        reason: "expired",
                        userId: stored.user_id,
                    });
                    clearRefreshCookie(request);
                    return json({ error: "Session expired" }, 401);
                }

                db.revokeRefreshToken(stored.id);
                issueRefreshToken(request, stored.user_id);
                ctx.userId = stored.user_id;
                ctx.log.debug("token refreshed", { userId: stored.user_id });
                return json({
                    accessToken: await signAccessToken(stored.user_id),
                });
            },
        },

        "/logout": {
            OPTIONS: preflight,
            POST: (request, _server, ctx) => {
                const token = request.cookies.get(REFRESH_COOKIE);
                const stored = token
                    ? db.findRefreshToken(sha256(token))
                    : null;
                if (stored) db.revokeRefreshToken(stored.id);
                ctx.userId = stored?.user_id;
                ctx.log.info(
                    "logged out",
                    stored ? { userId: stored.user_id } : {},
                );
                clearRefreshCookie(request);
                return new Response(null, {
                    status: 204,
                    headers: corsHeaders,
                });
            },
        },

        "/me": {
            OPTIONS: preflight,
            GET: async (request, _server, ctx) => {
                const header = request.headers.get("authorization") ?? "";
                const token = header.startsWith("Bearer ")
                    ? header.slice(7)
                    : "";
                const payload = await jwtVerify(token, key.publicKey, {
                    issuer: config.issuer,
                    algorithms: [ALG],
                })
                    .then((result) => result.payload)
                    .catch(() => null);
                const user = payload?.sub ? db.findUserById(payload.sub) : null;
                if (!user) {
                    return json({ error: "Unauthorized" }, 401);
                }
                ctx.userId = user.id;
                return json({ id: user.id, email: user.email });
            },
        },

        "/.well-known/jwks.json": {
            GET: () =>
                Response.json(
                    { keys: [key.publicJwk] },
                    { headers: { "Cache-Control": "public, max-age=300" } },
                ),
        },
    });
}
