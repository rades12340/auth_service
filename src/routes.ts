import { jwtVerify, SignJWT } from "jose";
import type { Db } from "./db";
import { docsRoutes } from "./docs";
import { ALG, type SigningKey } from "./keys";
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
};

const REFRESH_COOKIE = "refresh_token";
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Compared against when the email is unknown, so a failed login takes the same
// time whether or not the account exists.
const dummyHash = await Bun.password.hash("timing-equalizer");

const sha256 = (value: string) =>
    new Bun.CryptoHasher("sha256").update(value).digest("hex");

export function createRoutes(config: AuthConfig) {
    const { db, key } = config;
    const allow = createRateLimiter(config.rateLimit);

    const corsHeaders = {
        "Access-Control-Allow-Origin": config.corsOrigin,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

    function rateLimited(request: Request, server: Bun.Server<unknown>) {
        return !allow(clientIp(request, server));
    }

    return {
        ...docsRoutes,

        "/register": {
            OPTIONS: preflight,
            POST: async (
                request: Bun.BunRequest,
                server: Bun.Server<unknown>,
            ) => {
                if (rateLimited(request, server)) {
                    return json({ error: "Too many requests" }, 429);
                }
                const { email, password } = await readCredentials(request);
                if (!emailPattern.test(email) || email.length > 254) {
                    return json({ error: "Invalid email" }, 400);
                }
                if (password.length < 8 || password.length > 256) {
                    return json(
                        { error: "Password must be 8-256 characters" },
                        400,
                    );
                }
                if (db.findUserByEmail(email)) {
                    return json({ error: "Email already registered" }, 409);
                }

                const user = db.createUser(
                    email,
                    await Bun.password.hash(password),
                );
                return json({ id: user.id, email: user.email }, 201);
            },
        },

        "/login": {
            OPTIONS: preflight,
            POST: async (
                request: Bun.BunRequest,
                server: Bun.Server<unknown>,
            ) => {
                if (rateLimited(request, server)) {
                    return json({ error: "Too many requests" }, 429);
                }
                const { email, password } = await readCredentials(request);
                const user = db.findUserByEmail(email);
                const valid = await Bun.password.verify(
                    password,
                    user?.password_hash ?? dummyHash,
                );
                if (!user || !valid) {
                    return json({ error: "Invalid email or password" }, 401);
                }

                issueRefreshToken(request, user.id);
                return json({ accessToken: await signAccessToken(user.id) });
            },
        },

        "/refresh": {
            OPTIONS: preflight,
            POST: async (request: Bun.BunRequest) => {
                const token = request.cookies.get(REFRESH_COOKIE);
                const stored = token
                    ? db.findRefreshToken(sha256(token))
                    : null;
                if (!stored) {
                    clearRefreshCookie(request);
                    return json({ error: "Not logged in" }, 401);
                }
                if (stored.revoked_at !== null) {
                    // A rotated-out token was used again: it was probably stolen.
                    // Log the user out everywhere.
                    db.revokeAllForUser(stored.user_id);
                    clearRefreshCookie(request);
                    return json({ error: "Not logged in" }, 401);
                }
                if (stored.expires_at <= Date.now()) {
                    clearRefreshCookie(request);
                    return json({ error: "Session expired" }, 401);
                }

                db.revokeRefreshToken(stored.id);
                issueRefreshToken(request, stored.user_id);
                return json({
                    accessToken: await signAccessToken(stored.user_id),
                });
            },
        },

        "/logout": {
            OPTIONS: preflight,
            POST: (request: Bun.BunRequest) => {
                const token = request.cookies.get(REFRESH_COOKIE);
                const stored = token
                    ? db.findRefreshToken(sha256(token))
                    : null;
                if (stored) db.revokeRefreshToken(stored.id);
                clearRefreshCookie(request);
                return new Response(null, {
                    status: 204,
                    headers: corsHeaders,
                });
            },
        },

        "/me": {
            OPTIONS: preflight,
            GET: async (request: Request) => {
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
    };
}
