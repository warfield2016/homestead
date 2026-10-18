// Thin wrapper around the client server's JSON API. The browser never talks to the node
// directly: your server does, and it holds the app key.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: method === "GET" ? {} : { "Content-Type": "application/json", "X-Homestead": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new ApiError(response.status, data.error ?? `HTTP ${response.status}`);
  return data as T;
}

export const api = {
  get: <T>(path: string) => call<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => call<T>("POST", path, body),
  put: <T>(path: string, body: unknown) => call<T>("PUT", path, body),
};

export interface Profile {
  fid: number;
  username?: string;
  displayName?: string;
  pfp?: string;
  bio?: string;
  url?: string;
}

export type Segment = { text: string } | { mention: number };

export interface Cast {
  hash: string;
  fid: number;
  timestamp: number;
  text: string;
  segments: Segment[];
  embeds: Array<{ url?: string; castId?: { fid: number; hash: string } }>;
  parent?: { fid: number; hash: string };
  parentUrl?: string;
  mentions: number[];
  signer: string;
  app?: number;
  liked: boolean;
  recasted: boolean;
}

export interface CastPage {
  casts: Cast[];
  profiles: Record<string, Profile>;
  cursor?: string | null;
  following?: number;
}

export interface NodeStatus {
  reachable: boolean;
  error?: string;
  version?: string;
  peerId?: string;
  messages?: number;
  fids?: number;
  sizeBytes?: number;
  synced?: boolean;
  shards?: Array<{ id: number; height: number; delay: number; messages: number }>;
}

export interface Status {
  demo: boolean;
  network: string;
  loggedIn: boolean;
  passwordSet: boolean;
  node: NodeStatus;
  account: null | { fid: number; shard?: number; publicKey?: string; addedAt?: string; scopes?: number[]; ttl?: number; demo?: boolean; profile?: Profile };
}

export interface Receipt {
  hash: string;
  kind: string;
  summary: string;
  submittedAt: number;
  acceptedAt?: number;
  includedAt?: number;
  block?: { shard: number; height: number };
  error?: string;
}

export interface TypedDataRequest {
  domain: { name: string; version: string; chainId: number };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: "SignedKeyRequest" | "KeyAdd";
  message: Record<string, string | number | number[]>;
}
