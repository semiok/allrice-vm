import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdentityError } from '@allrice/database';
import type * as Database from '@allrice/database';
import ChatFlowPage from './page';
import EmployeeNativeEntryPage from './4.0/page';
import { EmployeeFirstStart } from './4.0/employee-first-start';

const entry = vi.hoisted(() => ({
  context: vi.fn(),
  find: vi.fn(),
  createWorkspace: vi.fn(),
  prepareRoster: vi.fn(),
  hasEmployeeOrVm: vi.fn(),
}));
vi.mock('@allrice/database', async (importOriginal) => ({
  ...(await importOriginal<typeof Database>()),
  preparePersonNativeWebRoster: entry.prepareRoster,
  hasExistingDEntryEmployeeOrVm: entry.hasEmployeeOrVm,
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
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
}));

describe('4.0 employee entry', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('opens the native workbench from the login destination', () => {
    expect(() => ChatFlowPage()).toThrow('/chatflow/4.0');
    expect(entry.context).not.toHaveBeenCalled();
  });

  it('offers the first employee form only with an authorized creation workspace', async () => {
    entry.context.mockResolvedValue({
      actor: { type: 'user', id: 'owner' },
      organizationId: 'organization',
    });
    entry.find.mockResolvedValue(null);
    entry.prepareRoster.mockResolvedValue({ entries: [] });
    entry.hasEmployeeOrVm
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    entry.createWorkspace
      .mockResolvedValueOnce('writable')
      .mockResolvedValueOnce('writable')
      .mockResolvedValueOnce(null);
    const input = { searchParams: Promise.resolve({}) };
    const empty = await EmployeeNativeEntryPage(input);
    expect(empty.type).toBe(EmployeeFirstStart);
    expect(empty.props).toEqual({
      organizationId: 'organization',
      workspaceId: 'writable',
      viewerId: 'owner',
      creationBlocked: false,
    });
    const blocked = await EmployeeNativeEntryPage(input);
    expect(blocked.type).toBe(EmployeeFirstStart);
    expect(blocked.props.creationBlocked).toBe(true);
    const denied = await EmployeeNativeEntryPage(input);
    expect(denied.type).not.toBe(EmployeeFirstStart);
    expect(denied.props).toMatchObject({ query: '', prepare: true });
    expect(entry.hasEmployeeOrVm).toHaveBeenCalledTimes(2);
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
    expect(entry.hasEmployeeOrVm).not.toHaveBeenCalled();
    expect(page.props).toMatchObject({
      query: 'workspaceId=writable&employeeInstanceId=assigned',
      prepare: true,
    });
  });
  it('renders the denied trial entry when the original login has lost its tenant', async () => {
    entry.context.mockRejectedValue(
      new IdentityError('tenant_context_invalid'),
    );
    const input = { searchParams: Promise.resolve({}) };
    const denied = await EmployeeNativeEntryPage(input);
    expect(denied.props).toMatchObject({
      query: '',
      prepare: true,
      initialUnavailable: false,
    });
    expect(entry.find).not.toHaveBeenCalled();
  });
});
