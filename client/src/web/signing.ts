// Signing the app-key authorization, in the browser.
//
// This module is the only code that ever sees a recovery phrase, and it runs only in your
// browser tab. The phrase is turned into the custody account in memory, used for exactly two
// EIP-712 signatures, and dropped. Only the signatures go to the server.
//
// Before signing anything we check that the payload is one of the two gasless key payloads on
// snapchain's "Farcaster KeyAdd" domain. A compromised server therefore can't use this page to
// get a signature for something dangerous, like transferring your account.

import type { TypedDataRequest } from "./api.js";

const ALLOWED_DOMAIN = { name: "Farcaster KeyAdd", version: "1", chainId: 1 };
const ALLOWED_TYPES: Record<string, string[]> = {
  SignedKeyRequest: ["requestFid", "key", "deadline"],
  KeyAdd: ["fid", "key", "keyType", "scopes", "ttl", "nonce", "deadline"],
};

export function assertSafeToSign(request: TypedDataRequest): void {
  const { domain, primaryType, types } = request;
  const domainOk =
    domain.name === ALLOWED_DOMAIN.name && domain.version === ALLOWED_DOMAIN.version && domain.chainId === ALLOWED_DOMAIN.chainId && !("verifyingContract" in domain);
  const expected = ALLOWED_TYPES[primaryType];
  const fields = types[primaryType]?.map((f) => f.name) ?? [];
  const typesOk = expected !== undefined && Object.keys(types).length === 1 && fields.join() === expected.join();
  if (!domainOk || !typesOk) throw new Error("Refusing to sign: this is not a Farcaster app-key request.");
}

/** viem wants bigints for uint256 fields; JSON carried them as decimal strings. */
function typedMessage(request: TypedDataRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of request.types[request.primaryType] ?? []) {
    const value = request.message[field.name];
    out[field.name] = field.type === "uint256" ? BigInt(value as string) : value;
  }
  return out;
}

export async function addressFromPhrase(phrase: string, accountIndex: number): Promise<string> {
  const { mnemonicToAccount } = await import("viem/accounts");
  return mnemonicToAccount(normalizePhrase(phrase), { accountIndex }).address;
}

export async function signWithPhrase(phrase: string, accountIndex: number, requests: TypedDataRequest[]): Promise<string[]> {
  const { mnemonicToAccount } = await import("viem/accounts");
  const account = mnemonicToAccount(normalizePhrase(phrase), { accountIndex });
  const signatures: string[] = [];
  for (const request of requests) {
    assertSafeToSign(request);
    signatures.push(
      await account.signTypedData({
        domain: request.domain,
        types: request.types,
        primaryType: request.primaryType,
        message: typedMessage(request),
      } as Parameters<typeof account.signTypedData>[0]),
    );
  }
  return signatures;
}

export function normalizePhrase(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).join(" ");
}

export function phraseLooksValid(phrase: string): boolean {
  const words = normalizePhrase(phrase).split(" ");
  return [12, 15, 18, 21, 24].includes(words.length) && words.every((w) => /^[a-z]+$/.test(w));
}

// --- browser wallet (the phrase never touches Homestead) ----------------------------------

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

function wallet(): Eip1193 {
  const provider = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  if (!provider) throw new Error("No browser wallet found. Install one (or open this page in your wallet's browser).");
  return provider;
}

export async function walletAddress(): Promise<string> {
  const accounts = (await wallet().request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts[0]) throw new Error("The wallet didn't share an address.");
  return accounts[0];
}

export async function signWithWallet(address: string, requests: TypedDataRequest[]): Promise<string[]> {
  const provider = wallet();
  // Wallets refuse typed data whose domain chainId differs from the active chain. The domain
  // says chainId 1; nothing is sent onchain, this only changes what the wallet displays.
  await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] }).catch(() => undefined);
  const signatures: string[] = [];
  for (const request of requests) {
    assertSafeToSign(request);
    const payload = {
      domain: request.domain,
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
        ],
        ...request.types,
      },
      primaryType: request.primaryType,
      message: request.message,
    };
    signatures.push((await provider.request({ method: "eth_signTypedData_v4", params: [address, JSON.stringify(payload)] })) as string);
  }
  return signatures;
}
