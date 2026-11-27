import {
  DataAccessError,
  readDEntryEmployeeDirectory,
} from '@allrice/database';
import { apiProblem } from '../../../../../lib/api-error-response';
import {
  profileAddress,
  profileDirectory,
  profileInput,
  profileStaticFile,
  readProfileDirectory,
} from '../../../../../lib/d-entry/profile';
import { dEntryErrorResponse } from '../../../../../lib/d-entry/responses';
import { initialDocumentLifecycle } from '../../../../../lib/d-entry/initial-document';
import { readReleasedProfileAssets } from '../../../../../lib/d-entry/released-profile-assets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const unavailable = () =>
  apiProblem({
    status: 403,
    code: 'AUTHORIZATION_DENIED',
    message: 'This native route requires the Host owner',
    retryable: false,
  });
const escapeAttribute = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;');
type Params = { params: Promise<{ publicationPath: string[] }> };
export async function GET(request: Request, { params }: Params) {
  try {
    const target = readProfileDirectory(
      request,
      (await params).publicationPath,
    );
    const input = await profileInput(request, target.selection);
    if (target.path === 'native/api/file') {
      await qualifyDocument(input, target);
      return unavailable();
    }
    if (new URL(request.url).search) throw new DataAccessError('not_found');
    if (target.path !== 'native/index.html')
      return await profileStaticFile(input, target, target.path);
    const address = await qualifyDocument(input, target);
    const assets = profileDirectory('static', address);
    const released = await readReleasedProfileAssets(address.manifestSha256);
    const staticAsset = (path: string, fallback: string) =>
      released?.paths.has(path) ? released.root + path : fallback;
    const { scopeId, bindingRef, graphRev, selection } = address;
    const tenant = input.context.organizationId;
    if (input.context.actor.type !== 'user')
      throw new DataAccessError('not_found');
    const directory = await readDEntryEmployeeDirectory(
      input.context,
      selection,
      request.signal,
    );
    const directoryJson = JSON.stringify(directory).replaceAll('<', '\\u003c');
    const attributes = [
      ['scope-id', scopeId],
      ['binding-ref', bindingRef],
      ['graph-rev', graphRev],
      ['organization-id', tenant],
      ['workspace-id', selection.workspaceId],
      ['employee-instance-id', selection.employeeInstanceId],
      ['thread-id', selection.threadId ?? ''],
      ['viewer-id', input.context.actor.id],
      ['native-session-id', address.nativeSessionId],
      ...(released
        ? [
            ['public-asset-root', released.root],
            ['public-bundles', JSON.stringify(released.bundles)],
          ]
        : []),
    ]
      .map(([key, value]) => `data-${key}="${escapeAttribute(value!)}"`)
      .join(' ');
    // The upstream viewport rule targets #root. This document mounts at #app.
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>员工工作区</title><script data-scope-id="${escapeAttribute(scopeId)}">${initialDocumentLifecycle}</script><link rel="stylesheet" data-allrice-document-asset="style" href="${staticAsset('native/assets/index-BxpfOGf3.css', 'assets/index-BxpfOGf3.css')}"><link rel="stylesheet" data-allrice-document-asset="style" href="${staticAsset('native/assets/vendor-DV2921Zo.css', 'assets/vendor-DV2921Zo.css')}"><link rel="stylesheet" data-allrice-document-asset="style" href="${staticAsset('managed/employee-web-entry.css', assets + '/managed/employee-web-entry.css')}"></head><body><div id="app" style="height:100%" ${attributes}></div><script id="allrice-employee-directory" type="application/json">${directoryJson}</script><script type="module" data-allrice-document-asset="entry" src="${staticAsset('managed/employee-web-entry.js', assets + '/managed/employee-web-entry.js')}"></script></body></html>`;
    // The SQL directory does not own the long-lived Worker carrier. Carry
    // the original request back across that boundary after the database read.
    const current = await qualifyDocument(input, target);
    if (current.nativeSessionId !== address.nativeSessionId)
      throw new DataAccessError('not_found');
    request.signal.throwIfAborted();
    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'private, no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'content-security-policy':
          "frame-ancestors 'self'; base-uri 'none'; object-src 'none'",
      },
    });
  } catch (error) {
    return dEntryErrorResponse(error);
  }
}
export async function POST(request: Request, { params }: Params) {
  try {
    const target = readProfileDirectory(
      request,
      (await params).publicationPath,
    );
    if (target.path !== 'native/api/session/uploadFileBinary')
      throw new DataAccessError('not_found');
    await qualifyDocument(
      await profileInput(request, target.selection),
      target,
    );
    return unavailable();
  } catch (error) {
    return dEntryErrorResponse(error);
  }
}

async function qualifyDocument(
  input: Awaited<ReturnType<typeof profileInput>>,
  target: ReturnType<typeof readProfileDirectory>,
) {
  const address = await profileAddress(input, target.scopeId);
  if (
    target.bindingRef !== address.bindingRef ||
    target.manifestSha256 !== address.manifestSha256 ||
    target.graphRev !== address.graphRev
  )
    throw new DataAccessError('not_found');
  return address;
}
