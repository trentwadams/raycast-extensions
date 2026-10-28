import { execFile, spawn } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { getPreferenceValues, LocalStorage, open } from "@raycast/api";
import { openRpc, RpcConnection } from "./rpc";
import { DEFAULT_SNOOZE_PRESETS, SnoozePresetSetting } from "./thread-state";

const run = promisify(execFile);

export type ModelSelection = {
  instanceId: string;
  model: string;
  options?: { id: string; value: string | boolean | number }[];
};

export type RuntimeMode =
  "approval-required" | "auto-accept-edits" | "auto" | "full-access";

/** Where a new thread runs. T3 calls this the thread's environment. */
export type ThreadEnvMode = "local" | "worktree";

export const RUNTIME_MODES: { value: RuntimeMode; label: string }[] = [
  { value: "full-access", label: "Full access" },
  { value: "auto", label: "Auto" },
  { value: "auto-accept-edits", label: "Auto-accept edits" },
  { value: "approval-required", label: "Approval required" },
];

export type Project = {
  id: string;
  title: string;
  workspaceRoot: string;
  defaultModelSelection: ModelSelection | null;
  defaultThreadEnvMode: ThreadEnvMode | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type LatestTurn = {
  turnId: string;
  state: "running" | "interrupted" | "completed" | "error";
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type Thread = {
  id: string;
  projectId: string;
  title: string;
  modelSelection: ModelSelection | null;
  runtimeMode: RuntimeMode;
  interactionMode: "default" | "plan";
  branch: string | null;
  worktreePath: string | null;
  latestTurn: LatestTurn | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  settledAt: string | null;
  snoozedUntil: string | null;
  deletedAt: string | null;
  session: {
    status: string;
    activeTurnId: string | null;
    lastError: string | null;
  } | null;
  /** Protocol v2 replaced latestTurn and session with these. */
  status?: string;
  activeRunId?: string | null;
  lastError?: string | null;
  /** Protocol v2 run, request and sidebar state; thread-state.ts reads them the way
   * T3's sidebar does. */
  latestRunId?: string | null;
  latestRunCompletedAt?: string | null;
  activityRunStatus?: string | null;
  activeProviderThreadId?: string | null;
  blockedOnThreadWait?: boolean;
  pendingRuntimeRequest?: {
    id: string;
    kind: string;
    createdAt: string;
    blocking?: boolean;
  } | null;
  pendingGuestMessageCount?: number;
  pendingBackgroundTasks?: { kind: string; awaited?: boolean }[];
  hasActionableProposedPlan?: boolean;
  settledOverride?: "settled" | "active" | null;
  snoozedAt?: string | null;
  pinnedAt?: string | null;
  lastVisitedAt?: string | null;
  lineage?: { relationshipToParent?: string | null };
};

export type ShellSnapshot = {
  snapshotSequence: number;
  projects: Project[];
  threads: Thread[];
  updatedAt: string;
};

type EnvironmentDescriptor = {
  /** The id the desktop app routes threads under: /<environmentId>/<threadId>. */
  environmentId?: string;
  /** The server's own name for its machine, e.g. the host name. */
  label?: string;
  serverVersion?: string;
  /** Absent on servers that predate protocol v2. */
  orchestrationProtocolVersion?: number;
  /** What this server can do, e.g. threadSnooze, threadPinning, threadStop. */
  capabilities?: Record<string, unknown>;
};

/** The server is unreachable, the token is rejected, or the request failed. Commands
 * branch on `kind` to decide whether offering "Launch T3 Code" makes sense. */
export class T3Error extends Error {
  constructor(
    readonly kind: "unreachable" | "unauthorized" | "http" | "insecure-origin",
    message: string,
  ) {
    super(message);
  }
}

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** A couple of words on why an environment could not be read, short enough for a
 * tag or the status subtitle. */
export function failureSummary(error: unknown): string {
  if (!(error instanceof T3Error)) {
    return "failed";
  }
  switch (error.kind) {
    case "unreachable":
      return "offline";
    case "unauthorized":
      return "token rejected";
    case "insecure-origin":
      return "needs https";
    default:
      return "failed";
  }
}

export const RUNTIME_DIR = join(homedir(), ".t3", "userdata");
export const WORKTREES_DIR = join(homedir(), ".t3", "worktrees");

const preferences = () => getPreferenceValues<Preferences>();

/** One T3 Code server the extension talks to. Every request names the environment it
 * goes to, so a thread is always acted on by the server it lives on. */
export type Environment = {
  /** Stable across runs and edits, since presets and the last-used project store it. */
  key: string;
  /** The name given to it. Empty means the server's own label is used. */
  name: string;
  origin: string;
  token: string;
};

/** The original Access Token and Server Origin preferences, so existing setups keep
 * working with nothing to migrate. */
export const PRIMARY_ENVIRONMENT = "primary";

/** Preferences hold a fixed set of fields, so every environment beyond the primary
 * lives in local storage, which Raycast keeps in its encrypted database. */
const STORED_ENVIRONMENTS_KEY = "environments";

export const trimOrigin = (origin: string) => origin.trim().replace(/\/+$/, "");

/** The environments added beyond the primary, in the order they were arranged. A
 * malformed entry is skipped rather than failing every command. */
export async function loadStoredEnvironments(): Promise<Environment[]> {
  const raw = await LocalStorage.getItem<string>(STORED_ENVIRONMENTS_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Environment>[];
    return Array.isArray(parsed)
      ? parsed.flatMap(({ key, name, origin, token } = {}) =>
          typeof key === "string" &&
          typeof origin === "string" &&
          typeof token === "string"
            ? [
                {
                  key,
                  name: typeof name === "string" ? name : "",
                  origin,
                  token,
                },
              ]
            : [],
        )
      : [];
  } catch {
    return [];
  }
}

export const storeEnvironments = (environments: Environment[]) =>
  LocalStorage.setItem(STORED_ENVIRONMENTS_KEY, JSON.stringify(environments));

/** Every configured environment: the primary first, then the stored ones. */
export async function loadEnvironments(): Promise<Environment[]> {
  const [primary, stored] = await Promise.all([
    primaryEnvironment(),
    loadStoredEnvironments(),
  ]);
  return [primary, ...stored];
}

async function primaryEnvironment(): Promise<Environment> {
  const prefs = preferences();
  return {
    key: PRIMARY_ENVIRONMENT,
    name: prefs.name?.trim() ?? "",
    origin: await resolveOrigin(),
    token: prefs.token,
  };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isLoopback(origin: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** The token is a long-lived credential for the local T3 server, so it only ever
 * travels to loopback or over TLS. A plain-http remote origin is refused rather
 * than silently leaking the bearer to whoever is on the wire. */
function assertTokenSafeOrigin(origin: string): void {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new T3Error(
      "insecure-origin",
      `"${origin}" is not a valid server origin.`,
    );
  }
  if (url.protocol === "https:" || LOOPBACK_HOSTS.has(url.hostname)) {
    return;
  }
  throw new T3Error(
    "insecure-origin",
    `Refusing to send the access token to ${url.origin} over plain HTTP. Use https:// or a loopback address.`,
  );
}

/** The primary environment's origin: a configured one wins, otherwise the running
 * server publishes its own port. The file survives restarts with a stale port, so a
 * failed fetch still means "not running". */
async function resolveOrigin(): Promise<string> {
  const configured = preferences().origin?.trim();
  if (configured) {
    return trimOrigin(configured);
  }
  try {
    const raw = await readFile(
      join(RUNTIME_DIR, "server-runtime.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as {
      origin?: string;
      host?: string;
      port?: number;
    };
    if (parsed.origin) {
      return trimOrigin(parsed.origin);
    }
    if (parsed.host && parsed.port) {
      return `http://${parsed.host}:${parsed.port}`;
    }
  } catch {
    // fall through to the loopback default
  }
  return "http://127.0.0.1:3773";
}

const PROTOCOL_HEADER = "x-t3-orchestration-protocol";

const descriptors = new Map<string, Promise<EnvironmentDescriptor>>();

/** The server describes itself once per command run. Cached per origin, so a server
 * that restarts on another port or version is asked again. */
function serverDescriptor(
  environment: Environment,
): Promise<EnvironmentDescriptor> {
  let descriptor = descriptors.get(environment.origin);
  if (!descriptor) {
    descriptor = request<EnvironmentDescriptor>(
      environment,
      "/.well-known/t3/environment",
      undefined,
      false,
    ).catch((error) => {
      descriptors.delete(environment.origin);
      throw error;
    });
    descriptors.set(environment.origin, descriptor);
  }
  return descriptor;
}

/** v2 servers reject orchestration reads without the protocol header; older servers
 * predate the field, so a missing value means v1. */
async function serverProtocolVersion(
  environment: Environment,
): Promise<number> {
  return (
    (await serverDescriptor(environment)).orchestrationProtocolVersion ?? 1
  );
}

/** The primary environment is set up in the preferences, every other one in the
 * Manage T3 Environments command, so an error points at the right place. */
const whereConfigured = (environment: Environment) =>
  environment.key === PRIMARY_ENVIRONMENT
    ? "the extension preferences"
    : "Manage T3 Environments";

async function request<T>(
  environment: Environment,
  path: string,
  init?: RequestInit,
  versioned = true,
): Promise<T> {
  const { origin, token } = environment;
  assertTokenSafeOrigin(origin);
  if (!token) {
    throw new T3Error(
      "unauthorized",
      `No access token is set for this environment. Add one in ${whereConfigured(environment)}.`,
    );
  }
  const version = versioned ? await serverProtocolVersion(environment) : 1;
  let response: Response;
  try {
    response = await fetch(`${origin}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(version >= 2 ? { [PROTOCOL_HEADER]: String(version) } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new T3Error(
      "unreachable",
      `Cannot reach the T3 Code server at ${origin}.`,
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new T3Error(
      "unauthorized",
      `T3 Code rejected the access token. Reissue it and update it in ${whereConfigured(environment)}.`,
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new T3Error(
      "http",
      `T3 Code returned ${response.status}. ${body.slice(0, 200)}`,
    );
  }
  return (await response.json()) as T;
}

/** v2 reports run state on the thread itself. Rebuild the v1 latestTurn so every
 * consumer keeps reading one shape. */
function normalizeThread(thread: Thread): Thread {
  if (thread.latestTurn !== undefined || thread.status === undefined) {
    return thread;
  }
  const state: LatestTurn["state"] | null =
    thread.activeRunId || thread.status === "running"
      ? "running"
      : thread.status === "failed" || thread.status === "error"
        ? "error"
        : thread.status === "interrupted"
          ? "interrupted"
          : null;
  return {
    ...thread,
    latestTurn: state && {
      turnId: thread.activeRunId ?? "",
      state,
      requestedAt: thread.updatedAt,
      startedAt: null,
      completedAt: null,
    },
    session: thread.lastError
      ? { status: "error", activeTurnId: null, lastError: thread.lastError }
      : null,
  };
}

export const getShell = async (
  environment: Environment,
): Promise<ShellSnapshot> => {
  const snapshot = await request<ShellSnapshot>(
    environment,
    "/api/orchestration/shell",
  );
  return { ...snapshot, threads: snapshot.threads.map(normalizeThread) };
};

/** Protocol v2 creates threads over the WebSocket, v1 over HTTP dispatch. */
export const getProtocolVersion = (environment: Environment): Promise<number> =>
  serverProtocolVersion(environment);

export const dispatch = (
  environment: Environment,
  command: Record<string, unknown>,
) =>
  request<{ sequence: number }>(environment, "/api/orchestration/dispatch", {
    method: "POST",
    body: JSON.stringify(command),
  });

/** What the thread actions need to know about the server: which of them it supports,
 * and the link to each thread. */
export type ServerInfo = {
  protocolVersion: number;
  environmentId: string | undefined;
  capabilities: Record<string, unknown>;
};

export async function getServerInfo(
  environment: Environment,
): Promise<ServerInfo> {
  const descriptor = await serverDescriptor(environment);
  return {
    protocolVersion: descriptor.orchestrationProtocolVersion ?? 1,
    environmentId: descriptor.environmentId,
    capabilities: descriptor.capabilities ?? {},
  };
}

/** A short name when neither the preferences nor the server give one: the machine
 * name of a tailnet host, or the host and port of an address. */
function fallbackLabel(origin: string): string {
  try {
    const { hostname, host } = new URL(origin);
    return /^[\d.]+$|^\[|^localhost$/.test(hostname)
      ? host
      : hostname.split(".")[0];
  } catch {
    return origin;
  }
}

/** The name set in the preferences, else the one the server gives itself. */
export async function environmentLabel(
  environment: Environment,
): Promise<string> {
  if (environment.name) {
    return environment.name;
  }
  try {
    return (
      (await serverDescriptor(environment)).label?.trim() ||
      fallbackLabel(environment.origin)
    );
  } catch {
    return fallbackLabel(environment.origin);
  }
}

/** One environment's threads and projects. */
export type EnvironmentShell = {
  environment: Environment;
  label: string;
  snapshot: ShellSnapshot;
  /** Undefined when the server cannot describe itself; the list then offers no
   * actions beyond opening and copying. */
  server: ServerInfo | undefined;
};

/** An environment that could not be read, and why. */
export type EnvironmentFailure = {
  environment: Environment;
  label: string;
  error: Error;
};

/** Reads every environment at once. One that fails is reported next to the others
 * rather than failing them all. */
export async function loadShells(): Promise<{
  environments: Environment[];
  shells: EnvironmentShell[];
  failures: EnvironmentFailure[];
}> {
  const environments = await loadEnvironments();
  const results = await Promise.all(
    environments.map(
      async (environment): Promise<EnvironmentShell | EnvironmentFailure> => {
        const [snapshot, server, label] = await Promise.all([
          getShell(environment).catch((error: unknown) =>
            error instanceof Error ? error : new Error(String(error)),
          ),
          getServerInfo(environment).catch(() => undefined),
          environmentLabel(environment),
        ]);
        return snapshot instanceof Error
          ? { environment, label, error: snapshot }
          : { environment, label, snapshot, server };
      },
    ),
  );
  return {
    environments,
    shells: results.filter(
      (result): result is EnvironmentShell => "snapshot" in result,
    ),
    failures: results.filter(
      (result): result is EnvironmentFailure => "error" in result,
    ),
  };
}

/** Why an origin cannot hold a token, or undefined when it can: the same rule every
 * request enforces, checked before anything is saved. */
export function originProblem(origin: string): string | undefined {
  try {
    if (!/^https?:$/.test(new URL(origin).protocol)) {
      return "The origin must start with https:// or http://.";
    }
    assertTokenSafeOrigin(origin);
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

/** What a server says about itself once its token works. */
export type ConnectionCheck = {
  environmentId: string | undefined;
  label: string | undefined;
  serverVersion: string | undefined;
  threadCount: number;
};

/** A machine that is asleep can take a minute to fail, so a check gives up sooner. */
const CHECK_TIMEOUT_MS = 10_000;

async function withinCheckTimeout<T>(
  origin: string,
  work: Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new T3Error(
            "unreachable",
            `${origin} did not answer within ${CHECK_TIMEOUT_MS / 1000} seconds.`,
          ),
        ),
      CHECK_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Asks the server to describe itself and reads its threads with the token, the two
 * things every command needs. Nothing cached earlier in the run is reused, so a
 * restarted server or an edited token is seen as it is now. */
export async function checkConnection(
  environment: Environment,
): Promise<ConnectionCheck> {
  descriptors.delete(environment.origin);
  serverConfigs.delete(environment.origin);
  const [descriptor, snapshot] = await withinCheckTimeout(
    environment.origin,
    Promise.all([serverDescriptor(environment), getShell(environment)]),
  );
  return {
    environmentId: descriptor.environmentId,
    label: descriptor.label?.trim() || undefined,
    serverVersion: descriptor.serverVersion,
    threadCount: liveThreads(snapshot).length,
  };
}

/** The id a server goes by, read without a token: the descriptor is public, which lets
 * two entries for one server be told apart before any credential is sent or spent.
 * Undefined when the server cannot be asked. */
export async function environmentIdAt(
  origin: string,
): Promise<string | undefined> {
  if (originProblem(origin)) {
    return undefined;
  }
  try {
    const response = await withinCheckTimeout(
      origin,
      fetch(`${origin}/.well-known/t3/environment`),
    );
    if (!response.ok) {
      return undefined;
    }
    return ((await response.json()) as EnvironmentDescriptor).environmentId;
  } catch {
    return undefined;
  }
}

/** What a pairing link carries: the server it was issued on, when the link names it,
 * and the one-time credential. */
export type PairingLink = { origin: string | undefined; credential: string };

/** Reads the forms T3 hands out: a `t3code://pair?pairingUrl=…` link, the pairing URL
 * inside it (`https://host/pair#token=…`, or a hosted one naming its server in
 * `host`), or the bare credential `t3 auth pairing create` prints. */
export function parsePairingLink(text: string): PairingLink | undefined {
  const value = text.trim();
  if (!value) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return /\s/.test(value)
      ? undefined
      : { origin: undefined, credential: value };
  }
  if (/^t3code(-[a-z]+)?:$/.test(url.protocol)) {
    const inner =
      url.host === "pair" ? url.searchParams.get("pairingUrl") : null;
    return inner ? parsePairingLink(inner) : undefined;
  }
  if (!/^https?:$/.test(url.protocol)) {
    return undefined;
  }
  const credential = (
    new URLSearchParams(url.hash.slice(1)).get("token") ??
    url.searchParams.get("token") ??
    ""
  ).trim();
  if (!credential) {
    return undefined;
  }
  const host = url.searchParams.get("host")?.trim();
  if (host) {
    try {
      return {
        origin: new URL(/^[a-z]+:\/\//i.test(host) ? host : `https://${host}`)
          .origin,
        credential,
      };
    } catch {
      return undefined;
    }
  }
  return { origin: url.origin, credential };
}

/** The two scopes the extension uses, the same ones the README's token command asks for. */
const CLIENT_SCOPES = ["orchestration:read", "orchestration:operate"];

/** Trades a one-time pairing credential for a bearer token, the exchange T3's own
 * clients make for a headless session. Only the two scopes the extension uses are
 * asked for, and the server grants no more than the pairing link allows. The session
 * lasts T3's default of 30 days; a pairing exchange cannot ask for longer. */
export async function exchangePairingCredential(
  origin: string,
  credential: string,
): Promise<{ token: string; scopes: string[]; expiresAt: Date }> {
  // Until it is used, the credential is as good as a token, so it gets the same rule.
  assertTokenSafeOrigin(origin);
  let response: Response;
  try {
    response = await fetch(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: credential,
        subject_token_type:
          "urn:t3:params:oauth:token-type:environment-bootstrap",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        scope: CLIENT_SCOPES.join(" "),
        client_label: "Raycast",
        client_device_type: "desktop",
      }).toString(),
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
  } catch {
    throw new T3Error(
      "unreachable",
      `Cannot reach the T3 Code server at ${origin}.`,
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new T3Error(
      "unauthorized",
      "T3 Code rejected the pairing link. A link works once and expires after a few minutes, so create a new one.",
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new T3Error(
      "http",
      `T3 Code returned ${response.status} for the pairing link. ${body.slice(0, 200)}`,
    );
  }
  const result = (await response.json()) as {
    access_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
  };
  if (result.token_type !== "Bearer") {
    throw new T3Error(
      "http",
      `T3 Code issued a ${result.token_type} token, which the extension cannot use.`,
    );
  }
  return {
    token: result.access_token,
    scopes: result.scope.split(" ").filter(Boolean),
    expiresAt: new Date(Date.now() + result.expires_in * 1000),
  };
}

/** Sends one orchestration command over the WebSocket, the only way protocol v2 takes
 * them. The command id is filled in here. */
export async function dispatchCommand(
  environment: Environment,
  command: { type: string; threadId: string } & Record<string, unknown>,
): Promise<void> {
  const rpc = await openServerRpc(environment);
  try {
    await rpc.call("orchestration.dispatchCommand", {
      commandId: randomUUID(),
      ...command,
    });
  } finally {
    rpc.close();
  }
}

export function liveThreads(snapshot: ShellSnapshot): Thread[] {
  return snapshot.threads.filter(
    (thread) => !thread.deletedAt && !thread.archivedAt,
  );
}

export function threadTimestamp(thread: Thread): number {
  return new Date(thread.updatedAt ?? thread.createdAt).getTime();
}

export function liveProjects(snapshot: ShellSnapshot): Project[] {
  const lastActivity = new Map<string, number>();
  for (const thread of snapshot.threads) {
    const at = threadTimestamp(thread);
    if (at > (lastActivity.get(thread.projectId) ?? 0)) {
      lastActivity.set(thread.projectId, at);
    }
  }
  return snapshot.projects
    .filter((project) => !project.deletedAt)
    .sort(
      (a, b) => (lastActivity.get(b.id) ?? 0) - (lastActivity.get(a.id) ?? 0),
    );
}

/** New sessions inherit whatever you last chose in the app for that project, so the
 * extension never carries its own model list to go stale. */
export function inheritedSettings(
  snapshot: ShellSnapshot,
  projectId: string,
  fallbackModel?: ModelSelection,
): {
  modelSelection: ModelSelection | undefined;
  runtimeMode: RuntimeMode;
  envMode: ThreadEnvMode;
} {
  const project = snapshot.projects.find(
    (candidate) => candidate.id === projectId,
  );
  const newest = snapshot.threads
    .filter(
      (thread) =>
        thread.projectId === projectId &&
        !thread.deletedAt &&
        thread.modelSelection,
    )
    .sort((a, b) => threadTimestamp(b) - threadTimestamp(a))[0];
  // No hardcoded default: a provider this machine has disabled would be rejected
  // by the server, so fall back to whatever the picker is actually offering.
  const modelSelection =
    newest?.modelSelection ?? project?.defaultModelSelection ?? fallbackModel;
  const runtimeMode = newest?.runtimeMode ?? "full-access";
  const envMode = project?.defaultThreadEnvMode ?? "local";
  return { modelSelection, runtimeMode, envMode };
}

/** Dropdown values have to be strings, so a selection round-trips through one. */
/** Options that say nothing a missing option would not: fast mode off, the default
 * service tier. Dropping them stops one model showing up several times. */
const isNoiseOption = (option: { id: string; value: unknown }) =>
  (option.id === "fastMode" && String(option.value) === "false") ||
  (option.id === "serviceTier" && option.value === "default") ||
  (option.id === "speed" && option.value === "standard") ||
  option.id === "mode";

/** Claude ids come both as "claude-fable-5-1" and "claude-fable-5.1" in old threads;
 * the dashed form is the one the manifest lists. Other providers use dots for real. */
const canonicalModel = (model: string) =>
  model.startsWith("claude-") ? model.replace(/(\d)\.(\d)/g, "$1-$2") : model;

/** Entries the server creates for its own bookkeeping, never a choice for a person. */
export const isInternalModel = (model: string) => /^<.*>$/.test(model);

const meaningfulOptions = (selection: ModelSelection) =>
  (selection.options ?? []).filter((option) => !isNoiseOption(option));

export function modelKey(selection: ModelSelection): string {
  const options = meaningfulOptions(selection)
    .map((option) => `${option.id}=${option.value}`)
    .sort()
    .join(",");
  return `${selection.instanceId}|${canonicalModel(selection.model)}|${options}`;
}

export function parseModelKey(key: string): ModelSelection {
  const [instanceId, model, options] = key.split("|");
  const parsed = (options ?? "")
    .split(",")
    .filter(Boolean)
    .map((pair) => {
      const [id, ...rest] = pair.split("=");
      return { id, value: rest.join("=") };
    });
  return parsed.length > 0
    ? { instanceId, model, options: parsed }
    : { instanceId, model };
}

type ProviderInstance = {
  driver?: string;
  displayName?: string;
  enabled?: boolean;
  config?: { customModels?: string[] };
};

type T3Settings = {
  providerInstances?: Record<string, ProviderInstance | undefined>;
  favorites?: { provider: string; model: string }[] | null;
  snoozePresets?: SnoozePresetSetting[];
};

/** The parts of server.getConfig the extension reads: the same settings as the file
 * on disk, and the models each provider instance offers right now. */
type ServerConfig = {
  settings?: T3Settings;
  providers?: {
    instanceId: string;
    driver: string;
    displayName?: string;
    enabled: boolean;
    availability?: string;
    models: { slug: string }[];
  }[];
};

const serverConfigs = new Map<string, Promise<ServerConfig>>();

/** A server on another machine shares its settings and models over the WebSocket.
 * Older servers, or one that cannot be asked, leave the extension on T3's defaults
 * and the models its threads already use. */
function serverConfig(environment: Environment): Promise<ServerConfig> {
  let config = serverConfigs.get(environment.origin);
  if (!config) {
    config = (async () => {
      if ((await serverProtocolVersion(environment)) < 2) {
        return {};
      }
      const rpc = await openServerRpc(environment);
      try {
        return await rpc.call<ServerConfig>("server.getConfig", {});
      } finally {
        rpc.close();
      }
    })().catch(() => ({}));
    serverConfigs.set(environment.origin, config);
  }
  return config;
}

const DRIVER_NAMES: Record<string, string> = {
  claudeAgent: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  cursor: "Cursor",
  grok: "Grok",
  opencode: "OpenCode",
};

/** The settings, model manifest and runtime files under ~/.t3 describe the install on
 * this machine, so they only apply to the server that is that install: a loopback one
 * whose id matches the id stored beside them. A Mac, or a second server on another
 * port, never inherits this machine's settings. */
export async function isThisMachine(
  environment: Environment,
): Promise<boolean> {
  if (!isLoopback(environment.origin)) {
    return false;
  }
  let localId: string;
  try {
    localId = (
      await readFile(join(RUNTIME_DIR, "environment-id"), "utf8")
    ).trim();
  } catch {
    // An install that predates the file: loopback is all there is to go on.
    return true;
  }
  try {
    return (await serverDescriptor(environment)).environmentId === localId;
  } catch {
    return false;
  }
}

async function readSettings(environment: Environment): Promise<T3Settings> {
  if (!(await isThisMachine(environment))) {
    return (await serverConfig(environment)).settings ?? {};
  }
  try {
    return JSON.parse(
      await readFile(join(RUNTIME_DIR, "settings.json"), "utf8"),
    ) as T3Settings;
  } catch {
    return {};
  }
}

/** The name T3 shows for each provider instance: the one you gave it, else its driver's. */
export async function providerNames(
  environment: Environment,
): Promise<Record<string, string>> {
  const { providerInstances = {} } = await readSettings(environment);
  const names: Record<string, string> = {};
  for (const [id, instance] of Object.entries(providerInstances)) {
    names[id] =
      instance?.displayName ??
      DRIVER_NAMES[instance?.driver ?? id] ??
      instance?.driver ??
      id;
  }
  // A server on another machine also names the instances its settings leave at the
  // defaults.
  if (!(await isThisMachine(environment))) {
    for (const provider of (await serverConfig(environment)).providers ?? []) {
      names[provider.instanceId] ??=
        provider.displayName ??
        DRIVER_NAMES[provider.driver] ??
        provider.driver;
    }
  }
  return names;
}

/** Models starred in the T3 app, so the stars here match the ones in the sidebar. They
 * match on provider and model alone, since a starred model carries no effort setting. */
export async function t3Favorites(environment: Environment): Promise<string[]> {
  const { favorites } = await readSettings(environment);
  return (favorites ?? []).map(
    (favorite) => `${favorite.provider}|${favorite.model}`,
  );
}

/** The snooze presets set in T3, so the menu offers the same times as the app's. A
 * remote server's settings are not on this machine, so it gets T3's defaults. */
export async function snoozePresets(
  environment: Environment,
): Promise<SnoozePresetSetting[]> {
  const { snoozePresets: presets } = await readSettings(environment);
  return Array.isArray(presets) && presets.length > 0
    ? presets
    : DEFAULT_SNOOZE_PRESETS;
}

export const isFavoriteModel = (key: string, favorites: string[]) =>
  favorites.some(
    (favorite) => key === favorite || key.startsWith(`${favorite}|`),
  );

/** "claude-opus-5-5" reads as "Opus 5.5"; other models keep their own name with the
 * dashes turned into spaces. */
export function prettyModelName(model: string): string {
  const spaced = model
    .replace(/^claude-/, "")
    .replace(/(\d)-(\d)/g, "$1.$2")
    .replace(/-/g, " ")
    .trim();
  return model.startsWith("claude-")
    ? spaced.replace(/^./, (letter) => letter.toUpperCase())
    : spaced.replace(/^gpt/i, "GPT");
}

const EFFORT_OPTION_IDS = new Set([
  "effort",
  "reasoningEffort",
  "thought_level",
]);

/** Provider, model, effort, then anything else that changes the run, each as its own
 * part. Effort always appears for providers that have one, "default" when none is set,
 * so two entries for one model never look the same. */
export function modelParts(
  selection: ModelSelection,
  names: Record<string, string> = {},
): string[] {
  const options = meaningfulOptions(selection);
  const effort = options.find((option) => EFFORT_OPTION_IDS.has(option.id));
  const hasEffort =
    effort !== undefined || /^(claudeAgent|codex)/.test(selection.instanceId);
  const extras = options
    .filter((option) => !EFFORT_OPTION_IDS.has(option.id))
    .map((option) => {
      if (option.id === "contextWindow") {
        return String(option.value).toUpperCase();
      }
      if (option.id === "fastMode") {
        return "fast";
      }
      return `${option.id} ${option.value}`;
    });
  return [
    names[selection.instanceId],
    prettyModelName(canonicalModel(selection.model)),
    hasEffort ? String(effort?.value ?? "default") : undefined,
    ...extras,
  ].filter((part): part is string => Boolean(part));
}

export const modelLabel = (
  selection: ModelSelection,
  names: Record<string, string> = {},
) => modelParts(selection, names).join(" · ");

/** Models the manifest lists for providers that are actually enabled, plus the custom
 * models an instance declares. A second instance of a driver with none of its own falls
 * back to that driver's list. Read from disk because the server publishes the manifest
 * over the WebSocket only; a missing or unreadable file just means the picker falls back
 * to what threads already use. A server on another machine is asked for its providers'
 * models instead. */
async function manifestSelections(
  environment: Environment,
): Promise<ModelSelection[]> {
  if (!(await isThisMachine(environment))) {
    const { providers = [] } = await serverConfig(environment);
    return providers
      .filter(
        (provider) =>
          provider.enabled && provider.availability !== "unavailable",
      )
      .flatMap((provider) =>
        provider.models.map((model) => ({
          instanceId: provider.instanceId,
          model: model.slug,
        })),
      );
  }
  try {
    const [manifestRaw, settings] = await Promise.all([
      readFile(join(RUNTIME_DIR, "model-manifest.json"), "utf8"),
      readSettings(environment),
    ]);
    const manifest = JSON.parse(manifestRaw) as {
      manifest?: { currentModels?: Record<string, string[]> };
    };
    const current = manifest.manifest?.currentModels ?? {};
    return Object.entries(settings.providerInstances ?? {})
      .filter(([, instance]) => instance?.enabled === true)
      .flatMap(([instanceId, instance]) => {
        const custom = instance?.config?.customModels ?? [];
        const listed =
          current[instanceId] ??
          (custom.length === 0 && instance?.driver
            ? current[instance.driver]
            : undefined) ??
          [];
        return [...new Set([...listed, ...custom])].map((model) => ({
          instanceId,
          model,
        }));
      });
  } catch {
    return [];
  }
}

/** Every selection worth offering: the ones the environment has actually run, most
 * recently used first, then anything else the enabled providers currently support. */
export async function modelChoices(
  environment: Environment,
  snapshot: ShellSnapshot,
  names: Record<string, string> = {},
): Promise<{ key: string; label: string; selection: ModelSelection }[]> {
  const seen = new Map<string, { selection: ModelSelection; at: number }>();
  for (const thread of snapshot.threads) {
    if (
      !thread.modelSelection ||
      thread.deletedAt ||
      isInternalModel(thread.modelSelection.model)
    ) {
      continue;
    }
    const key = modelKey(thread.modelSelection);
    const at = threadTimestamp(thread);
    const previous = seen.get(key);
    if (!previous || at > previous.at) {
      seen.set(key, {
        selection: {
          ...thread.modelSelection,
          model: canonicalModel(thread.modelSelection.model),
        },
        at,
      });
    }
  }
  const used = [...seen.entries()]
    .sort((a, b) => b[1].at - a[1].at)
    .map(([key, value]) => ({
      key,
      label: modelLabel(value.selection, names),
      selection: value.selection,
    }));

  const extra = (await manifestSelections(environment))
    .filter((selection) => !seen.has(modelKey(selection)))
    .map((selection) => ({
      key: modelKey(selection),
      label: modelLabel(selection, names),
      selection,
    }));

  return [...used, ...extra];
}

export function threadTitle(prompt: string): string {
  const firstLine =
    prompt
      .trim()
      .split("\n")
      .find((line) => line.trim().length > 0) ?? "New session";
  return firstLine.trim().slice(0, 60);
}

// The preference used to default to this, which matches neither release bundle, so a
// stored copy counts as unset unless an app with that exact name is installed.
const LEGACY_APP_NAME = "T3 Code";
// The stable build was renamed from Alpha to Beta; an install that predates the rename
// keeps the old bundle name.
const STABLE_APPS = ["T3 Code (Beta)", "T3 Code (Alpha)"];
const NIGHTLY_APP = "T3 Code (Nightly)";
// Same pattern T3 uses to brand a build as Nightly. Preview builds share the branding.
const NIGHTLY_VERSION = /^[^-+]+-(?:nightly|preview)\.\d{8}\.\d+$/;

export const isWindows = process.platform === "win32";

/** Where the installer puts the app: an .app bundle on macOS, a per-user .exe named
 * after the release channel on Windows. */
function installCandidates(name: string): string[] {
  if (isWindows) {
    const localAppData =
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return [join(localAppData, "Programs", "t3code", `${name}.exe`)];
  }
  return ["/Applications", join(homedir(), "Applications")].map((dir) =>
    join(dir, `${name}.app`),
  );
}

async function installedPath(name: string): Promise<string | undefined> {
  for (const candidate of installCandidates(name)) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // not installed here
    }
  }
  return undefined;
}

const isInstalled = async (name: string) =>
  (await installedPath(name)) !== undefined;

/** The app bundle is named after its release channel, so a fixed name only fits one
 * of them. The preference wins; otherwise follow the version of the primary server,
 * the one the desktop app on this machine runs, and with no server running use
 * whichever app is installed, stable first. */
async function appName(): Promise<string> {
  const configured = preferences().appName?.trim();
  if (
    configured &&
    (configured !== LEGACY_APP_NAME || (await isInstalled(configured)))
  ) {
    return configured;
  }
  const stable = await installedStableApp();
  try {
    const { serverVersion } = await serverDescriptor(
      await primaryEnvironment(),
    );
    if (serverVersion) {
      return NIGHTLY_VERSION.test(serverVersion) ? NIGHTLY_APP : stable;
    }
  } catch {
    // the server is not running, so look at what is installed
  }
  return (await isInstalled(stable)) || !(await isInstalled(NIGHTLY_APP))
    ? stable
    : NIGHTLY_APP;
}

/** Whichever stable bundle name is installed, the current one when neither is. */
async function installedStableApp(): Promise<string> {
  for (const name of STABLE_APPS) {
    if (await isInstalled(name)) {
      return name;
    }
  }
  return STABLE_APPS[0];
}

const escapeForAppleScript = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** What the T3 command palette knows about a thread. */
export type PaletteThread = {
  id: string;
  title: string;
  projectTitle: string | undefined;
  branch: string | null;
};

// Mirrors normalizeSearchText in T3's CommandPalette.logic.ts, so a match counted
// here is a match the palette will list.
const normalizeSearchText = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

export const paletteQuery = (thread: PaletteThread) =>
  [thread.title, thread.projectTitle, thread.branch]
    .filter((part): part is string => Boolean(part))
    .join(" ");

/** The palette lists a thread when every query token appears somewhere in its
 * title, project title or branch. */
export function paletteMatchCount(
  threads: PaletteThread[],
  query: string,
): number {
  const tokens = normalizeSearchText(query).split(" ");
  return threads.filter((thread) => {
    const haystack = normalizeSearchText(
      [thread.title, thread.projectTitle ?? "", thread.branch ?? ""].join(" "),
    );
    return tokens.every((token) => haystack.includes(token));
  }).length;
}

export function paletteThreads(snapshot: ShellSnapshot): PaletteThread[] {
  const projectTitles = new Map(
    snapshot.projects.map((project) => [project.id, project.title]),
  );
  return liveThreads(snapshot).map((thread) => ({
    id: thread.id,
    title: thread.title,
    projectTitle: projectTitles.get(thread.projectId),
    branch: thread.branch,
  }));
}

/** Desktop builds from 0.1.0 navigate to `t3code://threads/<environment>/<thread>`.
 * The server and the desktop app ship together, so the server's version stands in
 * for the app's. */
const THREAD_LINK_MIN_VERSION = [0, 1, 0];

function versionAtLeast(version: string, minimum: number[]): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version)?.slice(1).map(Number);
  if (!parts) {
    return false;
  }
  for (let index = 0; index < minimum.length; index++) {
    if (parts[index] !== minimum[index]) {
      return parts[index] > minimum[index];
    }
  }
  return true;
}

export const threadLink = (environmentId: string, threadId: string) =>
  `t3code://threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;

/** The link that opens this thread in the desktop app, or undefined when the server
 * is too old for the app to follow one, or cannot be asked. The link names the
 * thread's own environment, which the app can open once it is paired with it. */
export async function threadLinkFor(
  environment: Environment,
  threadId: string,
): Promise<string | undefined> {
  try {
    const { environmentId, serverVersion } =
      await serverDescriptor(environment);
    return environmentId &&
      serverVersion &&
      versionAtLeast(serverVersion, THREAD_LINK_MIN_VERSION)
      ? threadLink(environmentId, threadId)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Opens the thread itself through its deep link. Servers too old for the app to
 * follow one fall back to driving the command palette. */
export async function focusThread(
  environment: Environment,
  target: PaletteThread,
): Promise<"opened" | "ambiguous" | "unfocused"> {
  const link = await threadLinkFor(environment, target.id);
  if (link) {
    await openAppLink(link);
    return "opened";
  }
  if (isWindows) {
    // The palette fallback drives macOS keystrokes; an app that old can only be shown.
    await launchApp();
    return "unfocused";
  }
  return focusThreadInPalette(environment, target);
}

/** Both release channels register the same t3code:// scheme, so whichever installed
 * last would get the link. Handing it to this server's own app keeps it in the right
 * channel: on macOS by name, on Windows by starting the .exe with the link, which is
 * what the scheme's registered command does and reaches a running instance too. */
async function openAppLink(link: string): Promise<void> {
  const name = await appName();
  if (isWindows) {
    const exe = await installedPath(name);
    if (exe) {
      spawn(exe, [link], { detached: true, stdio: "ignore" }).unref();
      return;
    }
    await open(link);
    return;
  }
  await open(link, name);
}

/** For desktop builds that only reveal their window for an external URL: focus the
 * app and drive its own command palette with the thread's title, project and branch.
 * The query is typed first, then matches are counted against a shell snapshot fetched
 * at that moment, so a thread created since the list loaded still counts. Enter is
 * pressed only when exactly one thread matches and T3 Code is still frontmost;
 * otherwise the palette is left as it is and the result says why, so the caller can
 * tell the user. */
async function focusThreadInPalette(
  environment: Environment,
  target: PaletteThread,
): Promise<"opened" | "ambiguous" | "unfocused"> {
  const query = paletteQuery(target);
  const name = await appName();
  await run("/usr/bin/open", ["-a", name]);
  await run("/usr/bin/osascript", [
    "-e",
    `
tell application "${escapeForAppleScript(name)}" to activate
delay 0.35
tell application "System Events"
  keystroke "k" using command down
  delay 0.35
  keystroke "${escapeForAppleScript(query)}"
end tell`,
  ]);
  const live = paletteThreads(await getShell(environment));
  // A thread that was just created can lag behind the shell projection.
  const candidates = live.some((thread) => thread.id === target.id)
    ? live
    : [...live, target];
  if (paletteMatchCount(candidates, query) !== 1) {
    return "ambiguous";
  }
  // The user may have switched apps while the snapshot loaded. Bring T3 Code back
  // and send Enter only if it really is in front, so the key never lands elsewhere.
  const { stdout } = await run("/usr/bin/osascript", [
    "-e",
    `
tell application "${escapeForAppleScript(name)}" to activate
delay 0.3
if frontmost of application "${escapeForAppleScript(name)}" then
  tell application "System Events" to key code 36
  return "opened"
end if
return "unfocused"`,
  ]);
  return stdout.trim() === "opened" ? "opened" : "unfocused";
}

/** Starts T3 Code, or brings a running instance forward: its single-instance lock hands
 * a second launch to the first. */
export async function launchApp(): Promise<void> {
  const name = await appName();
  if (!isWindows) {
    await run("/usr/bin/open", ["-a", name]);
    return;
  }
  const exe = await installedPath(name);
  if (!exe) {
    throw new Error(
      `${name} is not installed in ${dirname(installCandidates(name)[0])}. Set the App Name preference to the installed build.`,
    );
  }
  spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
}

export function worktreePathFor(workspaceRoot: string, branch: string): string {
  const repoName = workspaceRoot.split(/[\\/]/).filter(Boolean).pop() ?? "repo";
  return join(WORKTREES_DIR, repoName, branch.replace(/\//g, "-"));
}

/** The default branch of a repository is whatever origin/HEAD points at, not
 * necessarily `main`. Falls back to the checked-out branch when there is no
 * remote to ask. */
export async function defaultBaseBranch(
  workspaceRoot: string,
): Promise<string> {
  try {
    const { stdout } = await run("git", [
      "-C",
      workspaceRoot,
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    const ref = stdout.trim();
    if (ref.startsWith("origin/")) {
      return ref.slice("origin/".length);
    }
  } catch {
    // no origin, or origin/HEAD was never resolved on this clone
  }
  try {
    const { stdout } = await run("git", [
      "-C",
      workspaceRoot,
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    return stdout.trim() || "main";
  } catch {
    return "main";
  }
}

async function hasOrigin(workspaceRoot: string): Promise<boolean> {
  try {
    const { stdout } = await run("git", ["-C", workspaceRoot, "remote"]);
    return stdout.split("\n").some((remote) => remote.trim() === "origin");
  } catch {
    return false;
  }
}

/** T3 prepares worktrees on its WebSocket path only, so the extension does the same
 * two steps itself: fetch the base, then add the worktree where T3 would have put it.
 * A repository with an origin must fetch successfully, otherwise the new branch would
 * silently start from a stale local ref. */
export async function createWorktree(input: {
  workspaceRoot: string;
  branch: string;
  baseBranch: string;
}): Promise<string> {
  const target = worktreePathFor(input.workspaceRoot, input.branch);
  let base = input.baseBranch;
  if (await hasOrigin(input.workspaceRoot)) {
    try {
      await run("git", [
        "-C",
        input.workspaceRoot,
        "fetch",
        "origin",
        input.baseBranch,
      ]);
    } catch (error) {
      throw new Error(
        `Could not fetch origin/${input.baseBranch}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    base = `origin/${input.baseBranch}`;
  }
  await run("git", [
    "-C",
    input.workspaceRoot,
    "worktree",
    "add",
    "-b",
    input.branch,
    target,
    base,
  ]);
  return target;
}

/** Undoes createWorktree when a later step of starting the session fails. */
export async function removeWorktree(
  workspaceRoot: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  try {
    await run("git", [
      "-C",
      workspaceRoot,
      "worktree",
      "remove",
      "--force",
      worktreePath,
    ]);
    await run("git", ["-C", workspaceRoot, "branch", "-D", branch]);
  } catch {
    // leave whatever could not be cleaned up; the session error is what matters
  }
}

export async function startSession(
  environment: Environment,
  input: {
    projectId: string;
    prompt: string;
    /** Defaults to the first line of the prompt. */
    title?: string;
    modelSelection: ModelSelection;
    runtimeMode: RuntimeMode;
    branch: string | null;
    worktreePath: string | null;
    attachments?: AttachmentFile[];
  },
): Promise<string> {
  const threadId = randomUUID();
  const createdAt = new Date().toISOString();
  const title = input.title ?? threadTitle(input.prompt);

  await dispatch(environment, {
    type: "thread.create",
    commandId: randomUUID(),
    threadId,
    projectId: input.projectId,
    title,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: "default",
    branch: input.branch,
    worktreePath: input.worktreePath,
    createdAt,
  });

  try {
    await dispatch(environment, {
      type: "thread.turn.start",
      commandId: randomUUID(),
      threadId,
      message: {
        messageId: randomUUID(),
        role: "user",
        text: input.prompt,
        attachments: await Promise.all(
          (input.attachments ?? []).map(inlineAttachment),
        ),
      },
      modelSelection: input.modelSelection,
      titleSeed: title,
      runtimeMode: input.runtimeMode,
      interactionMode: "default",
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    // An empty thread is worse than none: drop it so a retry does not pile up
    // half-started sessions in the sidebar.
    await dispatch(environment, {
      type: "thread.delete",
      commandId: randomUUID(),
      threadId,
    }).catch(() => undefined);
    throw error;
  }

  return threadId;
}

export const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
/** The types an agent most often gets handed, for platforms without `file`. */
const FILE_MIME_TYPES: Record<string, string> = {
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/plain",
  ".tsx": "text/plain",
  ".py": "text/x-python",
  ".json": "application/json",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".svg": "image/svg+xml",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const UPLOAD_TIMEOUT_MS = 5 * 60_000;
const LAUNCH_TIMEOUT_MS = 5 * 60_000;
export const MAX_ATTACHMENTS = 8;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** What was checked about a file. The bytes are read only when it is sent, one file at a
 * time, so eight 50 MB files never sit in memory together. */
export type AttachmentFile = {
  kind: "image" | "file";
  name: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
};

/** The extension decides images, since T3 accepts only four types as images; anything
 * else goes to `file` for its mime type, which the server stores and hands to the agent. */
async function mimeTypeOf(path: string): Promise<string> {
  const extension = extname(path).toLowerCase();
  const known = IMAGE_MIME_TYPES[extension];
  if (known) {
    return known;
  }
  // Windows has no `file` command, so it goes by extension alone.
  if (isWindows) {
    return FILE_MIME_TYPES[extension] ?? "application/octet-stream";
  }
  try {
    const { stdout } = await run("file", ["--brief", "--mime-type", path]);
    return stdout.trim().slice(0, 100) || "application/octet-stream";
  } catch {
    return "application/octet-stream";
  }
}

/** Reads a file the way T3 will accept it: images up to 10 MiB, other files up to 50 MiB. */
export async function readAttachment(path: string): Promise<AttachmentFile> {
  const name = basename(path);
  const mimeType = await mimeTypeOf(path);
  const kind = Object.values(IMAGE_MIME_TYPES).includes(mimeType)
    ? "image"
    : "file";
  const limit = kind === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
  const info = await stat(path);
  if (!info.isFile()) {
    throw new Error(`${name} is not a file.`);
  }
  if (info.size === 0 || info.size > limit) {
    throw new Error(
      `${name} must be between 1 byte and ${limit / 1024 / 1024} MB.`,
    );
  }
  return { kind, name, path, mimeType, sizeBytes: info.size };
}

/** v1 servers take image bytes inside the turn itself and have no file attachments. */
async function inlineAttachment(attachment: AttachmentFile) {
  if (attachment.kind !== "image") {
    throw new Error(
      `${attachment.name} cannot be sent: this T3 Code server only accepts images. Update T3 Code to attach other files.`,
    );
  }
  return {
    type: "image",
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    dataUrl: `data:${attachment.mimeType};base64,${(await readFile(attachment.path)).toString("base64")}`,
  };
}

async function openServerRpc(environment: Environment): Promise<RpcConnection> {
  const version = await serverProtocolVersion(environment);
  const { ticket } = await request<{ ticket: string }>(
    environment,
    "/api/auth/websocket-ticket",
    { method: "POST" },
  );
  const url = new URL(environment.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = new URLSearchParams({
    orchestrationProtocol: String(version),
    wsTicket: ticket,
  }).toString();
  try {
    return await openRpc(url.toString());
  } catch (error) {
    throw new T3Error(
      "unreachable",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** v2 servers hold uploads until a turn claims them: ask for a signed URL, post the
 * bytes there, then reference the attachment by id. */
async function uploadAttachments(
  environment: Environment,
  rpc: RpcConnection,
  attachments: AttachmentFile[],
) {
  const uploaded = [];
  for (const attachment of attachments) {
    const slot = await rpc.call<{ attachmentId: string; relativeUrl: string }>(
      "attachments.createUploadUrl",
      {
        type: attachment.kind,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      },
    );
    const response = await fetch(`${environment.origin}${slot.relativeUrl}`, {
      method: "POST",
      headers: { "Content-Type": attachment.mimeType },
      body: await readFile(attachment.path),
      // The signed URL is the only thing authorising this upload, so a redirect to
      // somewhere else is an error, and a stalled server cannot hang the command.
      redirect: "error",
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `Uploading ${attachment.name} failed with ${response.status}. ${(await response.text().catch(() => "")).slice(0, 200)}`,
      );
    }
    uploaded.push({
      type: attachment.kind,
      id: slot.attachmentId,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    });
  }
  return uploaded;
}

/** The v2 path. One call creates the thread, prepares its worktree and sends the first
 * message, so the extension no longer runs git itself. */
export async function launchThread(
  environment: Environment,
  input: {
    projectId: string;
    title: string;
    prompt: string;
    modelSelection: ModelSelection;
    runtimeMode: RuntimeMode;
    workspace:
      | { type: "root" }
      | {
          type: "worktree";
          baseRef: string;
          branch: string;
          startFromOrigin: boolean;
        };
    attachments: AttachmentFile[];
  },
): Promise<string> {
  const rpc = await openServerRpc(environment);
  try {
    const attachments = await uploadAttachments(
      environment,
      rpc,
      input.attachments,
    );
    const result = await rpc.call<{ threadId: string }>(
      "orchestration.launchThread",
      {
        commandId: randomUUID(),
        // Uploaded attachments are claimed by thread id, so it is fixed up front.
        threadId: randomUUID(),
        projectId: input.projectId,
        title: input.title,
        generateTitle: false,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: "default",
        workspaceStrategy: input.workspace,
        initialMessage: {
          messageId: randomUUID(),
          text: input.prompt,
          attachments,
        },
      },
      LAUNCH_TIMEOUT_MS,
    );
    return result.threadId;
  } finally {
    rpc.close();
  }
}

export async function hasOriginRemote(workspaceRoot: string): Promise<boolean> {
  return hasOrigin(workspaceRoot);
}

/** Where a new worktree branches from when the repository is not on this machine. The
 * server lists the repository's refs with its default branch marked, which answers
 * what defaultBaseBranch and hasOriginRemote work out locally. */
export async function serverBaseRef(
  environment: Environment,
  workspaceRoot: string,
): Promise<{ baseRef: string; startFromOrigin: boolean }> {
  const rpc = await openServerRpc(environment);
  try {
    const result = await rpc.call<{
      isRepo: boolean;
      hasPrimaryRemote: boolean;
      refs: { name: string; current: boolean; isDefault: boolean }[];
    }>("vcs.listRefs", { cwd: workspaceRoot, refKind: "local" });
    const base =
      result.refs.find((ref) => ref.isDefault) ??
      result.refs.find((ref) => ref.current);
    if (!result.isRepo || !base) {
      throw new Error(
        "That project is not a git repository with a branch to start a worktree from.",
      );
    }
    return { baseRef: base.name, startFromOrigin: result.hasPrimaryRemote };
  } finally {
    rpc.close();
  }
}
