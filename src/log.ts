// One JSON object per line on stdout, so `docker logs` and log shippers can
// parse it. Never pass secrets in fields: tokens, passwords, cookies, keys.
export type LogFields = Record<string, unknown>;

export type Logger = {
    debug: (message: string, fields?: LogFields) => void;
    info: (message: string, fields?: LogFields) => void;
    warn: (message: string, fields?: LogFields) => void;
    error: (message: string, fields?: LogFields) => void;
};

const LEVELS = ["debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

export function createLogger({
    service,
    level = process.env.LOG_LEVEL,
    write = console.log,
}: {
    service: string;
    level?: string;
    write?: (line: string) => void;
}): Logger {
    const configured = LEVELS.indexOf(level as Level);
    const min = configured === -1 ? LEVELS.indexOf("info") : configured;
    const at = (lvl: Level) => (message: string, fields?: LogFields) => {
        if (LEVELS.indexOf(lvl) < min) return;
        write(
            JSON.stringify({
                time: new Date().toISOString(),
                level: lvl,
                service,
                message,
                ...fields,
            }),
        );
    };
    return {
        debug: at("debug"),
        info: at("info"),
        warn: at("warn"),
        error: at("error"),
    };
}
