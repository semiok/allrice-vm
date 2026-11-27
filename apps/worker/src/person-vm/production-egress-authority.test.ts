import { beforeEach, expect, it, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import * as Database from '@allrice/database';
import {
  createEgressGateway,
  EgressError,
  type GuestEgressAccess,
} from '@allrice/egress-gateway';
import {
  ModelGatewayError,
  type ModelCallBinding,
  type ModelGatewayAuthority,
} from '@allrice/model-gateway';
import type { PersonVmBinding } from '@allrice/person-vm';
import { admissionFixture } from '../../../../packages/egress-gateway/src/admission.fixture.ts';
import { createProductionEgressAuthority } from './production-egress-authority.js';

const db = vi.hoisted(() => ({ pin: vi.fn(), session: vi.fn() }));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  getDEntryNativeRootPin: db.pin,
  requireCurrentWorkspaceWriteAuthority: db.session,
}));

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const signal = () => new AbortController().signal;

beforeEach(() => vi.resetAllMocks());

function fixture() {
  const binding: PersonVmBinding = {
    vmId: id(1),
    personId: id(2),
    organizationId: id(3),
    instanceId: id(4),
    leaseEpoch: 1,
  };
  const endpoint = {
    workspaceId: id(5),
    employeeInstanceId: id(6),
    employeeRevision: 2,
    employeeVersionId: id(7),
    hostPort: 3200,
    guestPort: 4200,
  };
  const selection = {
    workspaceId: endpoint.workspaceId,
    employeeInstanceId: endpoint.employeeInstanceId,
    threadId: id(8),
  };
  const context: RequestContext = {
    requestId: id(9),
    sessionId: id(10),
    actor: { type: 'user', id: binding.personId },
    organizationId: binding.organizationId,
    workspaceId: null,
    memberships: [],
    authenticatedAt: '2026-11-24T00:00:00Z',
  };
  const route = { provider: 'configured-provider', model: 'configured-model' };
  const call: ModelCallBinding = {
    context,
    vm: binding,
    execution: { runId: id(11), executionId: id(12) },
    employeeInstanceId: endpoint.employeeInstanceId,
    employeeRelease: 'sealed-employee-release',
    allriceThreadRef: selection.threadId,
    native: {
      instanceId: 'managed-native-web',
      profile: 'sealed-profile',
      sessionId: 'child',
      rootSessionId: 'root',
      parentSessionId: 'root',
      callId: 'issued-native-call',
    },
    executionGeneration: '4.0',
    gatewayRelease: 'sealed-gateway-release',
    ...route,
  };
  const pin = {
    identity: {
      ...selection,
      personId: binding.personId,
      organizationId: binding.organizationId,
      employeeRevision: endpoint.employeeRevision,
      employeeVersionId: endpoint.employeeVersionId,
    },
    rootNativeSessionId: call.native.rootSessionId,
    rootOriginDigest: 'root-origin',
    rootBindingRef: id(13),
    vmId: binding.vmId,
  };
  const revoked = new AbortController(),
    lifetime = new AbortController();
  const published = {
    receipt: { binding, rosterDigest: 'sealed-roster', endpoints: [endpoint] },
    endpoint,
    bindingRef: id(14),
    revoked: revoked.signal,
    owner: { controlReady: () => true },
  };
  const catalog = vi.fn(() => published);
  const assertCall = vi.fn<ModelGatewayAuthority['assertCall']>();
  assertCall.mockResolvedValue(undefined);
  db.pin.mockResolvedValue(pin);
  db.session.mockResolvedValue(undefined);
  const owner = createProductionEgressAuthority({
    startup: { catalog },
    modelAuthority: { assertCall },
    modelRoute: route,
    lifetime: lifetime.signal,
  });
  return {
    owner,
    binding,
    call,
    pin,
    selection,
    published,
    catalog,
    assertCall,
    revoked,
    lifetime,
  };
}

function issued(f: ReturnType<typeof fixture>) {
  const call = structuredClone(f.call),
    active = signal();
  f.owner.bindModelCall(call, active);
  return {
    call,
    active,
    allow: () =>
      f.owner.authority.allow(call.context, f.binding, 'model', active),
  };
}

it('requires the one managed request context and signal for the configured model service', async () => {
  const f = fixture();
  const { call, active, allow } = issued(f);
  const { authority } = f.owner;
  await expect(authority.context(f.binding, active)).rejects.toMatchObject({
    code: 'DENIED',
  });
  await expect(
    authority.allow(structuredClone(call.context), f.binding, 'model', active),
  ).rejects.toMatchObject({ code: 'DENIED' });
  await expect(
    authority.allow(call.context, f.binding, 'model', signal()),
  ).rejects.toMatchObject({ code: 'DENIED' });
  await expect(
    authority.allow(call.context, f.binding, 'packages.npm.read', active),
  ).rejects.toMatchObject({ code: 'DENIED' });
  expect(db.pin).not.toHaveBeenCalled();
  await allow();
  expect(db.pin).toHaveBeenCalledExactlyOnceWith(call.context, f.selection);
  expect(f.assertCall).toHaveBeenCalledExactlyOnceWith(
    call,
    expect.any(AbortSignal),
  );
  expect(f.assertCall.mock.calls[0]?.[0]).toBe(call);
  expect(db.session).toHaveBeenCalledExactlyOnceWith(
    call.context,
    f.selection.workspaceId,
  );
  expect(Object.isFrozen(call.context.actor)).toBe(true);
  expect(Object.isFrozen(call.vm)).toBe(true);
  expect(Object.isFrozen(call.execution)).toBe(true);
  expect(Object.isFrozen(call.native)).toBe(true);
  await expect(allow()).rejects.toMatchObject({ code: 'DENIED' });
  expect(() => f.owner.bindModelCall(call, active)).toThrowError(EgressError);
  expect(db.pin).toHaveBeenCalledTimes(1);
});

it.each<Partial<PersonVmBinding>>([
  { vmId: id(20) },
  { personId: id(20) },
  { organizationId: id(20) },
  { instanceId: id(20) },
  { leaseEpoch: 2 },
])(
  'rejects a substituted VM binding %o before current owner reads',
  async (changed) => {
    const f = fixture(),
      { call, active } = issued(f);
    await expect(
      f.owner.authority.allow(
        call.context,
        { ...f.binding, ...changed },
        'model',
        active,
      ),
    ).rejects.toMatchObject({ code: 'STALE_BINDING' });
    expect(f.catalog).not.toHaveBeenCalled();
  },
);

it('rejects changed person, organization, generation and route at registration', () => {
  const f = fixture();
  const { call } = f;
  for (const wrong of [
    {
      ...call,
      context: {
        ...call.context,
        actor: { type: 'user' as const, id: id(20) },
      },
    },
    { ...call, context: { ...call.context, organizationId: id(20) } },
    { ...call, executionGeneration: '3.x' },
    { ...call, provider: 'different-provider' },
    { ...call, model: 'different-model' },
  ])
    expect(() => f.owner.bindModelCall(wrong, signal())).toThrowError(
      EgressError,
    );
  expect(db.pin).not.toHaveBeenCalled();
});

it('rejects the wrong workspace, root, VM or current employee configuration', async () => {
  const f = fixture();
  const context = { ...f.call.context, workspaceId: id(20) },
    active = signal();
  f.owner.bindModelCall({ ...f.call, context }, active);
  await expect(
    f.owner.authority.allow(context, f.binding, 'model', active),
  ).rejects.toMatchObject({ code: 'DENIED' });
  expect(db.pin).not.toHaveBeenCalled();
  for (const wrong of [
    { ...f.pin, vmId: id(20) },
    { ...f.pin, rootNativeSessionId: 'other-root' },
    { ...f.pin, identity: { ...f.pin.identity, employeeRevision: 3 } },
    { ...f.pin, identity: { ...f.pin.identity, employeeVersionId: id(20) } },
  ]) {
    db.pin.mockResolvedValueOnce(wrong);
    await expect(issued(f).allow()).rejects.toMatchObject({ code: 'DENIED' });
  }
  expect(f.assertCall).not.toHaveBeenCalled();
});

it('rejects previous login, released call or same-epoch profile owner after current authority changes', async () => {
  const f = fixture();
  db.pin.mockRejectedValueOnce(
    new Database.DataAccessError('authorization_denied'),
  );
  await expect(issued(f).allow()).rejects.toMatchObject({ code: 'DENIED' });
  expect(f.assertCall).not.toHaveBeenCalled();

  f.assertCall.mockRejectedValueOnce(new ModelGatewayError('BINDING_INVALID'));
  await expect(issued(f).allow()).rejects.toMatchObject({ code: 'DENIED' });
  expect(db.session).not.toHaveBeenCalled();

  f.assertCall.mockImplementationOnce(async () => {
    db.session.mockRejectedValueOnce(
      new Database.IdentityError('authorization_denied'),
    );
  });
  await expect(issued(f).allow()).rejects.toMatchObject({ code: 'DENIED' });

  f.catalog
    .mockReturnValueOnce(f.published)
    .mockReturnValueOnce({ ...f.published, bindingRef: id(20) });
  await expect(issued(f).allow()).rejects.toMatchObject({
    code: 'STALE_BINDING',
  });
});

it.each(['revoked', 'lifetime'] as const)(
  'joins the pending owner read and rejects its late result on %s',
  async (source) => {
    const f = fixture();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    db.pin.mockImplementationOnce(async () => {
      enter();
      await released;
      return f.pin;
    });
    const work = issued(f).allow();
    let settled = false;
    void work.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const reason = Error('fixture cancellation');
    try {
      await entered;
      f[source].abort(reason);
      await Promise.resolve();
      expect(settled).toBe(false);
    } finally {
      release();
    }
    await expect(work).rejects.toBe(reason);
    expect(f.assertCall).not.toHaveBeenCalled();
  },
);

it('dispatches through real HTTP only with a managed call, and holds unowned read routes closed', async () => {
  const f = fixture();
  const admission = admissionFixture(),
    admit = vi.spyOn(admission, 'admit');
  const upstream = vi.fn(async () => {
    throw Error('unexpected fixture upstream');
  });
  let access!: GuestEgressAccess;
  let managedCall: ModelCallBinding | undefined;
  const gateway = createEgressGateway({
    authority: f.owner.authority,
    vm: { assertAdmissionBinding: async () => {} },
    admission,
    transport: { read: upstream },
    revokeModel: async () => {},
    policy: {
      routes: [
        {
          id: 'packages.npm.read',
          path: '/read',
          origins: ['https://example.test'],
          target: () => new URL('https://example.test/read'),
          maxResponseBytes: 128,
          timeoutMs: 1000,
          validate() {},
        },
      ],
    },
    provisioner: {
      endpoint: async () => ({
        host: '127.0.0.1',
        port: 0,
        guestOrigin: 'http://127.0.0.1:0',
      }),
      install: async (_binding, _mount, value) => {
        access = value;
      },
      remove: async () => {},
    },
    services: [
      {
        id: 'model',
        path: '/v1/stream',
        method: 'POST',
        admissionOwner: 'service',
        async resolve(_request, _binding, serviceSignal) {
          if (!managedCall) throw new EgressError('DENIED');
          const call = structuredClone(managedCall);
          managedCall = undefined;
          f.owner.bindModelCall(call, serviceSignal);
          return {
            context: call.context,
            async dispatch(response, active) {
              active.throwIfAborted();
              response.writeHead(200).end('dispatched');
            },
          };
        },
      },
    ],
  });
  const receipt = await gateway.prepare(
    f.binding,
    { mount: '/synthetic', gatewayPorts: [] },
    signal(),
  );
  try {
    const headers = {
      authorization: `Bearer ${access.capability}`,
      'x-allrice-organization-id': f.binding.organizationId,
    };
    const post = () =>
      fetch(access.origin + '/v1/stream', { method: 'POST', headers });
    const unowned = await post();
    expect(unowned.status).toBe(403);
    await expect(unowned.json()).resolves.toEqual({ code: 'DENIED' });
    const read = await fetch(access.origin + '/read', { headers });
    expect(read.status).toBe(403);
    await expect(read.json()).resolves.toEqual({ code: 'DENIED' });
    expect(f.catalog).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();

    managedCall = f.call;
    const approved = await post();
    expect(approved.status).toBe(200);
    await expect(approved.text()).resolves.toBe('dispatched');
  } finally {
    await gateway.revoke(receipt, 'stop', signal());
  }
});

it('uses the original web search context once for the same VM epoch and gateway signal', async () => {
  const { owner, call } = fixture();
  const context = structuredClone(call.context);
  const active = signal();
  const verify = vi.fn(async () => {});
  owner.bindWebSearch(context, call.vm, active, verify);
  await expect(
    owner.authority.allow(
      context,
      { ...call.vm, leaseEpoch: call.vm.leaseEpoch + 1 },
      'web-search',
      active,
    ),
  ).rejects.toMatchObject({ code: 'DENIED' });
  expect(verify).not.toHaveBeenCalled();
  owner.bindWebSearch(context, call.vm, active, verify);
  await expect(
    owner.authority.allow(context, call.vm, 'web-search', signal()),
  ).rejects.toMatchObject({ code: 'DENIED' });
  expect(verify).not.toHaveBeenCalled();
  owner.bindWebSearch(context, call.vm, active, verify);
  await owner.authority.allow(context, call.vm, 'web-search', active);
  expect(verify).toHaveBeenCalledExactlyOnceWith(active);
  await expect(
    owner.authority.allow(context, call.vm, 'web-search', active),
  ).rejects.toMatchObject({ code: 'DENIED' });
});
