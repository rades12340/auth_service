import { type CryptoKey, importJWK, type JWK } from "jose";

export const ALG = "EdDSA";

export type SigningKey = {
    kid: string;
    privateKey: CryptoKey;
    publicKey: CryptoKey;
    publicJwk: JWK;
};

// Takes the private key as a JSON-encoded JWK (the format scripts/gen-key.ts prints).
export async function loadSigningKey(
    privateJwkJson: string,
): Promise<SigningKey> {
    const jwk: JWK = JSON.parse(privateJwkJson);
    if (!jwk.kid || !jwk.d) {
        throw new Error("AUTH_PRIVATE_KEY must be a private JWK with a kid");
    }

    const { d: _private, ...publicFields } = jwk;
    const publicJwk: JWK = { ...publicFields, alg: ALG, use: "sig" };

    return {
        kid: jwk.kid,
        privateKey: (await importJWK(jwk, ALG)) as CryptoKey,
        publicKey: (await importJWK(publicJwk, ALG)) as CryptoKey,
        publicJwk,
    };
}
