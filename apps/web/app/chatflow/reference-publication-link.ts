import { UuidSchema } from '@allrice/contracts';

/** Application location only; each read still authenticates the current viewer. */
export function referencePublicationLink(
  workspaceId: string,
  sourceId: string,
  revisionId: string,
  organizationId?: string,
) {
  // The native 4.0 entry accepts employee selections. The shared material
  // preview keeps its compatible /chatflow address and exact revision.
  const url = new URL('/chatflow', window.location.origin);
  url.search = new URLSearchParams({
    workspaceId,
    referenceSource: sourceId,
    referenceRevision: revisionId,
  }).toString();
  if (organizationId) url.searchParams.set('organizationId', organizationId);
  return url.href;
}

export function readReferencePublicationLocation() {
  const params = new URLSearchParams(window.location.search);
  if (
    ['workspaceId', 'referenceSource', 'referenceRevision'].some(
      (key) => params.getAll(key).length !== 1,
    )
  )
    return null;
  const organizations = params.getAll('organizationId');
  const organization = organizations.length
    ? UuidSchema.safeParse(organizations[0])
    : undefined;
  if (organizations.length > 1 || (organization && !organization.success))
    return null;
  const source = UuidSchema.safeParse(params.get('referenceSource'));
  const revision = UuidSchema.safeParse(params.get('referenceRevision'));
  const workspace = UuidSchema.safeParse(params.get('workspaceId'));
  return source.success && revision.success && workspace.success
    ? {
        sourceId: source.data,
        revisionId: revision.data,
        workspaceId: workspace.data,
        ...(organization?.success && { organizationId: organization.data }),
      }
    : null;
}

export function clearReferencePublicationLocation() {
  const url = new URL(window.location.href);
  if (
    !url.searchParams.has('referenceSource') &&
    !url.searchParams.has('referenceRevision')
  )
    return;
  url.searchParams.delete('referenceSource');
  url.searchParams.delete('referenceRevision');
  url.searchParams.delete('workspaceId');
  url.searchParams.delete('organizationId');
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
}
