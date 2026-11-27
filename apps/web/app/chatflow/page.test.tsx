import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdentityError } from '@allrice/database';
import type * as Database from '@allrice/database';
import ChatFlowPage from './page';
import EmployeeNativeEntryPage from './4.0/page';
import { EmployeeFirstStart } from './4.0/employee-first-start';

const entry = vi.hoisted(() => ({
  host: 'localhost',
  context: vi.fn(),
  find: vi.fn(),
  released: vi.fn(),
  createWorkspace: vi.fn(),
  prepareRoster: vi.fn(),
}));
vi.mock('@allrice/database', async (importOriginal) => ({
  ...(await importOriginal<typeof Database>()),
  preparePersonNativeWebRoster: entry.prepareRoster,
}));
vi.mock('./chatflow-client', () => ({ ChatFlowClient: () => null }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: entry.host }),
}));
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw Error(path);
  },
}));
vi.mock('../../lib/identity/session', () => ({
  getRequestContext: entry.context,
}));
vi.mock('../../lib/d-entry/entry-threads', () => ({
  findDEntryEmployee: entry.find,
  findDEntryCreationWorkspace: entry.createWorkspace,
  isDEntryPersonReleased: entry.released,
}));

describe('ChatFlow server local command capability', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
    entry.host = 'localhost';
  });

  it.each([
    ['0', '0', '0', false],
    ['1', '0', '1', false],
    ['1', '1', '0', false],
    ['0', '1', '1', true],
    ['1', '1', '1', true],
  ])(
    'keeps file confirmation available without the command runner (%s/%s/%s)',
    async (command, policy, ledger, enabled) => {
      vi.stubEnv('ALLRICE_LOCAL_COMMAND_ENABLED', command);
      vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', policy);
      vi.stubEnv('ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED', ledger);
      const page = await ChatFlowPage({ searchParams: Promise.resolve({}) });
      expect(page.props.localCommandsEnabled).toBe(enabled);
      expect(entry.context).not.toHaveBeenCalled();
    },
  );
  it('opens 4.0 from the trial login destination for a released person with an empty roster', async () => {
    entry.host = 'allricevm.bplabs.xyz';
    entry.context.mockResolvedValue({ actor: { id: 'owner' } });
    entry.released.mockResolvedValue(true).mockResolvedValueOnce(false);
    await expect(
      ChatFlowPage({ searchParams: Promise.resolve({}) }),
    ).resolves.toHaveProperty('props');
    await expect(
      ChatFlowPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow('/chatflow/4.0');
    await expect(
      ChatFlowPage({
        searchParams: Promise.resolve({ session: 'legacy-bookmark' }),
      }),
    ).resolves.toHaveProperty('props');
    await expect(
      ChatFlowPage({ searchParams: Promise.resolve({ employee: '' }) }),
    ).rejects.toThrow('/chatflow/4.0');
    await expect(
      ChatFlowPage({ searchParams: Promise.resolve({ employee: 'selected' }) }),
    ).resolves.toHaveProperty('props');
    await expect(
      ChatFlowPage({
        searchParams: Promise.resolve({
          employee: '',
          session: 'legacy-bookmark',
        }),
      }),
    ).resolves.toHaveProperty('props');
    entry.released.mockResolvedValueOnce(false);
    await expect(
      ChatFlowPage({ searchParams: Promise.resolve({ employee: '' }) }),
    ).resolves.toHaveProperty('props');
    entry.host = 'allrice.bplabs.xyz';
    await expect(
      ChatFlowPage({ searchParams: Promise.resolve({ employee: '' }) }),
    ).resolves.toHaveProperty('props');
    expect(entry.released).toHaveBeenCalledTimes(4);
    expect(entry.find).not.toHaveBeenCalled();
  });
  it('shows the trial failure instead of defaulting to the legacy writer when policy is unavailable', async () => {
    entry.host = 'allricevm.bplabs.xyz';
    entry.context.mockResolvedValue({ actor: { id: 'owner' } });
    entry.released.mockRejectedValue(Error('policy unavailable'));
    await expect(
      ChatFlowPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow('/chatflow/4.0');
  });
  it('offers the first employee form only with an authorized creation workspace', async () => {
    entry.context.mockResolvedValue({
      actor: { type: 'user', id: 'owner' },
      organizationId: 'organization',
    });
    entry.find.mockResolvedValue(null);
    entry.prepareRoster.mockResolvedValue({ entries: [] });
    entry.createWorkspace
      .mockResolvedValueOnce('writable')
      .mockResolvedValueOnce(null);
    const input = { searchParams: Promise.resolve({}) };
    const empty = await EmployeeNativeEntryPage(input);
    expect(empty.type).toBe(EmployeeFirstStart);
    expect(empty.props).toEqual({
      organizationId: 'organization',
      workspaceId: 'writable',
      viewerId: 'owner',
    });
    const denied = await EmployeeNativeEntryPage(input);
    expect(denied.type).not.toBe(EmployeeFirstStart);
    expect(denied.props).toMatchObject({ query: '', prepare: true });
  });
  it('opens an existing assignment materialized during the zero employee check', async () => {
    const selected = {
      workspaceId: 'writable',
      employeeInstanceId: 'assigned',
    };
    const owner = {
      actor: { type: 'user', id: 'owner' },
      organizationId: 'organization',
      workspaceId: 'writable',
    };
    entry.context.mockResolvedValue(owner);
    entry.find.mockResolvedValueOnce(null).mockResolvedValueOnce(selected);
    entry.createWorkspace.mockResolvedValue(selected.workspaceId);
    entry.prepareRoster.mockResolvedValue({ entries: [selected] });
    const page = await EmployeeNativeEntryPage({
      searchParams: Promise.resolve({}),
    });
    expect(entry.prepareRoster).toHaveBeenCalledWith(owner);
    expect(page.props).toMatchObject({
      query: 'workspaceId=writable&employeeInstanceId=assigned',
      prepare: true,
    });
  });
  it('renders the denied trial entry when the original login has lost its tenant', async () => {
    entry.host = 'allricevm.bplabs.xyz';
    entry.context.mockRejectedValue(
      new IdentityError('tenant_context_invalid'),
    );
    const input = { searchParams: Promise.resolve({}) };
    await expect(ChatFlowPage(input)).rejects.toThrow('/chatflow/4.0');
    const denied = await EmployeeNativeEntryPage(input);
    expect(denied.props).toMatchObject({
      query: '',
      prepare: true,
      initialUnavailable: false,
    });
    expect(entry.find).not.toHaveBeenCalled();
  });
});
