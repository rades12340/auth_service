import { join } from "node:path";
import { openDb } from "./db";
import { loadSigningKey } from "./keys";
import { type AuthConfig, createRoutes } from "./routes";

export type ServerOptions = Partial<AuthConfig> & {
    port?: number;
    dbPath?: string;
    privateJwk?: string;
};

export async function startServer(options: ServerOptions = {}) {
    const env = process.env;
    const privateJwk = options.privateJwk ?? env.AUTH_PRIVATE_KEY;
    if (!privateJwk) {
        throw new Error(
            "Missing AUTH_PRIVATE_KEY. Run `bun run gen-key >> .env`.",
        );
    }

    const port = options.port ?? Number(env.PORT ?? 4000);
    const config: AuthConfig = {
        db:
            options.db ??
            openDb(
                options.dbPath ??
                    env.DB_PATH ??
                    join(import.meta.dir, "..", "auth.sqlite"),
            ),
        key: options.key ?? (await loadSigningKey(privateJwk)),
        issuer: options.issuer ?? env.AUTH_ISSUER ?? `http://localhost:${port}`,
        audience:
            options.audience ??
            (env.AUTH_AUDIENCE ?? "blob_storage,todos_service").split(","),
        corsOrigin:
            options.corsOrigin ?? env.CORS_ORIGIN ?? "http://localhost:5173",
        accessTtlSeconds: options.accessTtlSeconds ?? 15 * 60,
        refreshTtlSeconds: options.refreshTtlSeconds ?? 14 * 24 * 60 * 60,
        cookieSecure: options.cookieSecure ?? env.COOKIE_SECURE !== "false",
        rateLimit: options.rateLimit ?? { limit: 20, windowMs: 60_000 },
    };

    return Bun.serve({
        port,
        routes: createRoutes(config),
        fetch() {
            return Response.json({ error: "Not found" }, { status: 404 });
        },
    });
}

if (import.meta.main) {
    const server = await startServer();
    console.log(`Auth service running at ${server.url}`);
}
