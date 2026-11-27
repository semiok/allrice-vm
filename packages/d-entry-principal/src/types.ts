import { z } from 'zod';
import { DEntryIdentitySchema, UuidSchema } from '@allrice/contracts';
import type { Context } from '@deepseek-ai/cordis';
import type { DEntryIdentity } from '@allrice/contracts';
import type { RemoteAccessBaseline } from '@deepseek-ai/dsh-api-remote-access';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { TYPERT_REMOTE as Native } from '@deepseek-ai/dsh-api-session-controller/remote';
import type { TYPERT_REMOTE as Access } from '@deepseek-ai/dsh-api-remote-access/remote';
import type {
  RemoteEventDownlinkFrame,
  REMOTE_EVENT_STREAM_PAYLOAD,
} from '@deepseek-ai/dsh-api-gateway/stream-protocol';
import type {
  PrincipalMap,
  TypertRemoteInputOptions,
  TypertRemoteValue,
} from '@deepseek-ai/dsh-typert-protocol';

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    'allrice-d-entry': Readonly<{
      kind: 'allrice-d-entry';
      scopeId: string;
      identity: DEntryIdentity;
    }>;
  }
}
export type DEntryPrincipal = PrincipalMap['allrice-d-entry'];
export type DEntryPrincipalIssue = Readonly<{
  scopeId: string;
  identity: DEntryIdentity;
  access: 'history' | 'execute';
  root: Readonly<{
    nativeSessionId: string;
    rootOriginDigest: string;
    rootBindingRef: string;
    forkedFromNativeSessionId?: string;
  }>;
}>;
export type DEntryScopeIssue =
  | DEntryPrincipalIssue
  | Readonly<{
      scopeId: string;
      identity: DEntryIdentity;
      access: 'page';
      root?: DEntryPrincipalIssue['root'];
      terminalOwner?: true;
    }>;
export type CloseCommand = 'close';
export const D_ENTRY_PAGE_UPLINK_BYTES = 262_144;
export type DEntryPageInput =
  | Readonly<{ type: 'input'; value?: JsonValue }>
  | Readonly<{ type: 'input-end' }>;
export type NonOwnerBaseline = Extract<RemoteAccessBaseline, { owner: false }>;
export type ScopeFrame =
  | Readonly<{
      type: 'opened';
      scopeId: string;
      principal: DEntryPrincipal;
      baseline: NonOwnerBaseline;
      followWithdrawals?: true;
    }>
  | Readonly<{ type: 'revoked'; scopeId: string }>
  | Readonly<{ type: 'follow-revoked'; scopeId: string; followId: string }>
  | Readonly<{ type: 'closed'; scopeId: string }>;
export type InputOf<M> = M extends {
  input(options?: TypertRemoteInputOptions): TypertRemoteValue<infer I>;
}
  ? I
  : never;
export type OutputOf<M> = M extends { result: TypertRemoteValue<infer O> }
  ? O
  : never;
type NativeMethods = typeof Native.methods;
type AccessMethods = typeof Access.methods;
export type NativeUnary =
  | 'session/list'
  | 'session/attachment'
  | 'session/page'
  | 'session/projections'
  | 'skills/list'
  | 'session/prompt'
  | 'session/updateQueue'
  | 'session/cancel'
  | 'session/rename'
  | 'session/selectModel';
type Calls<K extends keyof NativeMethods> = {
  [E in K]: Readonly<{
    scopeId: string;
    endpoint: E;
    args: InputOf<NativeMethods[E]>;
  }>;
}[K];
export type DEntryScopedUnaryCall = Calls<NativeUnary>;
export type DEntryScopedUnaryResult = {
  [E in NativeUnary]: Readonly<{
    endpoint: E;
    value: OutputOf<NativeMethods[E]>;
  }>;
}[NativeUnary];
export type DEntryPageNativeCall = Readonly<{
  kind: 'page';
  scopeId: string;
  endpoint: string;
  args: Readonly<Record<string, JsonValue>>;
  followId?: string;
}>;
export type DEntryPageNativeResult = Readonly<{
  kind: 'page';
  endpoint: string;
  value?: JsonValue;
  attachments: readonly Readonly<{
    path: readonly (string | number)[];
    bytes: Uint8Array;
  }>[];
}>;
export type DEntryScopedStreamCall =
  | Calls<'session/control' | 'session/follow'>
  | Readonly<{
      scopeId: string;
      endpoint: 'remoteAccess/follow';
      args: InputOf<AccessMethods['remoteAccess/follow']>;
    }>
  | Readonly<{
      kind: 'events';
      scopeId: string;
      payload: typeof REMOTE_EVENT_STREAM_PAYLOAD;
    }>;
type ScopedEventFrame =
  | Extract<RemoteEventDownlinkFrame, { type: 'ready' }>
  | (Omit<Extract<RemoteEventDownlinkFrame, { type: 'emit' }>, 'args'> & {
      readonly args: readonly JsonValue[];
    });
export type DEntryScopedStreamFrame =
  | Readonly<{ type: 'closed'; scopeId: string }>
  | Readonly<{
      type: 'item';
      scopeId: string;
      value:
        | OutputOf<NativeMethods['session/control']>
        | OutputOf<NativeMethods['session/follow']>
        | OutputOf<AccessMethods['remoteAccess/follow']>
        | ScopedEventFrame;
    }>;
type StreamItem = Extract<DEntryScopedStreamFrame, { type: 'item' }>;
export type DEntryPageNativeItem = Readonly<{
  type: 'page-item';
  scopeId: string;
  value: JsonValue;
}>;
export type DEntryPageNativeError = Readonly<{
  type: 'page-error';
  scopeId: string;
  error: Readonly<{ code: string; message: string; details: JsonValue }>;
}>;
export type DEntryPrincipalStream = AsyncIterable<StreamItem> & {
  close(): Promise<void>;
};
export interface DEntryPrincipalControlScope {
  readonly opened: Extract<ScopeFrame, { type: 'opened' }>;
  readonly revoked: AbortSignal;
  invoke(
    call: DEntryScopedUnaryCall,
    signal: AbortSignal,
  ): Promise<DEntryScopedUnaryResult>;
  invokePage(
    call: DEntryPageNativeCall,
    signal: AbortSignal,
  ): Promise<DEntryPageNativeResult>;
  stream(
    call: DEntryScopedStreamCall,
    signal: AbortSignal,
    observed?: {
      item(frame: StreamItem): void;
      terminal(): void;
    },
  ): DEntryPrincipalStream;
  streamPage(
    call: DEntryPageNativeCall,
    signal: AbortSignal,
  ): AsyncIterable<DEntryPageNativeItem> & {
    readonly revoked?: AbortSignal;
    send(input: DEntryPageInput): void;
  };
  close(): Promise<void>;
}
export interface DEntryPrincipalActivity {
  run(signal: AbortSignal): Promise<DEntryPrincipalControlScope>;
  close(): Promise<void>;
}
export type PrincipalClientContext = Context;

const scopeSchema = z
  .object({
    scopeId: UuidSchema,
    identity: DEntryIdentitySchema,
    access: z.enum(['history', 'execute']),
    root: z
      .object({
        nativeSessionId: z.string().min(1),
        rootOriginDigest: z.string().min(1),
        rootBindingRef: z.string().min(1),
        forkedFromNativeSessionId: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();
export const DEntryPrincipalIssueSchema = scopeSchema;
export const DEntryScopeIssueSchema = z.union([
  scopeSchema,
  scopeSchema.extend({
    access: z.literal('page'),
    root: scopeSchema.shape.root.optional(),
    terminalOwner: z.literal(true).optional(),
  }),
]);
