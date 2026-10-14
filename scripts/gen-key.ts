import { exportJWK, generateKeyPair } from "jose";
import { ALG } from "../src/keys";

// Prints a fresh Ed25519 signing key as a line for .env:
//   bun run gen-key >> .env
export async function generatePrivateJwk() {
    const { privateKey } = await generateKeyPair(ALG, { extractable: true });
    const jwk = await exportJWK(privateKey);
    return JSON.stringify({ ...jwk, kid: crypto.randomUUID(), alg: ALG });
}

if (import.meta.main) {
    console.log(`AUTH_PRIVATE_KEY='${await generatePrivateJwk()}'`);
}
