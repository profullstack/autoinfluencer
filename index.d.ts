import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface PlatformSpec {
  id: string;
  name: string;
  limit: number;
  ideal: number;
  title?: number;
  hashtags: { max: number; style: 'inline' | 'trailing' | 'none' };
  links: { max: number; penalized?: boolean };
  threads: boolean;
  media?: 'required';
  notes: string;
}

export interface Persona {
  name: string;
  handle?: string;
  bio?: string;
  niche: string;
  audience: string;
  voice: string;
  pillars: string[];
  platforms: string[];
  links?: Record<string, string>;
  cta?: string;
  avoid?: string[];
  examples?: string[];
  /** Append `disclosure` to original posts. Default true. */
  disclose?: boolean;
  disclosure?: string;
  timezone?: string;
  postingHours?: number[];
  /** Share of original posts; the rest are replies to others. Default 0.25. */
  mix?: { own: number; engage?: number };
  [key: string]: unknown;
}

export type Mode = 'auto' | 'ai' | 'brief';
export interface AiLike {
  generateObject(req: Record<string, unknown>): Promise<{ object: any; provider?: string; model?: string }>;
}
export interface GenOptions {
  mode?: Mode;
  ai?: AiLike;
  timeoutMs?: number;
  blockPrivate?: boolean;
}
export interface Brief { mode: 'brief'; brief: string; note?: string; platforms?: string[] }

export interface LintResult { ok: boolean; errors: string[]; warnings: string[]; length: number; limit: number }
export interface Post {
  platform: string;
  kind: 'own' | 'engage';
  text: string;
  title?: string;
  thread?: string[];
  lint: LintResult;
}
export interface Idea { hook: string; angle?: string; pillar?: string; format?: string }
export interface Slot { at: string; platform: string; kind: 'own' | 'engage'; pillar?: string; task: string; idea?: Idea }

export const PLATFORMS: Record<string, PlatformSpec>;
export function platformId(name: string): string;
export function getPlatform(name: string): PlatformSpec;
export function listPlatforms(): PlatformSpec[];
export function graphemes(text: string): number;
export function truncate(text: string, max: number): string;
export function toThread(text: string, platform: string): string[];

export function homeDir(env?: Record<string, string | undefined>): string;
export function defaultPersonaPath(env?: Record<string, string | undefined>): string;
export function examplePersona(): Persona;
export function normalizePersona(input: Partial<Persona>): Persona;
export function parsePersona(text: string): Partial<Persona>;
export function loadPersona(source?: string | Partial<Persona>, env?: Record<string, string | undefined>): Promise<Persona>;
export function savePersona(persona: Partial<Persona>, path?: string): Promise<string>;

export const BAIT: string[];
export function lintPost(post: { platform: string; text: string; title?: string; kind?: string }, persona?: Persona | null, opts?: { recent?: string[] }): LintResult;
export function withDisclosure(text: string, persona: Persona, platform: string): string;

export const FREE_C0MPUTE_MODELS: string[];
export function ideas(persona: Partial<Persona>, opts?: GenOptions & { count?: number; topic?: string; pillar?: string }): Promise<{ mode: 'ai'; ideas: Idea[]; provider?: string; model?: string } | Brief>;
export function draft(persona: Partial<Persona>, opts: GenOptions & { topic?: string; source?: string; link?: string; platforms?: string[]; recent?: string[] }): Promise<{ mode: 'ai'; posts: Post[]; provider?: string; model?: string } | Brief>;
export function repurpose(persona: Partial<Persona>, opts: GenOptions & { url?: string; text?: string; link?: string; platforms?: string[] }): Promise<{ mode: 'ai'; posts: Post[] } | Brief>;
export function reply(persona: Partial<Persona>, opts: GenOptions & { post: string; platform?: string; author?: string; goal?: string }): Promise<({ mode: 'ai'; why?: string } & Post) | Brief>;
export function calendar(persona: Partial<Persona>, opts?: GenOptions & { days?: number; perDay?: number; start?: string; withIdeas?: boolean }): Promise<{ slots: Slot[]; timezone: 'UTC'; ideas?: Brief }>;
export function finishPosts(persona: Persona, posts: Array<{ platform: string; text: string; title?: string; kind?: string }>, opts?: { recent?: string[] }): Post[];
export function fetchText(url: string, opts?: { fetch?: typeof fetch; maxChars?: number; blockPrivate?: boolean }): Promise<{ title?: string; text: string }>;
export function assertPublicHost(hostname: string): Promise<void>;
export function isPrivateIp(ip: string): boolean;

export interface QueueItem { id: string; at: string; platform: string; text: string; title?: string; subreddit?: string; kind: string; status: 'queued' | 'sent' | 'failed'; attempts: number; result?: unknown; error?: string }
export function queuePath(env?: Record<string, string | undefined>): string;
export function enqueue(posts: Partial<QueueItem> | Partial<QueueItem>[], opts?: { path?: string; now?: Date }): Promise<QueueItem[]>;
export function listQueue(opts?: { path?: string; status?: QueueItem['status'] }): Promise<QueueItem[]>;
export function recentTexts(opts?: { path?: string; days?: number; now?: Date }): Promise<string[]>;
export function removeFromQueue(id: string, opts?: { path?: string }): Promise<number>;
export function runDue(publish: (item: QueueItem) => Promise<unknown>, opts?: { path?: string; now?: Date; limit?: number; perPlatform?: number; maxAttempts?: number; dryRun?: boolean }): Promise<Array<{ id: string; platform: string; status: string; error?: string; result?: unknown }>>;

export function loadConfig(env?: Record<string, string | undefined>): Promise<any>;
export function signWebhook(secret: string, body: string, opts?: { id?: string; timestamp?: number }): Record<string, string>;
export function createPublisher(config: any, opts?: { fetch?: typeof fetch; log?: (s: string) => void }): (item: QueueItem) => Promise<unknown>;

export interface Tool {
  name: string;
  title: string;
  description: string;
  input: Record<string, unknown>;
  annotations?: Record<string, boolean>;
  handler(args: any, ctx?: any): Promise<any>;
}
export function createTools(opts?: { local?: boolean; ai?: AiLike; resolvePersona?: (input: any, ctx: any) => Promise<Persona>; blockPrivate?: boolean; env?: Record<string, string | undefined> }): Tool[];
export function inputJsonSchema(tool: Tool): Record<string, unknown>;

export const VERSION: string;
export function createMcpServer(opts?: Record<string, unknown>): McpServer;
export function serveStdio(opts?: Record<string, unknown>): Promise<McpServer>;
export function handleMcpHttp(req: IncomingMessage, res: ServerResponse, body: unknown, opts?: Record<string, unknown>): Promise<void>;

export interface HandlerOptions {
  tools?: Tool[];
  local?: boolean;
  baseUrl?: string;
  cors?: string;
  info?: Record<string, unknown>;
  authenticate?: (req: IncomingMessage) => Promise<any>;
  unauthorized?: (req: IncomingMessage, res: ServerResponse) => unknown;
  gate?: (req: IncomingMessage, res: ServerResponse, x: { tool: Tool; ctx: any; args: any }) => Promise<boolean | void>;
  fallback?: (req: IncomingMessage, res: ServerResponse) => unknown;
}
export function createHandler(opts?: HandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
export function serve(opts?: HandlerOptions & { port?: number; host?: string }): Promise<Server>;
export function openapi(tools: Tool[], serverUrl: string, info?: Record<string, unknown>): Record<string, unknown>;
export function json(res: ServerResponse, status: number, body: unknown): void;
export function readJson(req: IncomingMessage, limit?: number): Promise<any>;
