import type {
  ExecutionContext,
  RequestContext,
  RuntimeRunUsage,
} from '@allrice/contracts';
import type {
  PersonVmAdmissionBoundary,
  PersonVmAdmissionPort,
  PersonVmAdmissionPermit,
  PersonVmBinding,
} from '@allrice/person-vm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const MODEL_GATEWAY_CONTRACT_VERSION = 1 as const;
export const MODEL_STREAMS_PER_PERSON = 8 as const;
export const MODEL_CALL_REFERENCE_HEADER = 'x-allrice-model-call-reference';
export const MODEL_CALL_RECIPIENT_HEADER = 'x-allrice-model-call-recipient';
export const isModelCallReference = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

export type ModelRouteKey = Readonly<{ provider: string; model: string }>;

/** HOST ONLY. Shapes do not authenticate. The authority must resolve every
 * field from its managed connection/current identity/native descriptor owner. */
export type ModelCallBinding = ModelRouteKey &
  Readonly<{
    context: RequestContext;
    vm: PersonVmBinding;
    execution: Pick<ExecutionContext, 'runId' | 'executionId'>;
    employeeInstanceId: string;
    employeeRelease: string;
    allriceThreadRef: string;
    native: Readonly<{
      instanceId: string;
      profile: string;
      sessionId: string;
      rootSessionId: string;
      parentSessionId: string | null;
      callId: string;
      attemptId?: string;
      attemptKind?: 'assistant' | 'compaction' | 'session-title';
      attemptTurn?: number | null;
      attemptCursor?: number;
    }>;
    executionGeneration: string;
    gatewayRelease: string;
  }>;

/** Trusted routing input for issuance. A future resolver can apply a session
 * or child-session policy here, then seal its result into ModelCallBinding.
 * Never populate this context from a guest model hint. */
export type ModelRouteScope = Pick<
  ModelCallBinding,
  'context' | 'vm' | 'employeeInstanceId' | 'employeeRelease' | 'native'
>;
export type ResolveModelRoute = (
  scope: ModelRouteScope,
  signal: AbortSignal,
) => Promise<ModelRouteKey>;

export interface ModelGatewayAuthority {
  /** Current membership, managed VM epoch, employee release, root/child tree,
   * Run/call and exact route. Never authorize by parsing this shape alone. */
  assertCall(binding: ModelCallBinding, signal: AbortSignal): Promise<void>;
  /** Trusted continuously watched exact call evidence, established at redeem.
   * A caller without a watcher retains the full authority check on delivery. */
  deliverySignal?(binding: ModelCallBinding): AbortSignal;
  assertDeliveryObserved?(
    binding: ModelCallBinding,
    signal: AbortSignal,
  ): Promise<void>;
  authorizeUsage(
    context: RequestContext,
    signal: AbortSignal,
  ): Promise<{
    personId: string;
    organizationId: string;
  }>;
  /** Must authenticate the operator AND independently prove this exact host's
   * transports stopped. A guest receipt, timeout or missing heartbeat is not proof. */
  confirmOwnerStopped(
    context: RequestContext,
    ownerId: string,
    signal: AbortSignal,
  ): Promise<{
    evidenceRef: string;
  }>;
}

/** The trusted host injects BOTH from the same shared admission host. The
 * gateway never creates an authority or reads the VM owner's private store. */
export type ModelGatewayAdmission = Readonly<{
  boundary: PersonVmAdmissionBoundary;
  participant: PersonVmAdmissionPort;
  /** Exact local permits only, after this Gateway and its dispatcher stopped. */
  recoverStoppedPermit?(
    permit: PersonVmAdmissionPermit,
    signal: AbortSignal,
  ): Promise<void>;
}>;

/** The public DSH vocabulary, without guest-selectable identity or routing. */
export type GatewayModelInput = Pick<
  GenerateOptions,
  | 'messages'
  | 'system'
  | 'tools'
  | 'toolHistory'
  | 'temperature'
  | 'maxTokens'
  | 'stop'
  | 'reasoningEffort'
  | 'purpose'
>;
export type GatewayFetchClassification = Readonly<{
  kind: 'model' | 'auth-refresh';
  protocol: 'openai-chat-completions' | 'openai-responses' | 'opaque';
}>;
export type DshGatewayRoute = ModelRouteKey &
  Readonly<{
    transport: 'sse';
    classify: GatewayProvider['classify'];
    /** Host approved for this exact route. Only for a supported provider/model capability. */
    hostedWebSearch?: true;
  }>;
export interface GatewayProvider {
  readonly hostedWebSearch?: ModelRouteKey;
  /** Require a confirmed native transport close on every cancellation. */
  readonly requireTransportProof?: true;
  /** Exact owned dispatcher was destroyed and joined. False if still open. */
  confirmTransportClosed?(): Promise<boolean>;
  /** Optional exact Host-owned transport. Only the gateway calls it after it
   * has committed the metered attempt. No Guest data selects the dispatcher. */
  assertDispatchCurrent?(signal: AbortSignal): Promise<void>;
  fetchOwned?: (
    fetch: typeof globalThis.fetch,
    request: Request,
    init: RequestInit,
  ) => Promise<Response>;
  /** Inject an HTTP-fetch provider. Native loader configuration MUST pin SSE;
   * WebSocket or a separate SDK transport cannot bypass this host meter.
   * Model/refresh endpoints must accept one-shot request bodies (native POST).
   * GET/HEAD are rejected before dispatch: their null body permits hidden 421
   * replay. SDK retries via separate fetch calls remain individually metered. */
  stream(
    binding: ModelCallBinding,
    input: GatewayModelInput,
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk>;
  /** Fixed host configuration recognizes its model and refresh endpoints;
   * never select credentials, owners or arbitrary destinations from guest data.
   * auth-refresh requires the host credential owner to wrap its whole existing
   * modify/modifyRecord + persistence Promise with withGatewayAuthTransaction.
   * Refresh keeps its native independent timeout signal after it starts;
   * cancellation/revocation/close still prevents any subsequent model fetch. */
  classify(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): GatewayFetchClassification | null;
}

export type ModelUsage = Readonly<{
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
  usageComplete: boolean;
  cacheUsageKnown: boolean;
}>;
export type ModelAttemptStart = Readonly<{
  id: string;
  callId: string;
  personId: string;
  ownerId: string;
  kind: GatewayFetchClassification['kind'];
  protocol: GatewayFetchClassification['protocol'];
}>;
export type ModelAttemptReceipt = ModelAttemptStart &
  Readonly<{
    /** null on crash: durable intent cannot prove that the upstream received it. */
    dispatchObserved: boolean | null;
    httpStatus: number | null;
    terminal: 'completed' | 'failed' | 'incomplete' | null;
    /** Explicit wire reason only. Older/unknown receipts omit this fact. */
    terminalReason?: 'max_output_tokens' | null;
    /** unknown closure does not erase independently observed wire facts. */
    outcome: 'closed' | 'failed' | 'canceled' | 'unknown';
    usage: ModelUsage;
  }>;
export interface CapacitySubscription {
  wait(): Promise<void>;
  close(): Promise<void>;
}
export interface ModelGatewayStore {
  /** Commit exact native authorization before delivering any Guest reference. */
  reserveNativeCall?(binding: ModelCallBinding): Promise<void>;
  /** Immutable unique native call claim. Duplicate/reconnect never dispatches. */
  claimCall(binding: ModelCallBinding, requestDigest: string): Promise<string>;
  /** Subscribe BEFORE tryStartAttempt, then recheck after each notification. */
  watchCapacity(
    personId: string,
    signal: AbortSignal,
  ): Promise<CapacitySubscription>;
  /** Atomically persist intent + global person slot. False means queue. */
  tryStartAttempt(attempt: ModelAttemptStart): Promise<boolean>;
  /** Commit receipt before releasing its exact slot; failure keeps it occupied.
   * outcome=unknown preserves observed facts but retains the lease until the
   * authority confirms the exact owner's transport has stopped. */
  finishAttempt(receipt: ModelAttemptReceipt): Promise<void>;
  attempts(callId: string): Promise<readonly ModelAttemptReceipt[]>;
  usage(personId: string, organizationId: string): Promise<RuntimeRunUsage>;
  /** Internal owner port; public caller goes through ModelGatewayPort.reconcileOwner. */
  reconcileOwner(ownerId: string, evidenceRef: string): Promise<number>;
}
export interface UsageLedgerPort {
  summarize(
    context: RequestContext,
    signal: AbortSignal,
  ): Promise<RuntimeRunUsage>;
}
export interface ModelGatewayPort {
  /** Trusted Worker shutdown only; exact dispatcher proof is bound at construction. */
  reconcileClosedOwner?(signal: AbortSignal): Promise<number>;
  /** Exact freeze/observe/subscribe/thaw protocol owned by the shared host.
   * A gateway-only thaw is not permission to wake, advance epoch or dispatch. */
  readonly admission: PersonVmAdmissionPort;
  /** Called only by the trusted host route. Headers/body never supply binding. */
  handle(
    request: IncomingMessage,
    response: ServerResponse,
    binding: ModelCallBinding,
    signal: AbortSignal,
  ): Promise<void>;
  /** Host-only reference issuance uses the same gateway participant and drain. */
  issueReference?<T>(
    binding: ModelCallBinding,
    signal: AbortSignal,
    issue: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
  /** Host revocation is active cancellation; resolves after actual owned drain. */
  revoke(binding: PersonVmBinding): Promise<void>;
  reconcileOwner(
    context: RequestContext,
    ownerId: string,
    signal: AbortSignal,
  ): Promise<number>;
  close(): Promise<void>;
  readonly ledger: UsageLedgerPort;
}
export type ModelGatewayErrorCode =
  | 'AUTHORIZATION_DENIED'
  | 'BINDING_INVALID'
  | 'INVALID_INPUT'
  | 'INPUT_TOO_LARGE'
  | 'DUPLICATE_CALL'
  | 'ADMISSION_CLOSED'
  | 'EXECUTION_REBIND_REQUIRED'
  | 'UNCLASSIFIED_UPSTREAM'
  | 'UNSUPPORTED_UPSTREAM'
  | 'AUTH_TRANSACTION_REQUIRED'
  | 'MISSING_UPSTREAM_TERMINAL'
  | 'PROVIDER_FAILED'
  | 'LEDGER_UNAVAILABLE';
export class ModelGatewayError extends Error {
  constructor(
    readonly code: ModelGatewayErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'ModelGatewayError';
  }
}
