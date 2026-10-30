import type { LogFields, Logger } from "./log";

// What a handler knows about the request it's serving. Handlers set
// `userId` once the caller is authenticated, so the access line carries it.
export type RequestContext = {
    requestId: string;
    log: Logger;
    userId?: string;
};

export type Handler<R extends Request = Request> = (
    request: R,
    ctx: RequestContext,
) => Response | Promise<Response>;

// The gateway forwards its id; anything else (or nothing) gets a fresh one,
// so a client can't stuff arbitrary text into our logs.
const requestIdPattern = /^[A-Za-z0-9._-]{1,128}$/;

function requestIdFor(request: Request) {
    const id = request.headers.get("x-request-id");
    return id && requestIdPattern.test(id) ? id : crypto.randomUUID();
}

function withFields(log: Logger, bound: LogFields): Logger {
    return {
        debug: (message, fields) => log.debug(message, { ...bound, ...fields }),
        info: (message, fields) => log.info(message, { ...bound, ...fields }),
        warn: (message, fields) => log.warn(message, { ...bound, ...fields }),
        error: (message, fields) => log.error(message, { ...bound, ...fields }),
    };
}

// Gives the handler a logger tagged with the request id, echoes the id in
// X-Request-Id and writes one access line. `route` is the pattern, never the
// raw URL, so ids and query strings stay out of it.
export function withRequestLog<R extends Request>(
    log: Logger,
    route: string,
    handler: Handler<R>,
) {
    return async (request: R): Promise<Response> => {
        const start = performance.now();
        const requestId = requestIdFor(request);
        const ctx: RequestContext = {
            requestId,
            log: withFields(log, { requestId }),
        };

        let response: Response;
        try {
            response = await handler(request, ctx);
        } catch (error) {
            ctx.log.error("unhandled error", { error: String(error) });
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
            ...(ctx.userId && { userId: ctx.userId }),
        });
        return response;
    };
}

// Wraps every method of a route.
export function logRoute<
    P extends string,
    H extends Record<string, Handler<Bun.BunRequest<P>>>,
>(log: Logger, route: P, handlers: H) {
    return Object.fromEntries(
        Object.entries(handlers).map(([method, handler]) => [
            method,
            withRequestLog(log, route, handler),
        ]),
    ) as { [M in keyof H]: (request: Bun.BunRequest<P>) => Promise<Response> };
}
