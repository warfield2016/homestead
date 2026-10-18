import { FarcasterNetwork } from "@farcaster/core";

// All configuration comes from environment variables so the same image runs in Docker
// on your server and locally during development.

function env(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value !== undefined && value !== "") return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing environment variable ${name}`);
}

const networkName = env("HOMESTEAD_NETWORK", "mainnet").toLowerCase();

export const config = {
  /** Your Snapchain node's HTTP API. Never a third-party endpoint. */
  hubUrl: env("HUB_URL", "http://127.0.0.1:3381"),
  network: networkName === "testnet" ? FarcasterNetwork.TESTNET : FarcasterNetwork.MAINNET,
  networkName,
  port: Number(env("PORT", "8080")),
  host: env("HOST", "0.0.0.0"),
  dataDir: env("DATA_DIR", "./data"),
  /** Set when the client is served over HTTPS (Caddy in front), so cookies get the Secure flag. */
  secureCookies: env("SECURE_COOKIES", "false") === "true",
  /**
   * Read-only demo mode for development: no login, no writes. Lets you point the UI at any
   * node to check rendering. Never enable this on a client that holds a key.
   */
  demo: env("HOMESTEAD_DEMO", "false") === "true",
  /** Sliding lifetime of the app key, refreshed every time it signs. Max 90 days. */
  keyTtlSeconds: Number(env("KEY_TTL_DAYS", "30")) * 24 * 60 * 60,
  /** How many recent casts to backfill per followed account when the feed starts. */
  backfillPerAccount: Number(env("BACKFILL_PER_ACCOUNT", "10")),
};
