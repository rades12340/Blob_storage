import { errors, type JWTVerifyGetKey, jwtVerify } from "jose";

// Why a request was turned away; logged, never sent to the client.
// "key fetch failed" means auth_service's public keys couldn't be loaded,
// so the token was never actually checked.
export type AuthFailure = {
    reason:
        | "missing"
        | "malformed"
        | "expired"
        | "invalid signature"
        | "wrong audience"
        | "invalid claims"
        | "key fetch failed";
    error?: string;
};

export type Verify = (
    request: Request,
) => Promise<{ userId: string } | AuthFailure>;

// jose's errors while loading the JWKS: timeouts, bad JSON and non-200
// responses. Network errors come through as plain (non-jose) errors.
const KEY_FETCH_CODES = new Set([
    errors.JWKSTimeout.code,
    errors.JWKSInvalid.code,
    errors.JOSEError.code,
]);

function failure(error: unknown): AuthFailure {
    if (
        !(error instanceof errors.JOSEError) ||
        KEY_FETCH_CODES.has(error.code)
    ) {
        return { reason: "key fetch failed", error: String(error) };
    }
    if (error instanceof errors.JWTExpired) return { reason: "expired" };
    if (error instanceof errors.JWTClaimValidationFailed) {
        return {
            reason: error.claim === "aud" ? "wrong audience" : "invalid claims",
        };
    }
    if (
        error instanceof errors.JWSSignatureVerificationFailed ||
        error instanceof errors.JWKSNoMatchingKey
    ) {
        return { reason: "invalid signature" };
    }
    return { reason: "malformed" };
}

// Checks the `Authorization: Bearer <jwt>` header against the auth service's
// public keys. `keys` is usually createRemoteJWKSet(<auth>/.well-known/jwks.json),
// which fetches once and caches.
export function createVerifier({
    keys,
    issuer,
    audience,
}: {
    keys: JWTVerifyGetKey;
    issuer: string;
    audience: string;
}): Verify {
    return async (request) => {
        const header = request.headers.get("authorization") ?? "";
        if (!header.startsWith("Bearer ")) return { reason: "missing" };

        try {
            const { payload } = await jwtVerify(header.slice(7), keys, {
                issuer,
                audience,
                algorithms: ["EdDSA"],
            });
            return payload.sub
                ? { userId: payload.sub }
                : { reason: "invalid claims" };
        } catch (error) {
            return failure(error);
        }
    };
}
