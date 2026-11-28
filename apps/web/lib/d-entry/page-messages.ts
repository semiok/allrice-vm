import type {
  ChatSessionSchema,
  DEntryPageSwitchResultSchema,
} from '@allrice/contracts';

export const pageClosing = 'allrice:d-entry:close';
export const pageCompletion = 'allrice:d-entry:completion';
export const pageEmployeeArchived = 'allrice:d-entry:employee-archived';
export const pageNavigate = 'allrice:d-entry:navigate';
export const pageRevoked = 'allrice:d-entry:revoked';
export const pageStartupFailed = 'allrice:d-entry:startup-failed';
export const pageDocumentReady = 'allrice:d-entry:document-ready';
export const pageEditorMounted = 'allrice:d-entry:editor-mounted';
export const pageMuxAttach = 'allrice:d-entry:mux-attach';
export const pageSwitchReady = 'allrice:d-entry:switch-ready';
export const pageThreadSwitchPrepare = 'allrice:d-entry:thread-switch-prepare';
export const pageThreadSwitchPrepared =
  'allrice:d-entry:thread-switch-prepared';
export const pageThreadSwitchCancel = 'allrice:d-entry:thread-switch-cancel';
export const pageThreadScope = 'allrice:d-entry:thread-scope';
export const pageThreadSelected = 'allrice:d-entry:thread-selected';
export type PageThreadScope = Extract<
  ReturnType<typeof DEntryPageSwitchResultSchema.parse>,
  { type: 'switched' }
>;

export const pageNativeThreadRegistered =
  'allrice:d-entry:native-thread-registered';
export const pageNativeThreadSelected =
  'allrice:d-entry:native-thread-selected';
export type PageNativeThreadRegistration = {
  scopeId: string;
  resourceScopeId: string;
  nativeSessionId: string;
  thread: ReturnType<typeof ChatSessionSchema.parse>;
};
