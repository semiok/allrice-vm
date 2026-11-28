import { DEntryProfileDocumentSchema } from '@allrice/contracts';
import {
  DataAccessError,
  readDEntryEmployeeDirectory,
} from '@allrice/database';
import {
  initialDocumentLifecycle,
  publicStartupBundleUrls,
} from './initial-document';
import { readDEntryWorkerJson, requestDEntryProfile } from './native-worker';
import { profileAddress, profileDirectory, type profileInput } from './profile';
import { readLocalProfileAssets } from './released-profile-assets';

const escapeAttribute = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;');
const safeJson = (value: unknown) =>
  JSON.stringify(value).replaceAll('<', '\\u003c');

export async function renderEmployeeDocument(
  request: Request,
  input: Awaited<ReturnType<typeof profileInput>>,
  target: string | Awaited<ReturnType<typeof profileAddress>>,
) {
  const inline = typeof target === 'string';
  const scopeId = inline ? target : target.scopeId;
  const { selection } = input;
  const tenant = input.context.organizationId;
  if (input.context.actor.type !== 'user')
    throw new DataAccessError('not_found');
  const [local, directory] = await Promise.all([
    readLocalProfileAssets(),
    readDEntryEmployeeDirectory(input.context, selection, request.signal),
  ]);
  // Directory and local static metadata finish before the final native grant.
  // That response addresses the exact same release as its bootstrap.
  const document = inline
    ? await readDEntryWorkerJson(
        await requestDEntryProfile(
          input,
          'bootstrap',
          { scopeId },
          'inline-document',
        ),
        DEntryProfileDocumentSchema.parse,
      )
    : undefined;
  const address = inline
    ? { ...document!.address, selection, scopeId }
    : target;
  const { bindingRef, graphRev } = address;
  const released = local?.stamp === address.manifestSha256 ? local : undefined;
  const bootstrap = document?.bootstrap;
  const assets = profileDirectory('static', address);
  const native = profileDirectory('document', address) + '/native/';
  // The full Worker bootstrap rechecks the exact admitted page/root after
  // the SQL read. The legacy document only has the current address check.
  if (!inline) {
    const current = await profileAddress(input, scopeId);
    if (
      current.nativeSessionId !== address.nativeSessionId ||
      current.bindingRef !== bindingRef ||
      current.graphRev !== graphRev ||
      current.manifestSha256 !== address.manifestSha256
    )
      throw new DataAccessError('not_found');
  }
  if (
    bootstrap &&
    (bootstrap.scopeReference.scopeId !== scopeId ||
      bootstrap.bindingRef !== bindingRef ||
      bootstrap.graph.rev !== graphRev)
  )
    throw new DataAccessError('not_found');
  const bootstrapScript = bootstrap
    ? '<script id="allrice-employee-bootstrap" type="application/json">' +
      safeJson(bootstrap) +
      '</script>'
    : '';
  const earlyBundles =
    bootstrap && released ? publicStartupBundleUrls(bootstrap, released) : [];
  const earlyAttribute = earlyBundles.length
    ? ` data-public-startup-bundles="${escapeAttribute(JSON.stringify(earlyBundles))}"`
    : '';
  const staticAsset = (path: string, fallback: string) =>
    released?.paths.has(path) ? released.root + path : fallback;
  const directoryJson = safeJson(directory);
  const attributes = [
    ['scope-id', scopeId],
    ...(inline ? [['shared-mux', '1']] : []),
    ['binding-ref', bindingRef],
    ['graph-rev', graphRev],
    ['organization-id', tenant],
    ['workspace-id', selection.workspaceId],
    ['employee-instance-id', selection.employeeInstanceId],
    ['thread-id', selection.threadId ?? ''],
    ['viewer-id', input.context.actor.id],
    ['login-session-id', input.context.sessionId],
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
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>员工工作区</title><script data-scope-id="${escapeAttribute(scopeId)}"${earlyAttribute}>${initialDocumentLifecycle}</script><link rel="stylesheet" data-allrice-document-asset="style" href="${staticAsset('native/assets/index-BxpfOGf3.css', native + 'assets/index-BxpfOGf3.css')}"><link rel="stylesheet" data-allrice-document-asset="style" href="${staticAsset('native/assets/vendor-DV2921Zo.css', native + 'assets/vendor-DV2921Zo.css')}"><link rel="stylesheet" data-allrice-document-asset="style" href="${staticAsset('managed/employee-web-entry.css', assets + '/managed/employee-web-entry.css')}"></head><body><div id="app" style="height:100%" ${attributes}></div><script id="allrice-employee-directory" type="application/json">${directoryJson}</script>${bootstrapScript}<script type="module" data-allrice-document-asset="entry" src="${staticAsset('managed/employee-web-entry.js', assets + '/managed/employee-web-entry.js')}"></script></body></html>`;
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
}
