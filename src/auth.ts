import { type JWTVerifyGetKey, jwtVerify } from "jose";

export type Verify = (request: Request) => Promise<{ userId: string } | null>;

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
        if (!header.startsWith("Bearer ")) return null;

        try {
            const { payload } = await jwtVerify(header.slice(7), keys, {
                issuer,
                audience,
                algorithms: ["EdDSA"],
            });
            return payload.sub ? { userId: payload.sub } : null;
        } catch {
            return null;
        }
    };
}
