// Structured logging: every call writes one JSON line. Same contract as
// auth_service and the API gateway, so their logs can be read together.
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
    // Lines below this level are dropped. Unknown values mean "info".
    level?: string;
    write?: (line: string) => void;
}): Logger {
    const index = LEVELS.indexOf(level as Level);
    const min = index === -1 ? 1 : index;
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
