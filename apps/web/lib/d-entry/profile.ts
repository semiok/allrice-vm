import {
  DEntryPageBorrowSchema,
  DEntryPageSwitchProofSchema,
  DEntryProfileAddressSchema,
  DEntryProfileAssetSchema,
  DEntryProfileBindingSchema,
  DEntryProfileFilePathSchema,
} from '@allrice/contracts';
import type { DEntrySelectionInput } from '@allrice/contracts';
import { DataAccessError } from '@allrice/database';
import { z } from 'zod';
import { requireRequestContext } from '../identity/session';
import {
  authenticateNativeRequest,
  currentNativeRequest,
} from './native-request';
import { requestDEntryProfile, readDEntryWorkerJson } from './native-worker';
import { dEntryErrorResponse } from './responses';

type Address = z.infer<typeof DEntryProfileAddressSchema>;
export type ProfileLocation = Address & {
  selection: DEntrySelectionInput;
  scopeId: string;
};

export function exactProfileQuery(url: string) {
  const { searchParams } = new URL(url);
  if (
    [...searchParams.keys()].some(
      (key) => searchParams.getAll(key).length !== 1,
    )
  )
    throw new SyntaxError('Entry selectors must be unique');
  return Object.fromEntries(searchParams);
}
export function profileDirectory(
  area: 'document' | 'static',
  location: ProfileLocation,
) {
  const parts = [
    location.scopeId,
    location.selection.workspaceId,
    location.selection.employeeInstanceId,
    location.selection.threadId ?? '_',
    location.bindingRef,
    location.graphRev,
    location.manifestSha256,
  ]
    .map(encodeURIComponent)
    .join('/');
  return area === 'document'
    ? `/chatflow/4.0/document/${parts}`
    : `/api/v1/d-entry/profile/assets/static/${parts}`;
}
export function readProfileDirectory(request: Request, parts: string[]) {
  if (new URL(request.url).pathname.includes('%') || parts.length < 8)
    throw new DataAccessError('not_found');
  const [
    scopeId,
    workspaceId,
    employeeInstanceId,
    threadId,
    bindingRef,
    graphRev,
    manifestSha256,
    ...rest
  ] = parts;
  const { scopeId: id, ...selection } = DEntryPageBorrowSchema.parse({
    scopeId,
    workspaceId,
    employeeInstanceId,
    ...(threadId === '_' ? {} : { threadId }),
  });
  const path = DEntryProfileFilePathSchema.parse(rest.join('/'));
  return {
    ...DEntryProfileAddressSchema.parse({
      bindingRef,
      graphRev,
      manifestSha256,
    }),
    scopeId: id,
    selection,
    path,
  };
}
export async function profileInput(
  request: Request,
  selection: DEntrySelectionInput,
) {
  const context = await requireRequestContext(request);
  return currentNativeRequest(request, selection, context, 'history');
}
export async function profileAddress(
  input: Awaited<ReturnType<typeof profileInput>>,
  scopeId: string,
): Promise<ProfileLocation & { nativeSessionId: string }> {
  const address = await readDEntryWorkerJson(
    await requestDEntryProfile(input, 'bootstrap', { scopeId }, 'document'),
    (value) =>
      DEntryProfileAddressSchema.extend({
        nativeSessionId: z.string().min(1),
      }).parse(value),
  );
  return { ...address, scopeId, selection: input.selection };
}
function trustedResponse(response: Response) {
  const headers = new Headers({
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  });
  for (const name of ['content-type', 'content-length']) {
    const value = response.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers });
}
export async function profileGet(
  request: Request,
  type: 'bootstrap' | 'assets' | 'events',
) {
  try {
    const context = await requireRequestContext(request);
    const contract =
      type === 'bootstrap'
        ? DEntryPageBorrowSchema
        : type === 'events'
          ? DEntryProfileBindingSchema
          : DEntryProfileAssetSchema;
    const { workspaceId, employeeInstanceId, threadId, ...selectors } =
      contract.parse(exactProfileQuery(request.url));
    const input = await currentNativeRequest(
      request,
      { workspaceId, employeeInstanceId, threadId },
      context,
      'history',
    );
    return trustedResponse(await requestDEntryProfile(input, type, selectors));
  } catch (error) {
    return dEntryErrorResponse(error);
  }
}
export async function profileStaticFile(
  input: Awaited<ReturnType<typeof profileInput>>,
  location: ProfileLocation,
  path: string,
) {
  const { bindingRef, graphRev, manifestSha256, scopeId } = location;
  return trustedResponse(
    await requestDEntryProfile(
      input,
      'assets',
      { bindingRef, graphRev, manifestSha256, scopeId, path },
      'static',
    ),
  );
}

export async function profileSwitch(request: Request) {
  try {
    const context = await authenticateNativeRequest(request);
    const { scopeId, requestId, targetThreadId, dispatch, ...selection } =
      DEntryPageSwitchProofSchema.parse(exactProfileQuery(request.url));
    const input = await currentNativeRequest(
      request,
      selection,
      context,
      'history',
    );
    return trustedResponse(
      await requestDEntryProfile(input, 'switch', {
        scopeId,
        requestId,
        targetThreadId,
        ...(dispatch && { dispatch }),
      }),
    );
  } catch (error) {
    return dEntryErrorResponse(error);
  }
}
