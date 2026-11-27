import type { WorkbenchDeliverable } from '../../../../contracts/src/index';
import type { EmployeePanelDataMethod } from '../../../../../apps/web/lib/chatflow/employee-panel-data';

export type PanelDataState =
  'list' | 'empty' | 'loading' | 'error' | 'denied' | 'unbound' | 'longname';
export type PanelDataCall = {
  method: EmployeePanelDataMethod;
  input: unknown;
  aborted: boolean;
};

export interface PanelDataFixture {
  setState(value: PanelDataState): void;
  setKind(value: 'files' | 'materials'): void;
  mutateOriginal(): void;
  usePdf(base64: string): void;
  holdFavorite(): void;
  finishFavorite(): void;
  refusePreview(status?: number, code?: string, refresh?: boolean): void;
  losePublicationReply(): void;
  rejectNextPublication(): void;
  finishReceipt(): void;
  holdReceipt(): void;
  selectReceiptScope(employee: string, thread: string): void;
  selectReceiptViewer(viewer: string): void;
  evidence(): {
    calls: PanelDataCall[];
    used: unknown[];
    files: WorkbenchDeliverable[];
    copies: [string, string][];
    writes: [string, { sourceId: string; revisionId: string }][];
  };
}
declare global {
  interface Window {
    __panelDataFixture: PanelDataFixture;
  }
}
