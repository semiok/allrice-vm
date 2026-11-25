import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { runtimeFeatureEnabled } from '@allrice/contracts';
import { ChatFlowClient } from './chatflow-client';
import {
  localOperationsFeatureEnabled,
  localMcpEnabled,
} from '@allrice/database';
import { findDEntryEmployee } from '../../lib/d-entry/entry-threads';
import { getRequestContext } from '../../lib/identity/session';
import { normalizeHost } from '../../lib/portal/config';

export const dynamic = 'force-dynamic';

export default async function ChatFlowPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const requestHeaders = await headers();
  // The trial host's unqualified login destination is /chatflow. Existing
  // conversation links and other employee portals keep their original writer.
  if (
    normalizeHost(requestHeaders.get('host')) === 'allricevm.bplabs.xyz' &&
    !Object.keys(await searchParams).length
  ) {
    const context = await getRequestContext(
      new Request('https://allricevm.bplabs.xyz/chatflow', {
        headers: requestHeaders,
      }),
    );
    if (context && (await findDEntryEmployee(context)))
      redirect('/chatflow/4.0');
  }
  return (
    <ChatFlowClient
      workbenchEnabled={runtimeFeatureEnabled('ALLRICE_WORKBENCH_ENABLED')}
      localCommandsEnabled={localOperationsFeatureEnabled()}
      localMcpEnabled={localMcpEnabled()}
    />
  );
}
