import { Database } from "bun:sqlite";

export type User = { id: string; email: string; password_hash: string };

export type RefreshToken = {
    id: string;
    user_id: string;
    expires_at: number;
    revoked_at: number | null;
};

export function openDb(path: string) {
    const db = new Database(path, { create: true, strict: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS refresh_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
    )`);

    return {
        createUser(email: string, passwordHash: string): User {
            const user = {
                id: crypto.randomUUID(),
                email,
                password_hash: passwordHash,
            };
            db.query(
                "INSERT INTO users (id, email, password_hash, created_at) VALUES ($id, $email, $password_hash, $now)",
            ).run({ ...user, now: Date.now() });
            return user;
        },

        findUserByEmail(email: string) {
            return db
                .query<User, [string]>(
                    "SELECT id, email, password_hash FROM users WHERE email = ?",
                )
                .get(email);
        },

        findUserById(id: string) {
            return db
                .query<User, [string]>(
                    "SELECT id, email, password_hash FROM users WHERE id = ?",
                )
                .get(id);
        },

        insertRefreshToken(
            userId: string,
            tokenHash: string,
            expiresAt: number,
        ) {
            db.query(
                "INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
            ).run(crypto.randomUUID(), userId, tokenHash, expiresAt);
        },

        findRefreshToken(tokenHash: string) {
            return db
                .query<RefreshToken, [string]>(
                    "SELECT id, user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = ?",
                )
                .get(tokenHash);
        },

        revokeRefreshToken(id: string) {
            db.query(
                "UPDATE refresh_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
            ).run(Date.now(), id);
        },

        revokeAllForUser(userId: string) {
            db.query(
                "UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
            ).run(Date.now(), userId);
        },

        close() {
            db.close();
        },
    };
}

export type Db = ReturnType<typeof openDb>;
