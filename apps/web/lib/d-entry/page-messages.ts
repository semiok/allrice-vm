import type { ChatSessionSchema } from '@allrice/contracts';

export const pageClosing = 'allrice:d-entry:close';
export const pageCompletion = 'allrice:d-entry:completion';
export const pageNavigate = 'allrice:d-entry:navigate';
export const pageRevoked = 'allrice:d-entry:revoked';
export const pageStartupFailed = 'allrice:d-entry:startup-failed';
export const pageDocumentReady = 'allrice:d-entry:document-ready';
export const pageEditorMounted = 'allrice:d-entry:editor-mounted';

export const pageNativeThreadRegistered =
  'allrice:d-entry:native-thread-registered';
export const pageNativeThreadSelected =
  'allrice:d-entry:native-thread-selected';
export type PageNativeThreadRegistration = {
  scopeId: string;
  nativeSessionId: string;
  thread: ReturnType<typeof ChatSessionSchema.parse>;
};
