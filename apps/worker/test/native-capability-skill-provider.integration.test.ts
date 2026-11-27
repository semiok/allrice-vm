import { createHash, randomUUID } from 'node:crypto';
import {
  PersonalSkillConfirmResponseSchema,
  PersonalSkillRemoveResponseSchema,
  type PersonalSkillDefinition,
  type RequestContext,
} from '@allrice/contracts';
import {
  createBuiltinSkillSourcesPort,
  createPostgresPersonalSkillPackageSource,
  requireEmployeePanelsAccess,
  runtimePolicyDigest,
} from '@allrice/database';
import { createFileArchive } from '@allrice/file-archives';
import { Context } from '@deepseek-ai/cordis';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type * as DatabaseClient from '../../../packages/database/src/core/client.ts';
import {
  createRuntimeFixtureDatabase,
  runtimeFixtureStorage,
} from '../../../packages/database/src/runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from '../../../packages/database/src/employee-administration.fixture.ts';
import {
  authenticateSession,
  createSession,
} from '../../../packages/database/src/identity.ts';
import {
  createChatSession,
  getEmployeeWorkspace,
} from '../../../packages/database/src/workspace/service.ts';
import { createEmployeeInstance } from '../../../packages/database/src/employees/employee-instances.ts';
import {
  registerNativeCapabilitySkillProvider,
  type NativeCapabilitySkillConfiguration,
} from '../src/native-capability-skill-provider.js';

const client: {
  db?: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>['db'];
  context?: RequestContext;
} = vi.hoisted(() => ({}));
vi.mock('../../../packages/database/src/core/client.ts', async (original) => ({
  ...(await original<typeof DatabaseClient>()),
  getDatabase: () => {
    if (!client.db) throw Error('isolated native Skill database required');
    return client.db;
  },
}));
vi.mock('../../web/lib/storage/runtime', () => ({
  getStorageAdapter: () => {
    if (!client.db) throw Error('isolated native Skill database required');
    return runtimeFixtureStorage(client.db);
  },
}));
vi.mock('../../web/lib/identity/session', () => ({
  getRequestContext: async () => client.context ?? null,
}));
const hash = (text: string) =>
  'sha256:' + createHash('sha256').update(text).digest('hex');
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'real PG sources and real DSH registry; no production Guest configuration is mounted',
  () => {
    let f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    let host: Awaited<ReturnType<typeof setup>>;
    const contexts: Context[] = [];
    async function setup() {
      const publication = await createEmployeeAdministrationFixture(f.db);
      // Existing synthetic publication fixture; no provider/model/VM invocation.
      await publication.preview();
      expect((await publication.publish()).valid).toBe(true);
      const context = (await authenticateSession(
        (await createSession(publication.ownerId)).token,
        {
          organizationId: publication.organizationId,
          workspaceId: publication.workspaceId,
        },
      ))!;
      const assignment = (
        await getEmployeeWorkspace(context, publication.workspaceId)
      ).employees.find(
        (item) => item.employeeKey === publication.definition.key,
      )!;
      const instance = await createEmployeeInstance(context, {
        workspaceId: publication.workspaceId,
        assignmentId: assignment.id,
        requestId: randomUUID(),
        profile: { name: 'Native Skill fixture' },
      });
      return {
        context,
        scope: {
          workspaceId: publication.workspaceId,
          instanceId: instance.id,
        },
        requireCurrent: vi.fn(async (signal: AbortSignal) =>
          signal.throwIfAborted(),
        ),
      };
    }
    beforeAll(async () => {
      f = await createRuntimeFixtureDatabase({ ownSchemaOnly: true });
      client.db = f.db;
      host = await setup();
    }, 120000);
    beforeEach(async () => {
      host.requireCurrent
        .mockReset()
        .mockImplementation(async (signal) => signal.throwIfAborted());
      await f.db`update allrice_personal_skill_bindings set enabled=false,epoch=epoch+1
      where organization_id=${host.context.organizationId} and owner_id=${host.context.actor.id}`;
    });
    afterEach(async () => {
      client.context = undefined;
      for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
    });
    afterAll(async () => {
      try {
        if (f)
          expect(await f.close()).toMatchObject({
            databaseClosed: true,
            adminClosed: true,
            schemaRemoved: true,
            storageRemoved: true,
          });
      } finally {
        client.db = undefined;
      }
    });
    async function install() {
      const installationId = randomUUID(),
        versionId = randomUUID();
      const definition: PersonalSkillDefinition = {
        name: 'weekly-' + installationId,
        description: 'Use my installed weekly Skill.',
        content: '# 周报\n精确保留本人正文。\n',
        checksum: hash('# 周报\n精确保留本人正文。\n'),
        invocation: { modelInvocable: true, userInvocable: false },
        whenToUse: 'When summarizing a week.',
        metadata: { displayName: '周报' },
      };
      const source = {
        kind: 'attachment',
        objectId: randomUUID(),
        fileName: 'SKILL.md',
        originalChecksum: definition.checksum,
        byteLength: Buffer.byteLength(definition.content),
      };
      await f.db.begin(async (tx) => {
        await tx`insert into allrice_personal_skill_installations(id,organization_id,owner_id,name,state,current_version_id)
        values(${installationId},${host.context.organizationId},${host.context.actor.id},${definition.name},'installed',${versionId})`;
        await tx`insert into allrice_personal_skill_versions(id,organization_id,owner_id,installation_id,version,source,original_text,definition,definition_checksum)
        values(${versionId},${host.context.organizationId},${host.context.actor.id},${installationId},1,${tx.json(source)},${definition.content},${tx.json(definition)},${runtimePolicyDigest(definition)})`;
        await tx`insert into allrice_personal_skill_bindings(organization_id,workspace_id,owner_id,instance_id,installation_id,enabled)
        values(${host.context.organizationId},${host.scope.workspaceId},${host.context.actor.id},${host.scope.instanceId},${installationId},true)`;
      });
      return { installationId, versionId, definition, source };
    }
    async function mount() {
      const ctx = new Context();
      contexts.push(ctx);
      await ctx.plugin(SkillRegistry);
      const builtin = createBuiltinSkillSourcesPort();
      const catalog = await builtin.listSources(new AbortController().signal);
      const web = catalog.sources.find((item) => item.name === 'web-research')!;
      let configuration: NativeCapabilitySkillConfiguration = {
        builtinSkills: [web.selector],
        personalSkills: true,
      };
      const personal = createPostgresPersonalSkillPackageSource(f.db, host);
      const readConfiguration = vi.fn(async (signal: AbortSignal) => {
        signal.throwIfAborted();
        return configuration;
      });
      let mounted!: ReturnType<typeof registerNativeCapabilitySkillProvider>;
      await ctx.inject(['skills'], (target) => {
        mounted = registerNativeCapabilitySkillProvider(target, {
          builtin,
          personal,
          requireCurrent: host.requireCurrent,
          readConfiguration,
        });
      });
      return {
        ctx,
        mounted,
        personal,
        web,
        builtin,
        readConfiguration,
        configure(value: NativeCapabilitySkillConfiguration) {
          configuration = value;
        },
      };
    }

    it('loads the published browser package in DSH and refuses its exact pin after an employee disable', async () => {
      const abort = new AbortController();
      const { context } = host;
      const selection = {
        workspaceId: host.scope.workspaceId,
        employeeInstanceId: host.scope.instanceId,
      };
      const thread = await createChatSession(context, selection, {
        executionGeneration: '4.0',
      });
      const target = { ...selection, threadId: thread.id };
      const policy = {
        revision: randomUUID(),
        defaultGeneration: '3.x',
        selections: [
          {
            organizationId: context.organizationId,
            personId: context.actor.id,
          },
        ],
      };
      await f.db`insert into allrice_settings(scope_type,key,value)
        values ('system','d_entry_rollout_policy',${f.db.json(policy)})
        on conflict(scope_type,scope_id,key) do update set value=excluded.value`;
      host.requireCurrent.mockImplementation(async (signal) => {
        signal.throwIfAborted();
        await requireEmployeePanelsAccess(context, target);
        signal.throwIfAborted();
      });
      // Load the Web entrypoints at runtime, like the browser Skill DB suite.
      // The Web package typechecks its relative imports with Bundler resolution.
      const previewPath = '../../web/lib/skills/personal-skill-preview.ts';
      const routes =
        '../../web/app/api/v1/d-entry/panels/[panelEmployeeInstanceId]/skills';
      const { previewPersonalSkillSource } = await import(previewPath);
      const { POST } = await import(routes + '/confirm/route.ts');
      const { DELETE } = await import(routes + '/[installationId]/route.ts');
      const name = 'r3-weekly-summary';
      const content = 'Keep the source report scoped to this employee.';
      const originalText = [
        '---',
        'name: ' + name,
        'description: Prepare a weekly summary.',
        '---',
        content,
        '',
      ].join('\n');
      const archive = await createFileArchive([
        { path: 'SKILL.md', bytes: Buffer.from(originalText) },
      ]);
      const preview = await previewPersonalSkillSource(
        context,
        selection.employeeInstanceId,
        {
          workspaceId: selection.workspaceId,
          target: { operation: 'install' },
          source: { kind: 'zip', fileName: 'weekly.zip' },
        },
        archive,
        abort.signal,
      );
      const owned = await mount();
      expect(await owned.ctx.skills.get(name)).toBeUndefined();
      client.context = context;
      const routeBase = 'https://allrice.test';
      const params = { panelEmployeeInstanceId: selection.employeeInstanceId };
      const query = new URLSearchParams({
        workspaceId: target.workspaceId,
        threadId: target.threadId,
      });
      const request = (path: string, method: string, body: object) =>
        new Request(
          `${routeBase}/api/v1/d-entry/panels/${params.panelEmployeeInstanceId}/skills${path}?${query}`,
          {
            method,
            headers: {
              origin: routeBase,
              'content-type': 'application/json',
              'x-allrice-expected-viewer-id': context.actor.id,
            },
            body: JSON.stringify(body),
            signal: abort.signal,
          },
        );
      const applied = await POST(
        request('/confirm', 'POST', {
          workspaceId: target.workspaceId,
          requestId: randomUUID(),
          previewId: preview.previewId,
          digest: preview.digest,
        }),
        { params: Promise.resolve(params) },
      );
      const appliedBody: unknown = await applied.json();
      expect(applied.status, JSON.stringify(appliedBody)).toBe(200);
      const publication = PersonalSkillConfirmResponseSchema.parse(appliedBody);
      // This is the public rc.2 receiver exercised distinct from any live VM
      // notification route. The test explicitly delivers both invalidations.
      owned.mounted.invalidate();
      expect(
        (await owned.ctx.skills.list()).map((skill) => skill.name),
      ).toContain(name);
      expect(await owned.ctx.skills.get(name)).toMatchObject({
        name,
        content: expect.stringContaining(content),
      });
      const [pin] = await owned.personal.listPackagePins(abort.signal);
      expect(pin).toMatchObject({
        installationId: publication.skill.id,
        versionId: publication.skill.versionId,
      });
      const revoked = await DELETE(
        request('/' + publication.skill.id, 'DELETE', {
          workspaceId: target.workspaceId,
          expectedRevision: publication.skill.revision,
          requestId: randomUUID(),
        }),
        {
          params: Promise.resolve({
            ...params,
            installationId: publication.skill.id,
          }),
        },
      );
      const revokedBody: unknown = await revoked.json();
      expect(revoked.status, JSON.stringify(revokedBody)).toBe(200);
      expect(
        PersonalSkillRemoveResponseSchema.parse(revokedBody).receipt.binding,
      ).toMatchObject({
        enabled: false,
        epoch: pin!.bindingEpoch + 1,
      });
      // Even if a previous catalog is cached, the exact body source denies.
      await expect(owned.ctx.skills.get(name)).rejects.toThrow(
        'personal_skill_unavailable',
      );
      owned.mounted.invalidate();
      expect(
        (await owned.ctx.skills.list()).map((skill) => skill.name),
      ).not.toContain(name);
      expect(await owned.ctx.skills.get(name)).toBeUndefined();
    }, 20000);

    it('用户要用本人安装的周报Skill：actual list→exact body, update pin, epoch revocation', async () => {
      const installed = await install();
      const m = await mount();
      expect(
        (await m.ctx.skills.list()).map((item) => item.name).sort(),
      ).toEqual(['web-research', installed.definition.name].sort());
      expect(await m.ctx.skills.get(installed.definition.name)).toMatchObject({
        name: installed.definition.name,
        content: installed.definition.content,
        invocation: installed.definition.invocation,
        metadata: installed.definition.metadata,
        resourceBase: { kind: 'opaque' },
      });
      expect((await m.ctx.skills.get(m.web.name))?.content).toBe(
        (
          await m.builtin.readPackage(
            m.web.selector,
            new AbortController().signal,
          )
        ).content,
      );
      const [originalPin] = await m.personal.listPackagePins(
        new AbortController().signal,
      );
      const nextId = randomUUID();
      const next = {
        ...installed.definition,
        content: '# 周报第二版\n',
        checksum: hash('# 周报第二版\n'),
      };
      await f.db.begin(async (tx) => {
        await tx`insert into allrice_personal_skill_versions(id,organization_id,owner_id,installation_id,version,source,original_text,definition,definition_checksum)
        values(${nextId},${host.context.organizationId},${host.context.actor.id},${installed.installationId},2,${tx.json(installed.source)},${next.content},${tx.json(next)},${runtimePolicyDigest(next)})`;
        await tx`update allrice_personal_skill_installations set current_version_id=${nextId} where id=${installed.installationId}`;
      });
      // An ordinary pointer update does not revoke the exact cached candidate.
      expect((await m.ctx.skills.get(next.name))?.content).toBe(
        installed.definition.content,
      );
      m.mounted.invalidate();
      expect((await m.ctx.skills.get(next.name))?.content).toBe(next.content);
      expect(
        (
          await m.personal.readPackage(
            originalPin,
            new AbortController().signal,
          )
        ).definition.content,
      ).toBe(installed.definition.content);
      await f.db`update allrice_personal_skill_bindings set enabled=false,epoch=epoch+1
      where instance_id=${host.scope.instanceId} and installation_id=${installed.installationId}`;
      await expect(m.ctx.skills.get(next.name)).rejects.toThrow(
        'personal_skill_unavailable',
      );
      m.mounted.invalidate();
      expect((await m.ctx.skills.list()).map((item) => item.name)).toEqual([
        m.web.name,
      ]);
      await m.mounted.dispose();
      expect(await m.ctx.skills.list()).toEqual([]);
    });

    it('does not disclose an in-flight body after its PG binding is revoked and the host invalidates', async () => {
      const selected = await install(),
        unaffected = await install();
      const m = await mount();
      expect((await m.ctx.skills.list()).map((skill) => skill.name)).toContain(
        selected.definition.name,
      );
      let entered!: () => void, release!: () => void;
      const checking = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const configuration = m.readConfiguration.getMockImplementation()!;
      m.readConfiguration
        .mockImplementationOnce(configuration)
        .mockImplementationOnce(async (signal) => {
          // The source already finished both body and binding/epoch reads.
          entered();
          await gate;
          return configuration(signal);
        });
      const pending = m.ctx.skills.get(selected.definition.name);
      const settled = pending.catch((error: unknown) => error);
      try {
        await checking;
        await f.db`update allrice_personal_skill_bindings set enabled=false,epoch=epoch+1
          where instance_id=${host.scope.instanceId} and installation_id=${selected.installationId}`;
        m.mounted.invalidate();
        release();
        await expect(pending).rejects.toThrow(
          'native_capability_skill_unavailable',
        );
        expect(
          (await m.ctx.skills.get(unaffected.definition.name))?.content,
        ).toBe(unaffected.definition.content);
        expect(
          await m.ctx.skills.get(selected.definition.name),
        ).toBeUndefined();
      } finally {
        release();
        await settled;
      }
    });

    it('rechecks actual PG body current/config and keeps an unavailable producer fail closed', async () => {
      const installed = await install();
      const m = await mount();
      await m.ctx.skills.list();
      const denied = Error('current contract substitute revoked');
      host.requireCurrent.mockRejectedValue(denied);
      await expect(m.ctx.skills.get(installed.definition.name)).rejects.toBe(
        denied,
      );
      m.mounted.invalidate();
      expect(await m.ctx.skills.snapshot()).toEqual({
        skills: [],
        complete: false,
      });
      host.requireCurrent.mockImplementation(async (signal) =>
        signal.throwIfAborted(),
      );
      m.configure({ builtinSkills: [], personalSkills: false });
      m.mounted.invalidate();
      expect(await m.ctx.skills.list()).toEqual([]);
      expect(await m.ctx.skills.get(installed.definition.name)).toBeUndefined();
    });
  },
);
