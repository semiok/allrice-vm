import { sameDEntryIdentity, type RequestContext } from '@allrice/contracts';
import {
  createPostgresPersonalSkillPackageSource,
  getDatabase,
  requireCurrentWorkspaceWriteAuthority,
  requireDEntryNativeIdentity,
  skillBytesChecksum,
  subscribeDEntrySkillChanges,
} from '@allrice/database';
import type {
  DEntryScopeIssue,
  PrincipalSkillRead,
  PrincipalSkillResult,
  PrincipalSkillSummary,
} from '@allrice/d-entry-principal/types';
import {
  PersonVmError,
  type PersonVmBinding,
  type PersonVmPort,
} from '@allrice/person-vm';

const unavailable = { kind: 'unavailable' } as const;
type Skill = PrincipalSkillSummary & { content: string };

export function nativeWebSkillSource(
  original: RequestContext,
  issue: DEntryScopeIssue,
  binding: PersonVmBinding,
  vm: Pick<PersonVmPort, 'assertCurrentBinding'>,
) {
  const { identity } = issue;
  const context = { ...original, workspaceId: identity.workspaceId };
  const denied = () => new PersonVmError('AUTHORIZATION_DENIED');
  if (
    issue.access === 'history' ||
    !context.sessionId ||
    context.actor.type !== 'user' ||
    context.actor.id !== identity.personId ||
    context.organizationId !== identity.organizationId ||
    binding.organizationId !== identity.organizationId ||
    binding.personId !== identity.personId ||
    (original.workspaceId !== null &&
      original.workspaceId !== identity.workspaceId)
  )
    return;

  const selection = {
    workspaceId: identity.workspaceId,
    employeeInstanceId: identity.employeeInstanceId,
    ...(identity.threadId && { threadId: identity.threadId }),
  };
  const requireCurrent = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    await requireCurrentWorkspaceWriteAuthority(original, identity.workspaceId);
    if (
      !sameDEntryIdentity(
        await requireDEntryNativeIdentity(context, selection),
        identity,
      )
    )
      throw denied();
    await vm.assertCurrentBinding(context, binding, signal);
    signal.throwIfAborted();
  };
  async function platform(signal: AbortSignal, name?: string) {
    const read = getDatabase()<
      {
        binding_id: string;
        platform_id: string;
        source_version: string;
        updated_at: string;
        name: string;
        description: string;
        content: string;
        checksum: string;
        user_invocable: boolean;
        model_invocable: boolean;
      }[]
    >`
      select b.id binding_id,p.id platform_id,p.version source_version,
             s.updated_at::text updated_at,s.name,s.description,
             s.content,s.checksum,s.user_invocable,s.model_invocable
      from allrice_employee_instances i
      join allrice_employee_assignments a on a.id=i.assignment_id
         and a.organization_id=i.organization_id and a.workspace_id=i.workspace_id
      join allrice_employee_dsh_skill_bindings b on b.employee_id=a.employee_id
         and b.organization_id=i.organization_id and b.workspace_id=i.workspace_id
      join allrice_dsh_skills s on s.id=b.skill_id
         and s.organization_id=b.organization_id and s.workspace_id=b.workspace_id
      join allrice_employee_versions v on v.id=a.employee_version_id
         and v.organization_id=i.organization_id and v.workspace_id=i.workspace_id
      join allrice_platform_dsh_skills p on p.name=s.name and p.checksum=s.checksum
      where i.id=${identity.employeeInstanceId} and i.revision=${identity.employeeRevision}
        and i.organization_id=${identity.organizationId} and i.workspace_id=${identity.workspaceId}
        and i.owner_id=${identity.personId} and i.archived_at is null
        and a.employee_version_id=${identity.employeeVersionId} and a.active
        and b.enabled and s.enabled and p.enabled and p.review_status='reviewed'
        and s.required_tool_refs='[]'::jsonb and p.required_tool_refs='[]'::jsonb
        and coalesce(jsonb_array_length(s.bundle->'resources'), 0)=0
        and coalesce(jsonb_array_length(p.bundle->'resources'), 0)=0
        and p.model_invocable=s.model_invocable and p.user_invocable=s.user_invocable
        and exists (select 1 from jsonb_array_elements(nullif(v.manifest #> '{runtimePackage,runtimeManifest,skillGovernance}', 'null'::jsonb)) grant_row
          where grant_row->>'id'=p.id::text and grant_row->>'name'=s.name
            and grant_row->>'checksum'=p.checksum and grant_row->>'version'=p.version
            and grant_row->>'sourceRef'=p.source_ref)
        and exists (select 1 from jsonb_array_elements(nullif(v.manifest #> '{runtimePackage,skills}', 'null'::jsonb)) published
          where published->>'id'=p.id::text and published->>'checksum'=p.checksum
            and (published #>> '{invocation,userInvocable}')::boolean=s.user_invocable
            and (published #>> '{invocation,modelInvocable}')::boolean=s.model_invocable
            and published->'requiredToolRefs'='[]'::jsonb
            and coalesce(jsonb_array_length(published #> '{bundle,resources}'),0)=0)
        and (${name ?? null}::text is null or s.name=${name ?? null})
      order by s.name,s.id limit 65`;
    const cancel = () => read.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (signal.aborted) cancel();
      const rows = await read;
      signal.throwIfAborted();
      if (rows.length > 64) throw denied();
      return rows.flatMap((row): Skill[] =>
        row.checksum === skillBytesChecksum(row.content)
          ? [
              {
                name: row.name,
                description: row.description,
                revision: skillBytesChecksum(JSON.stringify(row)),
                userInvocable: row.user_invocable,
                modelInvocable: row.model_invocable,
                content: row.content,
              },
            ]
          : [],
      );
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }
  async function readAll(signal: AbortSignal, name?: string) {
    const found = await platform(signal, name);
    const personal = createPostgresPersonalSkillPackageSource(getDatabase(), {
      context,
      scope: {
        workspaceId: identity.workspaceId,
        instanceId: identity.employeeInstanceId,
      },
      requireCurrent,
    });
    for (const pin of await personal.listPackagePins(signal)) {
      const { definition, manifest } = await personal.readPackage(pin, signal);
      if (manifest?.resources.length || (name && name !== definition.name))
        continue;
      found.push({
        name: definition.name,
        description: definition.description,
        revision: skillBytesChecksum(JSON.stringify(pin)),
        ...definition.invocation,
        content: definition.content,
      });
    }
    const counts = new Map<string, number>();
    for (const entry of found)
      counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
    return found.filter(({ name }) => counts.get(name) === 1);
  }
  const read = async (
    read: PrincipalSkillRead,
    signal: AbortSignal,
  ): Promise<PrincipalSkillResult> => {
    await requireCurrent(signal);
    const name = read.kind === 'body' ? read.name : undefined;
    const first = await readAll(signal, name);
    await requireCurrent(signal);
    // Every read uses current rows again after the last asynchronous authority
    // verification, including policy, enabled state, and exact package pin.
    const current = await readAll(signal, name);
    signal.throwIfAborted();
    const stable = first.filter((entry) =>
      current.some((next) => next.revision === entry.revision),
    );
    if (read.kind === 'list')
      return {
        kind: 'catalog',
        entries: stable.map(
          ({ name, description, revision, userInvocable, modelInvocable }) => ({
            name,
            description,
            revision,
            userInvocable,
            modelInvocable,
          }),
        ),
      };
    const exact = stable.find((entry) => entry.revision === read.revision);
    return exact ? { kind: 'body', content: exact.content } : unavailable;
  };

  return {
    read,
    async watch(
      signal: AbortSignal,
      changed: () => void,
      lost: (error: unknown) => void,
    ) {
      await requireCurrent(signal);
      return subscribeDEntrySkillChanges(
        identity,
        context.sessionId!,
        signal,
        changed,
        lost,
      );
    },
  };
}
