import type { PersonVmBootstrapScope } from './guest-bootstrap.ts';
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  open,
  type FileHandle,
  writeFile,
  symlink,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import { once } from 'node:events';
import type * as Os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DSH_SANDBOX_ROOT,
  launchDshSandbox,
  prepareDshSandbox,
  verifyDshRuntimeDisk,
} from './dsh-sandbox-bootstrap.ts';
import { MicrosandboxPersonVm } from './microsandbox.ts';
import { PersonVmError, PERSON_VM_MEMORY_MIB } from './contract.ts';
import { runCommand } from './process.ts';
import { context, currentReceipt, harness, signal } from './test-support.ts';
import { PersonVmService } from './person-vm.ts';
import {
  COMMAND_MEMORY_CONTROL_FILES,
  hashCommandMemoryControlFiles,
  type ReadonlyDshDirectory,
  type ReadonlyDshRuntimeDisk,
} from './readonly-artifact.ts';
import type { PersonVmMemoryGuestPlan } from './guest-bootstrap.ts';
import type { PersonVmWebRoster, PersonVmWebStartup } from './web-endpoints.ts';
import { PERSON_VM_GUEST_CONTROL_READER } from './native-resource.ts';
import { PERSON_VM_COMMAND_MEMORY_PROGRAM } from './native-command-observer.ts';

vi.mock('node:os', async (source) => ({
  ...(await source<typeof Os>()),
  networkInterfaces: () => ({
    lo: [{ address: '127.0.0.1' }, { address: '::1' }],
    en0: [{ address: '192.168.0.10' }, { address: 'fe80::8%en0' }],
  }),
}));

const outboundRules = [
  'deny:egress@127.0.0.1',
  'deny:egress@[::1]',
  'deny:egress@192.168.0.10',
  'deny:egress@[fe80::8]',
  'allow:egress@dns',
  'allow:egress@public',
  'allow:egress@host:tcp:38990',
];

const temporary: string[] = [];
const readonlyRoots: string[] = [];
async function unsealFixture(path: string) {
  const s = await lstat(path);
  if (!s.isDirectory()) return;
  await chmod(path, 0o700);
  for (const name of await readdir(path)) await unsealFixture(join(path, name));
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const path of readonlyRoots.splice(0)) await unsealFixture(path);
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function directory() {
  const path = await realpath(await mkdtemp('/tmp/ar-vm-'));
  temporary.push(path);
  return path;
}
async function socketDirectory() {
  // Keep the explicit /tmp spelling: realpath's /private prefix is too long
  // for the pinned native control endpoint, even when artifacts live deeper.
  const path = await mkdtemp('/tmp/a-');
  temporary.push(path);
  return path;
}

async function bootstrapFixture(
  mode = 'ok',
  readonlyDshDirectory?: ReadonlyDshDirectory,
  jobCleanupTimeoutMs?: number,
  artifacts?: Pick<
    ConstructorParameters<typeof MicrosandboxPersonVm>[0],
    'readonlyDshRuntimeDisk' | 'readonlyCommandMemoryDirectory'
  >,
) {
  const root = await directory(),
    mount = join(root, 'mount');
  const binary = join(root, 'msb-bootstrap-fixture');
  await writeFile(
    binary,
    `#!${process.execPath}
const fs=require('node:fs'),p=require('node:path'),a=process.argv.slice(2),home=process.env.HOME;
const f=p.join(home,'state.json'),v=fs.existsSync(f)?JSON.parse(fs.readFileSync(f)):{};
const mode=${JSON.stringify(mode)};
fs.appendFileSync(p.join(home,'calls.jsonl'),JSON.stringify(a)+'\\n');
function save(){fs.writeFileSync(f,JSON.stringify(v));}
if(a[0]==='--version')console.log('microsandbox 0.7.16');
else if(a[0]==='list')console.log(JSON.stringify(v.name?[{name:v.name,status:v.status}]:[]));
else if(a[0]==='pull'){
 if(mode==='pull-fails-once'&&!v.pullFailed){v.pullFailed=true;save();process.exit(45);}
}
else if(a[0]==='create'){
 v.name=a[a.indexOf('--name')+1];v.status='Running';
 v.mounts=a.flatMap((arg,i)=>arg==='--mount-dir'?[a[i+1].split(':')]:[]).map(([host,guest,ro])=>({type:'Bind',host,guest,options:{readonly:ro==='ro',noexec:false,nosuid:false,nodev:false},stat_virtualization:'strict',host_permissions:'private',follow_root_symlinks:false,quota_mib:null}));
 v.mounts.push(...a.flatMap((arg,i)=>arg==='--mount-disk'?[a[i+1].split(':')]:[]).map(([host,guest,opts])=>({type:'DiskImage',host,guest,format:'Raw',fstype:'ext4',options:{readonly:opts==='format=raw,fstype=ext4,ro',noexec:false,nosuid:false,nodev:false}})));
 v.ports=a.flatMap((arg,i)=>arg==='-p'?[a[i+1].split(':')]:[]).map(([host_bind,h,g])=>({host_bind,host_port:Number(h),guest_port:Number(g),protocol:'tcp'}));
}
else if(a[0]==='inspect'){
 if(a.includes('--job')){
  const id=a[a.indexOf('--job')+1],job=v.jobs[id];
  console.log(JSON.stringify({version:1,id,pid:4242,runtime_boot_id:'fixture-native-boot',state:job.state??'running',exit_code:job.code,timed_out:false}));return;
 }
 const ports=v.ports??[],active=(mode.startsWith('web-inspect')||(v.retained&&mode==='retained-web-drift'))?[]:ports;
 const mounts=v.mounts??[],activeMounts=(mode==='artifact-inspect-drift'||(v.retained&&mode==='retained-mount-drift'))?mounts.map(m=>({...m,options:{...m.options,readonly:false}})):mounts;
 console.log(JSON.stringify({name:v.name,status:v.status,config:{network:{ports},mounts},active_config:{network:{ports:active},mounts:activeMounts},pending_changes:[]}));
}
else if(a[0]==='start'){v.retained=true;v.status='Running';}
else if(a[0]==='stop'){if(!['lost-id-unknown-stop','workdir-lost-id-unknown-stop','auth-unknown-stop','web-inspect-unknown-stop'].includes(mode))v.status='Stopped';}
else if(a[0]==='ping'){if(v.status!=='Running')process.exit(41);}
else if(a[0]==='cp'){
 const meta=fs.statSync(a[1]);(v.copies??=[]).push({target:a[2],mode:meta.mode&511,contents:fs.readFileSync(a[1],'utf8')});
 if(mode==='partial-copy'){save();process.exit(45);}
}
else if(a[0]==='exec'){
 if(!a.includes('--detach')){
  const cmd=a.slice(a.indexOf('--')+1);
  if(cmd.join(' ')==='node -e diagnostic'){
   if(a[a.indexOf('--workdir')+1]!=='/work'||!Object.values(v.jobs??{}).some(j=>j.cmd.join(' ')==='/bin/mkdir -p -- /work'&&j.state==='exited'&&j.code===0))process.exit(47);
   console.log('synthetic-exec-protocol');return;
  }
  // v0.7.16 exec uses parse_duration_secs, not the separate ms parser.
  if(!/^[0-9]+[smh]?$/.test(a[a.indexOf('--timeout')+1]??''))process.exit(44);
  if(mode==='auth-budget'){
   fs.writeFileSync(p.join(home,'auth-reading'),String(process.pid));setInterval(()=>{},1000);return;
  }
  process.exit(require('node:child_process').spawnSync(process.execPath,cmd.slice(1),{stdio:'inherit'}).status??1);
 }
 if(!a.includes('--detach')||!a.includes('--no-stdin')||!a.includes('--no-tty'))process.exit(42);
 const id=require('node:crypto').randomUUID(),cmd=a.slice(a.indexOf('--')+1),init=cmd.includes('/work/memory/init.cjs');
 const workdir=cmd.join(' ')==='/bin/mkdir -p -- /work';
 if(workdir&&(v.status!=='Running'||a[a.indexOf('--workdir')+1]!=='/bin'||a[a.indexOf('--timeout')+1]!=='10s'))process.exit(46);
 const code=workdir&&mode==='workdir-init-error'?47:init&&mode==='init-error'?23:mode==='sandbox-stage-error'&&cmd[2]?.includes('invalid-dsh-sandbox-input')?24:0;
 (v.jobs??={})[id]={cmd,code};save();
 if(workdir&&mode==='workdir-dispatch-failed')process.exit(48);
 if(!(init&&mode.startsWith('lost-id'))&&!(workdir&&mode.startsWith('workdir-lost-id')))console.log(id);
}
else if(a[0]==='kill')v.jobs[a[a.indexOf('--job')+1]].code=137;
else if(a[0]==='logs'){
 const id=a[a.indexOf('--job')+1],cmd=v.jobs[id].cmd;
 if(cmd[1]==='journal-read-fixture'){console.log(JSON.stringify({id,s:'stdout',e:null,d:'{"terminal":true}'}));return;}
 const config=JSON.parse(cmd[3]);
 const childPath=config.commandsGroup+'/command-'+config.pid;
 const output=config.targets?{version:1,scope:'guest-cgroup',groups:config.targets.map(t=>({...t,device:'1',inode:'2',values:['32','64','128']}))}:
 {version:1,childJoined:true,childReleased:true,receipt:{version:1,executionRef:config.executionRef,pid:config.pid,stage:'admitted',child:{path:childPath,device:'1',inode:'2'},beforeMembership:config.dshGroup.slice(config.cgroupRoot.length),admittedMembership:childPath.slice(config.cgroupRoot.length),bootId:'00000000-0000-0000-0000-000000000001',startTicks:'1',baseline:{oom:'0',oomKill:'0'}},after:{oom:'0',oomKill:'0'}};
 console.log(JSON.stringify({id,s:'stdout',e:null,d:JSON.stringify(output)}));
}
else if(a[0]==='wait'){
 const job=v.jobs[a[a.indexOf('--job')+1]];
 const workdir=job.cmd.join(' ')==='/bin/mkdir -p -- /work';
 if((mode==='unknown-wait'&&job.cmd[0]==='/bin/mkdir'&&!workdir)||(mode==='workdir-unknown-wait'&&workdir)){
  console.log('{}');save();process.exit(0);
 }
 if(((mode==='cancel-workdir'&&job.cmd.join(' ')==='/bin/mkdir -p -- /work')||(mode==='cancel-init'&&job.cmd.includes('/work/memory/init.cjs'))||(mode==='cancel-memory-probe'&&job.cmd[1]==='-e')||(mode==='cancel-retained-command'&&job.cmd.includes('native-dsh')))&&job.code===0){
  save();fs.writeFileSync(p.join(home,'waiting'),String(process.pid));setInterval(()=>{},1000);return;
 }
 job.state='exited';
 console.log(JSON.stringify({code:job.code,success:job.code===0,timed_out:false}));save();process.exit(job.code);
} else process.exit(43);
save();
`,
    { mode: 0o700 },
  );
  const nativeOptions = {
    binary,
    libkrunfw: join(root, 'fw'),
    agentd: join(root, 'agentd'),
    image: readonlyDshDirectory
      ? readonlyImage
      : 'registry/node@sha256:' + 'a'.repeat(64),
    readonlyDshDirectory,
    jobCleanupTimeoutMs,
    rootDiskGiB: 20,
    socketRoot: await socketDirectory(),
    ...artifacts,
  };
  const native = new MicrosandboxPersonVm(nativeOptions);
  const h = harness(),
    rc = context(),
    attach = h.disk.attach;
  h.disk.attach = async (...args) => {
    await attach(...args);
    return mount;
  };
  const plan: PersonVmMemoryGuestPlan = {
    files: [
      {
        path: '/work/memory/init.cjs',
        contents: '// synthetic initializer',
        mode: 0o700,
      },
      {
        path: '/work/memory/launcher',
        contents: '#!/bin/sh\nexec "$@"\n',
        mode: 0o700,
      },
      { path: '/work/memory/config.json', contents: '{}', mode: 0o600 },
    ],
    initialize: {
      executable: 'node',
      args: ['/work/memory/init.cjs', '/work/memory/config.json'],
    },
    launcher: '/work/memory/launcher',
    env: { BASH_ENV: '/work/memory/bash-env' },
  };
  h.runtime.memoryGuestPlan = async () => plan;
  h.runtime.retireAfterNativeStop = async () => {};
  h.runtime.start = async (_binding, _signal, scope) => {
    const job = await scope.launch({
      executable: 'node',
      args: ['native-dsh'],
      env: { DSH_HOME: '/work/employee-a' },
    });
    expect(await job.wait(signal())).toEqual({ exitCode: 0, timedOut: false });
  };
  const service = new PersonVmService({ ...h.options, native });
  return {
    h,
    native,
    reloadNative: (disk?: ReadonlyDshRuntimeDisk) =>
      new MicrosandboxPersonVm({
        ...nativeOptions,
        ...(disk && { readonlyDshRuntimeDisk: disk }),
      }),
    rc,
    service,
    mount,
    socketRoot: nativeOptions.socketRoot,
    calls: async () =>
      (await readFile(join(mount, 'host-home/calls.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]),
  };
}

const readonlyImage =
  'docker.io/library/node@sha256:af0bb4bf5b7318e3269417a7684a9e116c3c22eaf05382578b0d0d33de597ad2';
async function readonlyFixture(withSandbox = false) {
  const root = await directory(),
    artifactSha256 = createHash('sha256')
      .update('synthetic archive')
      .digest('hex');
  const release = join(root, artifactSha256),
    hostDirectory = join(release, 'public');
  await mkdir(join(hostDirectory, 'node_modules/.bin'), {
    recursive: true,
    mode: 0o700,
  });
  readonlyRoots.push(release);
  const bins =
    'anthropic-ai-sdk cordis crc32 dsh dsoffice is-docker is-inside-container js-yaml node-which pi-ai playwright playwright-core semver which-command xlsx yaml'.split(
      ' ',
    );
  const text = 'synthetic code\n';
  await writeFile(join(hostDirectory, 'node_modules/code.js'), text, {
    mode: 0o444,
  });
  for (const name of bins)
    await symlink('../code.js', join(hostDirectory, 'node_modules/.bin', name));
  const sandboxCode = 'synthetic runner fixture';
  if (withSandbox) {
    const bin = join(hostDirectory, 'sandbox-bin');
    await mkdir(bin, { mode: 0o700 });
    await writeFile(join(bin, 'bwrap'), sandboxCode, { mode: 0o555 });
    await chmod(bin, 0o555);
  }
  const files = [
    { path: 'node_modules', kind: 'directory', mode: 0o755 },
    { path: 'node_modules/.bin', kind: 'directory', mode: 0o755 },
    {
      path: 'node_modules/code.js',
      kind: 'file',
      mode: 0o644,
      bytes: Buffer.byteLength(text),
      sha256: createHash('sha256').update(text).digest('hex'),
    },
    ...bins.map((name) => ({
      path: `node_modules/.bin/${name}`,
      kind: 'symlink',
      mode: 0o755,
      target: '../code.js',
    })),
  ];
  for (const dir of ['node_modules/.bin', 'node_modules', '.'])
    await chmod(join(hostDirectory, dir), 0o555);
  const manifest = JSON.stringify({
    platform: 'linux-arm64-gnu',
    containsAuthFiles: false,
    archive: { bytes: 512, sha256: artifactSha256 },
    files,
  });
  await writeFile(join(release, 'manifest.json'), manifest, { mode: 0o444 });
  const c = {
    hostDirectory,
    guestDirectory: `/opt/allrice/dsh/${artifactSha256}`,
    artifactSha256,
    manifestSha256: createHash('sha256').update(manifest).digest('hex'),
    descriptorPath: join(release, 'descriptor.json'),
    treeSha256: createHash('sha256')
      .update('synthetic verified tree')
      .digest('hex'),
  };
  const descriptor = JSON.stringify({
    kind: 'allrice-dsh-readonly-directory-v2',
    ...c,
    manifestBytes: Buffer.byteLength(manifest),
    archiveBytes: 512,
    baseImage: readonlyImage,
    dshVersion: '0.2.1-rc.2',
    nodeVersion: '22.23.2',
    publisherSha256: 'a'.repeat(64),
    gateSha256: 'b'.repeat(64),
    ...(withSandbox && {
      sandboxBackend: {
        kind: 'bubblewrap',
        path: 'sandbox-bin/bwrap',
        mode: 0o555,
        architecture: 'arm64',
        packageVersion: '0.8.0-2+deb12u1',
        packageSha256:
          'd044ba1d7961d835669035fcd1e11121f1dc960a1a2e1c6489a93ea44e083557',
        sha256: createHash('sha256').update(sandboxCode).digest('hex'),
      },
    }),
  });
  await writeFile(c.descriptorPath, descriptor, { mode: 0o444 });
  await chmod(release, 0o555);
  return {
    ...c,
    sealedManifestSha256: createHash('sha256').update(descriptor).digest('hex'),
  };
}

describe('Microsandbox public CLI protocol through real child processes (no actual VM)', () => {
  it('releases only the exact owned mount alias and preserves recoverable native state', async () => {
    const f = await bootstrapFixture();
    await f.service.create(f.rc, signal());
    await f.service.start(f.rc, signal());
    const binding = await f.service.resolve(f.rc, signal());
    await f.native.stop(binding, signal());
    const alias = join(f.socketRoot, binding.vmId);
    await expect(
      f.native.releaseDiskHome(binding.vmId, f.mount + '-other', signal()),
    ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
    expect(await readlink(alias)).toBe(join(f.mount, 'microsandbox'));
    await f.native.releaseDiskHome(binding.vmId, f.mount, signal());
    await f.native.releaseDiskHome(binding.vmId, f.mount, signal());
    await expect(lstat(alias)).rejects.toMatchObject({ code: 'ENOENT' });
    const restored = f.reloadNative();
    await restored.prepare(binding, f.mount, signal());
    expect(await restored.status(binding, signal())).toBe('stopped');
  });
  it('reopens only an existing running VM configuration for a bounded detached read after restart', async () => {
    const f = await bootstrapFixture('ok', await readonlyFixture());
    await f.service.create(f.rc, signal());
    await f.service.start(f.rc, signal());
    const binding = await f.service.resolve(f.rc, signal());
    const fresh = f.reloadNative();
    const guard = vi.fn(async () => undefined);
    const current = { binding, signal: signal(), assertCurrent: guard };
    const spec = { executable: 'node', args: ['journal-read-fixture'] };
    const start = (await f.calls()).length;
    await expect(fresh.readAttachedProbe(current, f.mount, spec)).resolves.toBe(
      '{"terminal":true}',
    );
    expect(guard.mock.calls.length).toBeGreaterThan(1);
    const reads = (await f.calls()).slice(start);
    expect(reads.map(([name]) => name)).toEqual([
      '--version',
      'inspect',
      'exec',
      'wait',
      'logs',
    ]);
    expect(reads[2]).toContain('--detach');
    expect(reads[2]).toContain('10s');

    await f.native.stop(binding, signal());
    const stopped = (await f.calls()).length;
    await expect(
      fresh.readAttachedProbe(current, f.mount, spec),
    ).rejects.toMatchObject({
      code: 'PROVIDER_FAILED',
    });
    expect((await f.calls()).slice(stopped).map(([name]) => name)).toEqual([
      '--version',
      'inspect',
    ]);
  });

  function pendingRead<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((resolveRead, rejectRead) => {
      resolve = resolveRead;
      reject = rejectRead;
    });
    return { promise, resolve, reject };
  }

  it.each(['startup', 'web endpoint'] as const)(
    'joins both independent %s reads after one fails',
    async (phase) => {
      const mount = await directory();
      const readonlyDshDirectory = await readonlyFixture();
      const binding = {
        vmId: randomUUID(),
        personId: randomUUID(),
        organizationId: randomUUID(),
        instanceId: randomUUID(),
        leaseEpoch: 1,
      };
      const metadata = pendingRead<void>();
      const inspect = pendingRead<string>();
      const runner = vi.fn(async (command: Parameters<typeof runCommand>[0]) =>
        command.args[0] === 'inspect' ? inspect.promise : 'microsandbox 0.7.16',
      );
      const native = new MicrosandboxPersonVm({
        binary: '/b',
        libkrunfw: '/fw',
        agentd: '/agentd',
        image: readonlyImage,
        readonlyDshDirectory,
        rootDiskGiB: 20,
        socketRoot: await socketDirectory(),
        runner,
      });
      await native.prepare(binding, mount, signal());
      const artifact = vi
        .spyOn(native as unknown as { artifact(): Promise<void> }, 'artifact')
        .mockImplementation(() => metadata.promise);
      let settled = false;
      const operation = (
        phase === 'startup'
          ? native.start(binding, signal())
          : native.assertWebEndpoints(
              { binding, endpoints: [], rosterDigest: '' },
              signal(),
            )
      )
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      const firstFailure = new Error('read failure');
      try {
        expect(artifact).toHaveBeenCalledOnce();
        expect(runner.mock.calls.map(([call]) => call.args[0])).toEqual([
          '--version',
          'inspect',
        ]);
        if (phase === 'startup') metadata.reject(firstFailure);
        else inspect.reject(firstFailure);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
      } finally {
        metadata.resolve();
        inspect.resolve('{}');
        await operation;
      }
      expect(await operation).toBe(firstFailure);
      expect(runner.mock.calls.some(([call]) => call.args[0] === 'start')).toBe(
        false,
      );
    },
  );

  const readerConfiguration = {
    nodeExecutable: '/fixed-node/bin/node',
    cgroupRoot: '/sys/fs/cgroup',
    targets: [
      {
        target: 'commands' as const,
        path: '/sys/fs/cgroup/allrice-commands',
        high: 32,
        max: 64,
        swapMax: 128,
      },
    ],
  };
  const observerConfiguration = {
    nodeExecutable: readerConfiguration.nodeExecutable,
    cgroupRoot: readerConfiguration.cgroupRoot,
    commandsGroup: readerConfiguration.targets[0]!.path,
    dshGroup: '/sys/fs/cgroup/allrice-dsh',
    procRoot: '/proc',
    receiptDirectory: '/work/memory/receipts',
  };
  it('provider memory ports必须显式清理预算，缺失时不派发CLI', async () => {
    const f = await bootstrapFixture();
    f.h.runtime.start = async (_binding, _signal, scope) => {
      expect(() =>
        f.native.memoryGuestReader(scope, readerConfiguration),
      ).toThrow('PROVIDER_FAILED');
      expect(() =>
        f.native.memoryCommandObserver(scope, observerConfiguration),
      ).toThrow('PROVIDER_FAILED');
    };
    await f.service.prewarm(f.rc, { trigger: 'page' }, signal());
    expect((await f.calls()).filter((a) => a[0] === 'exec')).toHaveLength(3); // workdir, staging directory, init
  });
  it('实际provider memory reader/observer映射固定node/roots/binding与exact job；retained wait不继承已关闭scope', async () => {
    const f = await bootstrapFixture('ok', undefined, 5000);
    let scope!: PersonVmBootstrapScope;
    let job!: Awaited<ReturnType<PersonVmBootstrapScope['launch']>>;
    f.h.runtime.start = async (_binding, _signal, current) => {
      scope = current;
      const result = await f.native
        .memoryGuestReader(scope, readerConfiguration)
        .read(scope.binding, signal());
      expect(result).toMatchObject({
        binding: scope.binding,
        state: 'verified',
        scope: 'guest-cgroup',
        boundary: 'guest-root-cooperative',
        groups: [
          {
            path: readerConfiguration.targets[0]!.path,
            observed: { high: 32, max: 64, swapMax: 128 },
          },
        ],
      });
      job = await scope.launch({ executable: 'node', args: ['native-dsh'] });
      const observed = await f.native
        .memoryCommandObserver(scope, observerConfiguration)
        .observeCompletion(
          scope.binding,
          { job, executionRef: 'provider-command' },
          signal(),
        );
      expect(observed).toMatchObject({
        binding: scope.binding,
        jobId: job.jobId,
        outcome: 'unknown',
        reason: 'managed-terminating-signal-unavailable',
        completion: { joined: true, signal: 'unknown' },
        child: { joined: true, released: true },
      });
    };
    await f.service.prewarm(f.rc, { trigger: 'page' }, signal());
    await expect(job.wait(signal())).resolves.toEqual({
      exitCode: 0,
      timedOut: false,
    });
    const calls = await f.calls(),
      name = `allrice-${scope.binding.vmId}`;
    const probes = calls.filter((a) => a[0] === 'exec' && a.includes('-e'));
    expect(probes).toHaveLength(2);
    for (const [i, program] of [
      PERSON_VM_GUEST_CONTROL_READER,
      PERSON_VM_COMMAND_MEMORY_PROGRAM,
    ].entries()) {
      expect(probes[i]!.slice(0, 10)).toEqual([
        'exec',
        name,
        '--detach',
        '--no-stdin',
        '--no-tty',
        '--workdir',
        '/work',
        '--',
        readerConfiguration.nodeExecutable,
        '-e',
      ]);
      expect(probes[i]![10]).toBe(program);
    }
    expect(JSON.parse(probes[0]![11]!)).toEqual({
      cgroupRoot: readerConfiguration.cgroupRoot,
      targets: readerConfiguration.targets.map(({ target, path }) => ({
        target,
        path,
      })),
    });
    expect(JSON.parse(probes[1]![11]!)).toEqual({
      cgroupRoot: observerConfiguration.cgroupRoot,
      commandsGroup: observerConfiguration.commandsGroup,
      dshGroup: observerConfiguration.dshGroup,
      procRoot: '/proc',
      receiptDirectory: '/work/memory/receipts',
      executionRef: 'provider-command',
      pid: 4242,
    });
    expect(probes[1]![12]).toBe('complete-and-release');
    expect(
      calls.filter((a) => a[0] === 'inspect' && a.includes('--job')),
    ).toEqual(
      Array(2).fill(['inspect', name, '--job', job.jobId, '--format', 'json']),
    );
    await expect(
      f.native
        .memoryGuestReader(scope, readerConfiguration)
        .read(scope.binding, signal()),
    ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
    await expect(
      f.native
        .memoryCommandObserver(scope, observerConfiguration)
        .observeCompletion(
          scope.binding,
          { job, executionRef: 'closed-operation' },
          signal(),
        ),
    ).rejects.toBe(scope.signal.reason);
    expect(await f.calls()).toEqual(calls); // Closed scope dispatches no ordinary exec/wait/logs/inspect.
  });
  it.each(['probe', 'retained-command'] as const)(
    'provider %s仅scope取消后CLI真实join；probe独立kill/wait，retained命令不被观察取消杀死',
    async (kind) => {
      const f = await bootstrapFixture(
          kind === 'probe' ? 'cancel-memory-probe' : 'cancel-retained-command',
          undefined,
          5000,
        ),
        controller = new AbortController(),
        caller = new AbortController(),
        reason = new Error('scope-only observation cancellation');
      let observation: Promise<unknown> | undefined;
      f.h.runtime.start = async (_binding, _signal, scope) => {
        if (kind === 'retained-command') {
          const job = await scope.launch({
            executable: 'node',
            args: ['native-dsh'],
          });
          observation = f.native
            .memoryCommandObserver(scope, observerConfiguration)
            .observeCompletion(
              scope.binding,
              { job, executionRef: 'c1-retained-command' },
              caller.signal,
            );
          await observation;
        } else
          await f.native
            .memoryGuestReader(scope, readerConfiguration)
            .read(scope.binding, caller.signal);
      };
      const starting = f.service.prewarm(
        f.rc,
        { trigger: 'page' },
        controller.signal,
      );
      const failure = expect(starting).rejects.toMatchObject({
        code: 'PROVIDER_FAILED',
      });
      try {
        let pid = 0;
        await vi.waitFor(
          async () => {
            pid = Number(
              await readFile(join(f.mount, 'host-home/waiting'), 'utf8'),
            );
            expect(pid).toBeGreaterThan(0);
          },
          { timeout: 5000 },
        );
        controller.abort(reason);
        if (kind === 'retained-command')
          await expect(observation).rejects.toBe(reason);
        await failure;
        expect(caller.signal.aborted).toBe(false);
        expect(() => process.kill(pid, 0)).toThrow();
        const calls = await f.calls(),
          kill = calls.findIndex((a) => a[0] === 'kill');
        if (kind === 'probe') {
          expect(kill).toBeGreaterThan(0);
          expect(calls[kill + 1]).toEqual([
            'wait',
            calls[kill]![1],
            '--job',
            calls[kill]![3],
            '--format',
            'json',
          ]);
          expect(calls.findIndex((a) => a[0] === 'stop')).toBeGreaterThan(
            kill + 1,
          );
        } else {
          expect(kill).toBe(-1);
          const waiting = calls.findLastIndex((a) => a[0] === 'wait');
          expect(calls[waiting - 1]?.[0]).toBe('inspect');
          expect(calls[waiting - 1]?.[3]).toBe(calls[waiting]?.[3]);
          expect(calls.findIndex((a) => a[0] === 'stop')).toBeGreaterThan(
            waiting,
          );
        }
        expect(f.h.mounts.size).toBe(0);
      } finally {
        controller.abort();
        caller.abort();
        await starting.catch(() => {});
      }
    },
  );
  it('readonly code首次create走真实provider/child入口；准确mount及active inspect，stop后原绑定start对账同版密封manifest', async () => {
    const c = await readonlyFixture(),
      f = await bootstrapFixture('ok', c);
    await f.service.prewarm(f.rc, { trigger: 'page' }, signal());
    const binding = await f.service.resolve(f.rc, signal()),
      calls = await f.calls();
    const creation = calls.find((args) => args[0] === 'create')!;
    expect(
      creation.flatMap((arg, index) =>
        arg === '--mount-dir' ? [creation[index + 1]] : [],
      ),
    ).toEqual([`${c.hostDirectory}:${c.guestDirectory}:ro`]);
    expect(creation[creation.indexOf('--pull') + 1]).toBe('never');
    expect(creation[creation.indexOf('--net-default') + 1]).toBe('deny');
    expect(creation[creation.indexOf('--max-memory') + 1]).toBe('2048M');
    expect(
      (await lstat(join(f.mount, 'microsandbox/allrice-readonly-dsh.json')))
        .mode & 0o777,
    ).toBe(0o600);
    await f.native.stop(binding, signal());
    await f.native.start(binding, signal());
    expect(await f.native.status(binding, signal())).toBe('running');
    expect(
      (await f.calls()).filter((args) => args[0] === 'start'),
    ).toHaveLength(1);
    await chmod(dirname(c.hostDirectory), 0o755);
    await rm(c.descriptorPath);
    await expect(f.native.ping(binding, signal())).rejects.toMatchObject({
      code: 'PROVIDER_FAILED',
    });
    // Source loss must not gate stop/status or physical cleanup.
    await f.native.stop(binding, signal());
    expect(await f.native.status(binding, signal())).toBe('stopped');
  });
  it.each([false, true])(
    'passes only a verified bundled runner to the exact native DSH process (bundle present = %s)',
    async (withSandbox) => {
      const c = await readonlyFixture(withSandbox);
      const f = await bootstrapFixture('ok', c);
      const cli =
        c.guestDirectory + '/node_modules/@deepseek-ai/dsh/lib/bin.js';
      const other = '/work/other.cjs';
      f.h.runtime.start = async (_binding, _signal, scope) => {
        for (const path of [cli, other]) {
          const job = await scope.launch({
            executable: 'node',
            args: [path],
            env: { DSH_HOME: '/work/employee-a', PATH: '/work/caller-path' },
          });
          expect(await job.wait(signal())).toEqual({
            exitCode: 0,
            timedOut: false,
          });
        }
      };
      await f.service.prewarm(f.rc, { trigger: 'page' }, signal());
      const calls = await f.calls();
      const launches = calls.filter((args) => args[0] === 'exec');
      const dsh = launches.find((args) => args.at(-1) === cli);
      const otherNode = launches.find((args) => args.at(-1) === other);
      const staged = launches.filter((args) =>
        args.includes(prepareDshSandbox),
      );
      const sha = createHash('sha256')
        .update('synthetic runner fixture')
        .digest('hex');
      expect(staged).toHaveLength(withSandbox ? 1 : 0);
      if (withSandbox) {
        expect(staged[0]!.slice(-4)).toEqual([
          '-e',
          prepareDshSandbox,
          c.guestDirectory,
          sha,
        ]);
        expect(launches.indexOf(staged[0]!)).toBeLessThan(
          launches.indexOf(dsh!),
        );
      }
      const readPath = (args?: string[]) =>
        args?.filter(
          (arg, index) =>
            args[index - 1] === '--env' && arg.startsWith('PATH='),
        );
      expect(readPath(dsh)).toEqual([
        withSandbox
          ? 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
          : 'PATH=/work/caller-path',
      ]);
      if (withSandbox) {
        expect(dsh?.slice(-7)).toEqual([
          '/bin/sh',
          '-c',
          launchDshSandbox,
          'allrice-dsh',
          DSH_SANDBOX_ROOT +
            '/' +
            sha +
            ':/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
          '/usr/local/bin/node',
          cli,
        ]);
      }
      expect(readPath(otherNode)).toEqual(['PATH=/work/caller-path']);
      expect(
        launches
          .filter((args) => args !== dsh && args !== otherNode)
          .every((args) => readPath(args)?.length === 0),
      ).toBe(true);
    },
  );
  it('rejects DSH startup and stops the VM when sandbox staging fails', async () => {
    const c = await readonlyFixture(true);
    const f = await bootstrapFixture('sandbox-stage-error', c);
    await expect(
      f.service.prewarm(f.rc, { trigger: 'page' }, signal()),
    ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    const calls = await f.calls();
    expect(calls.some((args) => args.includes(prepareDshSandbox))).toBe(true);
    expect(calls.some((args) => args.includes('native-dsh'))).toBe(false);
    expect(calls.some((args) => args[0] === 'stop')).toBe(true);
  });
  it('source qualification失败不pull/create/start；真实prepare/status和失败detach仍可收敛', async () => {
    const c = await readonlyFixture();
    await chmod(dirname(c.hostDirectory), 0o755);
    await rm(c.descriptorPath);
    const f = await bootstrapFixture('ok', c);
    await expect(
      f.service.prewarm(f.rc, { trigger: 'page' }, signal()),
    ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    expect(
      (await f.calls()).some((args) =>
        ['pull', 'create', 'start'].includes(args[0]!),
      ),
    ).toBe(false);
    expect(f.h.log).toContain('disk:detach');
  });
  it('create真正成功而active只读inspect不符必须失败并真实stop，不能report ready', async () => {
    const c = await readonlyFixture(),
      f = await bootstrapFixture('artifact-inspect-drift', c);
    await expect(
      f.service.prewarm(f.rc, { trigger: 'page' }, signal()),
    ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    const calls = await f.calls();
    expect(calls.some((args) => args[0] === 'create')).toBe(true);
    expect(calls.some((args) => args[0] === 'stop')).toBe(true);
    expect(f.h.log).toContain('disk:detach');
  });
  it('runtime启动后source损坏且callback失败，confirmed native stop清理不被artifact检查拦截', async () => {
    const c = await readonlyFixture(),
      f = await bootstrapFixture('ok', c);
    let runtimeEntered = false;
    f.h.runtime.start = async () => {
      runtimeEntered = true;
      await chmod(dirname(c.hostDirectory), 0o755);
      await rm(c.descriptorPath);
      throw new Error('synthetic startup failure');
    };
    await expect(
      f.service.prewarm(f.rc, { trigger: 'page' }, signal()),
    ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    expect(runtimeEntered).toBe(true);
    expect((await f.calls()).some((args) => args[0] === 'stop')).toBe(true);
    expect(f.h.log).toContain('disk:detach');
  });
  function roster(
    f: Awaited<ReturnType<typeof bootstrapFixture>>,
    count = 2,
  ): PersonVmWebRoster {
    const facts = {
      personId: f.rc.actor.id,
      organizationId: f.rc.organizationId,
      entries: Array.from({ length: count }, () => ({
        workspaceId: randomUUID(),
        employeeInstanceId: randomUUID(),
        employeeRevision: 1,
        employeeVersionId: randomUUID(),
      })).sort((a, b) =>
        a.employeeInstanceId.localeCompare(b.employeeInstanceId),
      ),
    };
    return {
      ...facts,
      digest: `sha256:${createHash('sha256').update(JSON.stringify(facts)).digest('hex')}`,
    };
  }
  it('首次真实CLI create仅发布实际员工清单并核active inspect；0600 host manifest与scope receipt对应', async () => {
    const f = await bootstrapFixture(),
      assigned = roster(f);
    let startup: PersonVmWebStartup | undefined;
    f.h.runtime.start = async (_binding, _signal, _scope, web) => {
      startup = web;
    };
    const service = new PersonVmService({
      ...f.h.options,
      native: f.native,
      nativeWeb: { prepare: async () => assigned },
    });
    const view = await service.prewarm(f.rc, { trigger: 'page' }, signal());
    expect(view.ready).toBe(true); // Fixture runtime readiness, not native editor evidence.
    expect(startup?.context).toBe(f.rc);
    expect(startup?.receipt.rosterDigest).toBe(assigned.digest);
    expect(startup?.receipt.binding).toEqual(
      await service.resolve(f.rc, signal()),
    );
    const calls = await f.calls(),
      creation = calls.find((args) => args[0] === 'create')!;
    const mappings = creation.flatMap((arg, index) =>
      arg === '-p' ? [creation[index + 1]] : [],
    );
    expect(mappings).toEqual(
      startup!.receipt.endpoints.map(
        (entry) => `127.0.0.1:${entry.hostPort}:${entry.guestPort}`,
      ),
    );
    expect(mappings).toHaveLength(assigned.entries.length);
    expect(
      creation.flatMap((arg, index) =>
        arg === '--net-rule' ? [creation[index + 1]] : [],
      ),
    ).toEqual([
      ...outboundRules,
      ...startup!.receipt.endpoints.map(
        (entry) => `allow:ingress@127.0.0.1/32:tcp:${entry.guestPort}`,
      ),
    ]);
    expect(creation[creation.indexOf('--net-default') + 1]).toBe('deny');
    expect(
      new Set(startup!.receipt.endpoints.map((entry) => entry.hostPort)).size,
    ).toBe(assigned.entries.length);
    expect(calls.some((args) => args[0] === 'inspect')).toBe(true);
    const path = join(
      f.mount,
      'microsandbox/allrice-native-web-endpoints.json',
    );
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    expect(manifest).toMatchObject({
      vmId: view.vmId,
      personId: f.rc.actor.id,
      digest: assigned.digest,
      endpoints: startup!.receipt.endpoints,
    });
    expect(Object.keys(manifest).sort()).toEqual([
      'digest',
      'endpoints',
      'organizationId',
      'personId',
      'version',
      'vmId',
    ]);
    expect(JSON.stringify(startup)).not.toMatch(
      /ownerToken|mount|authenticatedUrl|\?token=/,
    );
    const original = await readFile(path);
    expect(
      (await service.prewarm(f.rc, { trigger: 'page' }, signal())).ready,
    ).toBe(true);
    expect(await readFile(path)).toEqual(original);
    expect(
      (await f.calls()).filter((args) => args[0] === 'create'),
    ).toHaveLength(1);
  });
  it('原生create规则只按已保存的guest G而非host H；保留/32精确TCP与原出口（非policy运行验收）', async () => {
    const f = await bootstrapFixture(),
      assigned = roster(f, 1);
    const binding = {
      vmId: randomUUID(),
      instanceId: randomUUID(),
      leaseEpoch: 1,
      personId: f.rc.actor.id,
      organizationId: f.rc.organizationId,
    };
    await f.native.prepare(binding, f.mount, signal());
    const prior = await f.native.prepareWebEndpoints(
      binding,
      assigned,
      signal(),
    );
    const path = join(
      f.mount,
      'microsandbox/allrice-native-web-endpoints.json',
    );
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    const h = prior.endpoints[0]!.hostPort,
      g = h === 18101 ? 18102 : 18101;
    manifest.endpoints[0].guestPort = g;
    await writeFile(path, JSON.stringify(manifest));
    const web = await f.native.prepareWebEndpoints(binding, assigned, signal());
    await f.native.create(binding, currentReceipt(binding), signal(), web);
    const create = (await f.calls()).find((args) => args[0] === 'create')!;
    expect(
      create.flatMap((arg, i) => (arg === '--net-rule' ? [create[i + 1]] : [])),
    ).toEqual([...outboundRules, `allow:ingress@127.0.0.1/32:tcp:${g}`]);
    expect(create).toContain(`127.0.0.1:${h}:${g}`);
    expect(create).not.toContain(`allow:ingress@127.0.0.1/32:tcp:${h}`);
    expect(create[create.indexOf('--net-default') + 1]).toBe('deny');
  });
  it.each([true, false])(
    'retained start checks stopped and final ready separately; combined ports and mounts=%s',
    async (combined) => {
      const f = await bootstrapFixture('ok', await readonlyFixture());
      const assigned = roster(f, 1);
      if (!combined)
        Object.defineProperty(f.native, 'startWithWebEndpoints', {
          value: undefined,
        });
      const service = new PersonVmService({
        ...f.h.options,
        native: f.native,
        nativeWeb: { prepare: async () => assigned },
      });
      expect(
        (await service.prewarm(f.rc, { trigger: 'page' }, signal())).ready,
      ).toBe(true);
      await f.native.stop(await service.resolve(f.rc, signal()), signal());
      await service.stop(f.rc, signal());
      const before = (await f.calls()).length;
      expect((await service.start(f.rc, signal())).ready).toBe(true);
      const calls = (await f.calls()).slice(before);
      const verbs = calls.map(([verb]) => verb);
      const start = verbs.indexOf('start');
      const bootstrap = verbs.indexOf('exec');
      expect(start).toBeGreaterThan(0);
      expect(bootstrap).toBeGreaterThan(start);
      expect(verbs[start - 1]).toBe('inspect');
      expect(verbs.slice(start + 1, bootstrap)).toEqual(
        combined ? ['inspect'] : ['inspect', 'inspect'],
      );
      expect(verbs.slice(verbs.lastIndexOf('ping'))).toEqual([
        'ping',
        'inspect',
      ]);
      expect(verbs).not.toContain('create');
    },
  );
  it.each(['retained-web-drift', 'retained-mount-drift'])(
    'rejects %s in the shared post-start inspection before any bootstrap',
    async (mode) => {
      const f = await bootstrapFixture(mode, await readonlyFixture());
      const assigned = roster(f, 1);
      const service = new PersonVmService({
        ...f.h.options,
        native: f.native,
        nativeWeb: { prepare: async () => assigned },
      });
      await service.prewarm(f.rc, { trigger: 'page' }, signal());
      await f.native.stop(await service.resolve(f.rc, signal()), signal());
      await service.stop(f.rc, signal());
      const before = (await f.calls()).length;
      await expect(service.start(f.rc, signal())).rejects.toMatchObject({
        code: 'PROVIDER_FAILED',
      });
      const verbs = (await f.calls()).slice(before).map(([verb]) => verb);
      const afterStart = verbs.slice(verbs.indexOf('start') + 1);
      expect(afterStart[0]).toBe('inspect');
      expect(afterStart.filter((verb) => verb === 'inspect')).toHaveLength(1);
      expect(afterStart).not.toContain('exec');
      expect(afterStart).not.toContain('cp');
      expect(afterStart).toContain('stop');
      expect(afterStart.slice(afterStart.indexOf('stop') + 1)).toContain(
        'list',
      );
      expect(f.h.mounts.size).toBe(0);
    },
  );
  it.each(['success', 'cancel', 'write-failure'] as const)(
    'reservation真实接入立即关闭，manifest %s后service/lease与原H全部真实join',
    async (mode) => {
      const f = await bootstrapFixture(),
        assigned = roster(f, 1),
        cancelled = new AbortController();
      const service = new PersonVmService({
        ...f.h.options,
        native: f.native,
        nativeWeb: { prepare: async () => assigned },
      });
      const created = await service.create(f.rc, signal());
      const binding = {
        vmId: created.vmId,
        instanceId: randomUUID(),
        leaseEpoch: 1,
        personId: f.rc.actor.id,
        organizationId: f.rc.organizationId,
      };
      await f.native.prepare(binding, f.mount, signal());
      const prior = await f.native.prepareWebEndpoints(
        binding,
        assigned,
        signal(),
      );
      const probe = await open(join(f.mount, 'sync-probe'), 'wx');
      const prototype = Object.getPrototypeOf(probe) as FileHandle;
      const sync = prototype.sync;
      await probe.close();
      let entered!: () => void, release!: () => void;
      const inside = new Promise<void>((done) => {
        entered = done;
      });
      const gate = new Promise<void>((done) => {
        release = done;
      });
      const diskError = new Error('synthetic manifest sync failure'),
        cancelError = new Error('synthetic cancellation');
      vi.spyOn(prototype, 'sync').mockImplementation(async function (
        this: FileHandle,
      ) {
        entered();
        await gate;
        if (mode === 'write-failure') throw diskError;
        await sync.call(this);
      });
      const starting = service.start(f.rc, cancelled.signal).then(
        () => null,
        (error: unknown) => error,
      );
      await inside;
      const peer = createConnection(prior.endpoints[0]!.hostPort, '127.0.0.1');
      peer.on('error', () => {});
      const closed = new Promise<void>((done) => peer.once('close', done));
      try {
        await once(peer, 'connect');
        await closed; // Must happen while fsync is blocked, not just in finally.
        expect(peer.destroyed).toBe(true);
        if (mode === 'cancel') cancelled.abort(cancelError);
      } finally {
        peer.destroy();
        release();
        await closed;
        await starting;
      }
      const outcome = await starting;
      if (mode === 'success') expect(outcome).toBe(null);
      else
        expect(outcome).toMatchObject({
          code: 'PROVIDER_FAILED',
          cause: mode === 'cancel' ? cancelError : diskError,
        });
      expect((await f.h.store.read(f.rc.actor.id))!.leaseOwner).toBe(null);
      expect(f.h.mounts.size).toBe(mode === 'success' ? 1 : 0);
      const rebound = createServer();
      try {
        rebound.listen(prior.endpoints[0]!.hostPort, '127.0.0.1');
        await once(rebound, 'listening');
      } finally {
        await new Promise<void>((done, reject) =>
          rebound.close((error) => (error ? reject(error) : done())),
        );
      }
      expect((await f.calls()).some((args) => args[0] === 'create')).toBe(
        mode === 'success',
      );
    },
  );
  it('运行中新增员工立即preparing；不hold等待、不改manifest、不modify/stop/restart已有任务', async () => {
    const f = await bootstrapFixture();
    let assigned = roster(f);
    const service = new PersonVmService({
      ...f.h.options,
      native: f.native,
      nativeWeb: { prepare: async () => assigned },
    });
    await service.prewarm(f.rc, { trigger: 'page' }, signal());
    const manifest = join(
      f.mount,
      'microsandbox/allrice-native-web-endpoints.json',
    );
    const original = await readFile(manifest),
      before = (await f.calls()).length;
    const facts = {
      personId: assigned.personId,
      organizationId: assigned.organizationId,
      entries: [...assigned.entries, ...roster(f, 1).entries].sort((a, b) =>
        a.employeeInstanceId.localeCompare(b.employeeInstanceId),
      ),
    };
    assigned = {
      ...facts,
      digest: `sha256:${createHash('sha256').update(JSON.stringify(facts)).digest('hex')}`,
    };
    await expect(
      service.prewarm(f.rc, { trigger: 'input' }, signal()),
    ).rejects.toMatchObject({ code: 'WEB_ENDPOINTS_PREPARING' });
    expect(await readFile(manifest)).toEqual(original);
    expect((await service.read(f.rc, signal()))?.phase).toBe('running');
    expect(
      (await f.calls())
        .slice(before)
        .some((args) =>
          ['create', 'start', 'stop', 'modify', 'pull', 'exec', 'cp'].includes(
            args[0]!,
          ),
        ),
    ).toBe(false);
  });
  it.each(['web-inspect-mismatch', 'web-inspect-unknown-stop'])(
    'active端口缺失即使pending_changes=[]也拒绝，%s清理必须真实off才detach',
    async (mode) => {
      const f = await bootstrapFixture(mode),
        assigned = roster(f, 1);
      const service = new PersonVmService({
        ...f.h.options,
        native: f.native,
        nativeWeb: { prepare: async () => assigned },
      });
      await expect(
        service.prewarm(f.rc, { trigger: 'page' }, signal()),
      ).rejects.toMatchObject({
        code: mode.endsWith('unknown-stop')
          ? 'CLEANUP_INCOMPLETE'
          : 'PROVIDER_FAILED',
      });
      expect((await f.calls()).some((args) => args[0] === 'stop')).toBe(true);
      expect(f.h.log.includes('disk:detach')).toBe(
        !mode.endsWith('unknown-stop'),
      );
    },
  );
  it('现有native实例的manifest缺失/非0600/含额外字段一律保留拒绝，不创建替代映射', async () => {
    const f = await bootstrapFixture(),
      assigned = roster(f, 1);
    const service = new PersonVmService({
      ...f.h.options,
      native: f.native,
      nativeWeb: { prepare: async () => assigned },
    });
    await service.prewarm(f.rc, { trigger: 'page' }, signal());
    const path = join(
      f.mount,
      'microsandbox/allrice-native-web-endpoints.json',
    );
    const original = await readFile(path, 'utf8'),
      before = (await f.calls()).length;
    const value = JSON.parse(original);
    value.endpoints[0].unexpected = 'not-an-authority-field';
    await writeFile(path, JSON.stringify(value));
    await expect(service.start(f.rc, signal())).rejects.toMatchObject({
      code: 'PROVIDER_FAILED',
    });
    expect(await readFile(path, 'utf8')).toBe(JSON.stringify(value));
    await writeFile(path, original);
    await chmod(path, 0o644);
    await expect(service.start(f.rc, signal())).rejects.toMatchObject({
      code: 'PROVIDER_FAILED',
    });
    expect((await lstat(path)).mode & 0o777).toBe(0o644);
    await rm(path);
    await expect(service.start(f.rc, signal())).rejects.toMatchObject({
      code: 'WEB_ENDPOINTS_PREPARING',
    });
    expect(
      (await f.calls())
        .slice(before)
        .some((args) =>
          ['pull', 'create', 'start', 'stop', 'modify'].includes(args[0]!),
        ),
    ).toBe(false);
  });
  it('首次create前失败重试仅认原manifest端口；真实OS占用则失败保留，不随机换号', async () => {
    const f = await bootstrapFixture(),
      assigned = roster(f, 1);
    const binding = {
      vmId: randomUUID(),
      instanceId: randomUUID(),
      leaseEpoch: 1,
      personId: f.rc.actor.id,
      organizationId: f.rc.organizationId,
    };
    await f.native.prepare(binding, f.mount, signal());
    const receipt = await f.native.prepareWebEndpoints(
      binding,
      assigned,
      signal(),
    );
    const path = join(
        f.mount,
        'microsandbox/allrice-native-web-endpoints.json',
      ),
      original = await readFile(path);
    const occupied = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        occupied.once('error', reject);
        occupied.listen(receipt.endpoints[0]!.hostPort, '127.0.0.1', resolve);
      });
      await expect(
        f.native.prepareWebEndpoints(binding, assigned, signal()),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(await readFile(path)).toEqual(original);
      expect(
        (await f.calls()).some((args) =>
          ['create', 'modify', 'start'].includes(args[0]!),
        ),
      ).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        occupied.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it.each([3000, 3001])(
    '真实service scope把固定nonce reader送入原生exec（%sms）；argv无资格，过期scope拒绝读取',
    async (timeoutMs) => {
      const f = await bootstrapFixture(),
        dshHome = await directory(),
        nonce = randomUUID();
      await mkdir(join(dshHome, 'native-web'));
      const localAuthSample = 'QWxsUmljZU5hdGl2ZVdlYkF1dGhGaXh0dXJlT25seTA';
      const authenticatedUrl = `http://127.0.0.1:32179/?token=${localAuthSample}`;
      await writeFile(
        join(dshHome, 'native-web', `auth-${nonce}.json`),
        JSON.stringify({ v: 1, nonce, authenticatedUrl }),
      );
      const request = {
        dshHome,
        nonce,
        origin: 'http://127.0.0.1:32179/',
        timeoutMs,
      };
      let read!: NonNullable<PersonVmBootstrapScope['readNativeWebAuth']>;
      f.h.runtime.start = async (_binding, _signal, scope) => {
        read = scope.readNativeWebAuth!;
        expect(await read(request)).toEqual({ authenticatedUrl });
      };
      await f.service.prewarm(f.rc, { trigger: 'page' }, signal());
      const calls = await f.calls();
      expect(
        calls.some(
          (args) =>
            args[0] === 'exec' &&
            !args.includes('--detach') &&
            args.includes('--timeout'),
        ),
      ).toBe(true);
      const reader = calls.find(
        (args) => args[0] === 'exec' && !args.includes('--detach'),
      )!;
      expect(reader[reader.indexOf('--timeout') + 1]).toBe(
        `${Math.ceil(timeoutMs / 1000)}s`,
      );
      expect(JSON.stringify(calls)).not.toContain(localAuthSample);
      await expect(read(request)).rejects.toMatchObject({ code: 'LEASE_LOST' });
      expect(await f.calls()).toEqual(calls);
    },
  );
  it.each([false, true])(
    '真实reader失败仍stop/status；未知stop=%s不得detach或ready',
    async (unknownStop) => {
      const f = await bootstrapFixture(
          unknownStop ? 'auth-unknown-stop' : 'ok',
        ),
        dshHome = await directory(),
        nonce = randomUUID();
      // A directory is an invalid artifact: the real fixed reader must fail.
      await mkdir(join(dshHome, 'native-web', `auth-${nonce}.json`), {
        recursive: true,
      });
      f.h.runtime.start = async (_binding, _signal, scope) => {
        await scope.readNativeWebAuth!({
          dshHome,
          nonce,
          origin: 'http://127.0.0.1:32179/',
          timeoutMs: 3001,
        });
      };
      await expect(
        f.service.prewarm(f.rc, { trigger: 'page' }, signal()),
      ).rejects.toMatchObject({
        code: unknownStop ? 'CLEANUP_INCOMPLETE' : 'PROVIDER_FAILED',
      });
      const calls = await f.calls(),
        stopped = calls.findIndex((args) => args[0] === 'stop');
      expect(stopped).toBeGreaterThan(0);
      expect(calls.slice(stopped + 1).some((args) => args[0] === 'list')).toBe(
        true,
      );
      expect(f.h.mounts.size).toBe(unknownStop ? 1 : 0);
    },
  );
  it.each(['deadline', 'owner'] as const)(
    '取消认证读（%s）后 join 实际 CLI 再 stop/status',
    async (source) => {
      const f = await bootstrapFixture('auth-budget'),
        dshHome = await directory(),
        budget = new AbortController(),
        owner = new AbortController(),
        timeout = AbortSignal.timeout.bind(AbortSignal);
      // Control the actual host deadline at admission, rather than rely on wall-clock sleeps.
      const deadline = vi
        .spyOn(AbortSignal, 'timeout')
        .mockImplementation((ms) =>
          ms === 1001 ? budget.signal : timeout(ms),
        );
      f.h.runtime.start = async (_binding, _signal, scope) => {
        await scope.readNativeWebAuth!(
          {
            dshHome,
            nonce: randomUUID(),
            origin: 'http://127.0.0.1:32179/',
            timeoutMs: 1001,
          },
          owner.signal,
        );
      };
      const start = f.service.prewarm(f.rc, { trigger: 'page' }, signal());
      const failure = expect(start).rejects.toMatchObject({
        code: 'PROVIDER_FAILED',
      });
      let pid = 0;
      try {
        await vi.waitFor(
          async () => {
            pid = Number(
              await readFile(join(f.mount, 'host-home/auth-reading'), 'utf8'),
            );
            expect(pid).toBeGreaterThan(0);
          },
          { timeout: 5000 },
        );
        expect(deadline).toHaveBeenCalledWith(1001);
        if (source === 'owner') owner.abort();
        else budget.abort();
        await failure;
        expect(() => process.kill(pid, 0)).toThrow();
        const calls = await f.calls();
        const reader = calls.find(
          (args) => args[0] === 'exec' && !args.includes('--detach'),
        )!;
        expect(reader[reader.indexOf('--timeout') + 1]).toBe('2s');
        const stopped = calls.findIndex((args) => args[0] === 'stop');
        expect(stopped).toBeGreaterThan(0);
        expect(
          calls.slice(stopped + 1).some((args) => args[0] === 'list'),
        ).toBe(true);
        expect(f.h.mounts.size).toBe(0);
      } finally {
        budget.abort();
        await start.catch(() => {});
      }
    },
  );
  it('service真实启动入口按cp/mode→managed init wait→固定launcher/env，running不重init', async () => {
    const f = await bootstrapFixture();
    await f.service.prewarm(f.rc, { trigger: 'page' }, signal());
    const before = await f.calls(),
      init = before.findIndex(
        (a) => a[0] === 'exec' && a.includes('/work/memory/init.cjs'),
      );
    const launch = before.findIndex(
      (a) => a[0] === 'exec' && a.includes('/work/memory/launcher'),
    );
    const firstGuest = before.findIndex((a) => a[0] === 'exec');
    expect(before[firstGuest]?.slice(2)).toEqual([
      '--detach',
      '--no-stdin',
      '--no-tty',
      '--timeout',
      '10s',
      '--workdir',
      '/bin',
      '--',
      '/bin/mkdir',
      '-p',
      '--',
      '/work',
    ]);
    expect(before[firstGuest + 1]?.[0]).toBe('wait');
    expect(before[firstGuest + 1]).toContain('--job');
    expect(firstGuest + 1).toBeLessThan(before.findIndex((a) => a[0] === 'cp'));
    expect(before.filter((a) => a[0] === 'cp')).toHaveLength(3);
    expect(before.slice(0, init).filter((a) => a[0] === 'cp')).toHaveLength(3);
    expect(
      before
        .slice(init + 1, launch)
        .some(
          (a) => a[0] === 'wait' && a.includes('--job') && a.includes('json'),
        ),
    ).toBe(true);
    expect(before[launch]).toEqual(
      expect.arrayContaining([
        'BASH_ENV=/work/memory/bash-env',
        'DSH_HOME=/work/employee-a',
        '--',
        '/work/memory/launcher',
        'node',
        'native-dsh',
      ]),
    );
    const state = JSON.parse(
      await readFile(join(f.mount, 'host-home/state.json'), 'utf8'),
    );
    expect(state.copies.map((c: { mode: number }) => c.mode)).toEqual([
      0o700, 0o700, 0o600,
    ]);
    expect(
      (await readdir(join(f.mount, 'host-home'))).some((name) =>
        name.startsWith('bootstrap-'),
      ),
    ).toBe(false);
    await f.service.start(f.rc, signal());
    expect((await f.calls()).filter((a) => a[0] === 'exec')).toHaveLength(4); // workdir, staging directory, init, DSH
    expect(
      await f.native.exec(
        await f.service.resolve(f.rc, signal()),
        ['node', '-e', 'diagnostic'],
        signal(),
      ),
    ).toContain('synthetic-exec-protocol');
  });
  it.each([
    'workdir-init-error',
    'workdir-dispatch-failed',
    'workdir-unknown-wait',
    'workdir-lost-id',
    'workdir-lost-id-unknown-stop',
    'init-error',
    'lost-id',
    'lost-id-unknown-stop',
    'unknown-wait',
  ])('bootstrap %s不ready；真实stop确认后才detach', async (mode) => {
    const f = await bootstrapFixture(mode);
    await expect(
      f.service.prewarm(f.rc, { trigger: 'page' }, signal()),
    ).rejects.toMatchObject({
      code:
        mode.endsWith('unknown-stop') || mode.endsWith('unknown-wait')
          ? 'CLEANUP_INCOMPLETE'
          : 'PROVIDER_FAILED',
    });
    const calls = await f.calls();
    expect(calls.some((a) => a[0] === 'stop')).toBe(true);
    expect(
      calls.some((a) => a[0] === 'exec' && a.includes('/work/memory/launcher')),
    ).toBe(false);
    if (mode.startsWith('workdir-') || mode === 'unknown-wait')
      expect(calls.some((a) => a[0] === 'cp')).toBe(false);
    expect(f.h.mounts.size).toBe(mode.endsWith('unknown-stop') ? 1 : 0);
  });
  it.each([1, 3])(
    'rechecks current authority after copy %i before sending another file or initializing',
    async (copies) => {
      const f = await bootstrapFixture();
      const authorize = f.h.options.authority.authorize;
      const plan = f.h.runtime.memoryGuestPlan;
      f.h.runtime.memoryGuestPlan = async (...args) => {
        const result = await plan(...args);
        f.h.options.authority.authorize = async (...input) => {
          if (
            (await f.calls()).filter(([verb]) => verb === 'cp').length >= copies
          )
            f.h.authorize(false);
          return authorize(...input);
        };
        return result;
      };
      await expect(
        f.service.prewarm(f.rc, { trigger: 'page' }, signal()),
      ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
      const calls = await f.calls();
      expect(calls.filter(([verb]) => verb === 'cp')).toHaveLength(copies);
      expect(calls.filter(([verb]) => verb === 'exec')).toHaveLength(2); // only directory setup
      expect(calls.some(([verb]) => verb === 'stop')).toBe(true);
      expect(f.h.mounts.size).toBe(0);
      expect(
        (await readdir(join(f.mount, 'host-home'))).some((name) =>
          name.startsWith('bootstrap-'),
        ),
      ).toBe(false);
    },
  );
  it('rechecks the admitted ticket after staging the host file and before the first guest copy', async () => {
    const f = await bootstrapFixture();
    const home = join(f.mount, 'host-home');
    const readPlan = f.h.runtime.memoryGuestPlan;
    let planning = false;
    let staged = false;
    f.h.runtime.memoryGuestPlan = async (...args) => {
      planning = true;
      return readPlan(...args);
    };
    await expect(
      f.service.prewarm(
        f.rc,
        {
          trigger: 'page',
          target: {
            vmId: null,
            instanceId: null,
            leaseEpoch: 1,
            async assertAuthority() {
              if (!planning) return;
              const directory = (await readdir(home)).find((name) =>
                name.startsWith('bootstrap-'),
              );
              if (
                directory &&
                (await readdir(join(home, directory))).includes('0')
              ) {
                staged = true;
                throw new PersonVmError('AUTHORIZATION_DENIED');
              }
            },
          },
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    expect(staged).toBe(true);
    const calls = await f.calls();
    expect(calls.some(([verb]) => verb === 'cp')).toBe(false);
    expect(calls.some(([verb]) => verb === 'stop')).toBe(true);
    expect(f.h.mounts.size).toBe(0);
    expect(
      (await readdir(home)).some((name) => name.startsWith('bootstrap-')),
    ).toBe(false);
  });
  it('a partial native cp failure never sends the remaining files or initializes', async () => {
    const f = await bootstrapFixture('partial-copy');
    await expect(
      f.service.prewarm(f.rc, { trigger: 'page' }, signal()),
    ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    const verbs = (await f.calls()).map(([verb]) => verb);
    expect(verbs.filter((verb) => verb === 'cp')).toHaveLength(1);
    expect(verbs.filter((verb) => verb === 'exec')).toHaveLength(2); // only directory setup
    expect(verbs).toContain('stop');
    expect(f.h.mounts.size).toBe(0);
    expect(
      (await readdir(join(f.mount, 'host-home'))).some((name) =>
        name.startsWith('bootstrap-'),
      ),
    ).toBe(false);
  });
  it.each(['cancel-workdir', 'cancel-init'])(
    '取消正在wait的 %s：CLI退出后仍exact kill+wait非零JSON；随后native stop/status',
    async (mode) => {
      const f = await bootstrapFixture(mode),
        controller = new AbortController();
      const start = f.service.prewarm(
        f.rc,
        { trigger: 'page' },
        controller.signal,
      );
      const failure = expect(start).rejects.toMatchObject({
        code: 'PROVIDER_FAILED',
      });
      let pid = 0;
      for (let attempt = 0; attempt < 200 && !pid; attempt += 1) {
        try {
          pid = Number(
            await readFile(join(f.mount, 'host-home/waiting'), 'utf8'),
          );
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      controller.abort();
      await failure;
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow();
      const calls = await f.calls(),
        kill = calls.findIndex((a) => a[0] === 'kill');
      expect(kill).toBeGreaterThan(0);
      expect(calls[kill + 1]).toEqual([
        'wait',
        calls[kill]![1],
        '--job',
        calls[kill]![3],
        '--format',
        'json',
      ]);
      expect(calls.findIndex((a) => a[0] === 'stop')).toBeGreaterThan(kill + 1);
      expect(f.h.mounts.size).toBe(0);
    },
  );
  it('空MSB_HOME公开pull预置、2G硬帽、默认deny、固定host端口、真正stop/start命令', async () => {
    vi.stubEnv('ALLRICE_PERSON_VM_SYNTHETIC_HOST_SECRET', 'must-not-inherit');
    const root = await directory();
    const socketRoot = await socketDirectory();
    const binary = join(root, 'msb-fixture');
    await writeFile(
      binary,
      `#!${process.execPath}
const fs=require('node:fs'),p=require('node:path'),a=process.argv.slice(2),home=process.env.HOME;
const f=p.join(home,'state.json'),v=fs.existsSync(f)?JSON.parse(fs.readFileSync(f)):{};
fs.appendFileSync(p.join(home,'calls.jsonl'),JSON.stringify({args:a,envKeys:Object.keys(process.env).sort()})+'\\n');
if(a[0]==='--version')console.log('microsandbox 0.7.16');
else if(a[0]==='list')console.log(JSON.stringify(v.name?[{name:v.name,status:v.status}]:[]));
else if(a[0]==='pull')v.image=a[1];
else if(a[0]==='create'){if(v.image!==a[1])process.exit(27);v.name=a[a.indexOf('--name')+1];v.status='Running';}
else if(a[0]==='stop')v.status='Stopped';
else if(a[0]==='start')v.status='Running';
else if(a[0]==='ping'){if(v.status!=='Running')process.exit(29);}
else process.exit(30);
fs.writeFileSync(f,JSON.stringify(v));
`,
      { mode: 0o700 },
    );
    const native = new MicrosandboxPersonVm({
      binary,
      libkrunfw: join(root, 'fw'),
      agentd: join(root, 'agentd'),
      image: 'registry.example/node@sha256:' + 'a'.repeat(64),
      rootDiskGiB: 20,
      socketRoot,
    });
    const binding = {
      vmId: randomUUID(),
      personId: randomUUID(),
      organizationId: randomUUID(),
      instanceId: randomUUID(),
      leaseEpoch: 1,
    };
    await native.prepare(binding, join(root, 'mount'), signal());
    expect(await native.status(binding, signal())).toBe('absent');
    await native.create(
      binding,
      { binding, bindingId: randomUUID(), gatewayPorts: [38990, 38991] },
      signal(),
    );
    await native.ping(binding, signal());
    await native.stop(binding, signal());
    expect(await native.status(binding, signal())).toBe('stopped');
    await native.start(binding, signal());
    expect(await native.status(binding, signal())).toBe('running');
    const calls = (
      await readFile(join(root, 'mount/host-home/calls.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[]; envKeys: string[] });
    const create = calls.find((call) => call.args[0] === 'create')!;
    expect(calls.findIndex((call) => call.args[0] === 'pull')).toBeLessThan(
      calls.indexOf(create),
    );
    expect(create.args).toEqual(
      expect.arrayContaining([
        '--memory',
        '2048M',
        '--max-memory',
        '--max-cpus',
        '--pull',
        'never',
        '--net-default',
        'deny',
        ...outboundRules,
      ]),
    );
    expect(create.args).not.toContain('--idle-timeout');
    expect(create.args).not.toContain('--replace');
    expect(create.args).not.toContain('--mkdir');
    expect(
      create.args.slice(
        create.args.indexOf('--root-disk'),
        create.args.indexOf('--root-disk') + 2,
      ),
    ).toEqual(['--root-disk', 'flat:20G,clone=reflink']);
    expect(create.args[create.args.indexOf('--workdir') + 1]).toBe('/');
    for (const call of calls) {
      // CoreFoundation can inject this key into a macOS child with an explicit
      // env. Permit only that platform key; every other key remains exact.
      expect(
        call.envKeys.filter(
          (key) =>
            process.platform !== 'darwin' || key !== '__CF_USER_TEXT_ENCODING',
        ),
      ).toEqual(['HOME', 'LANG', 'MSB_CONFIG_PATH', 'MSB_HOME', 'PATH']);
      expect(call.envKeys).not.toContain(
        'ALLRICE_PERSON_VM_SYNTHETIC_HOST_SECRET',
      );
    }
    const config = JSON.parse(
      await readFile(join(root, 'mount/msb-config.json'), 'utf8'),
    );
    expect(config.allowed_backends).toEqual(['local']);
    expect(config.paths.sandboxes).toBe(
      join(root, 'mount/microsandbox/sandboxes'),
    );
  });
  it.each([undefined, 3072])(
    'writes the configured %s MiB cap to actual provider configuration and snapshots it',
    async (memoryMiB) => {
      const root = await directory();
      const calls: string[][] = [];
      const options = {
        binary: '/b',
        libkrunfw: '/fw',
        agentd: '/a',
        image: 'registry/node@sha256:' + 'a'.repeat(64),
        rootDiskGiB: 20,
        socketRoot: await socketDirectory(),
        memoryMiB,
        runner: async (command: Parameters<typeof runCommand>[0]) => {
          calls.push([...command.args]);
          return command.args[0] === 'list' ? '[]' : 'microsandbox 0.7.16';
        },
      };
      const expected =
        memoryMiB === undefined ? PERSON_VM_MEMORY_MIB : memoryMiB;
      const native = new MicrosandboxPersonVm(options);
      options.memoryMiB = 1;
      const binding = {
        vmId: randomUUID(),
        personId: randomUUID(),
        organizationId: randomUUID(),
        instanceId: randomUUID(),
        leaseEpoch: 1,
      };
      await native.prepare(binding, join(root, 'mount'), signal());
      const configuration = JSON.parse(
        await readFile(join(root, 'mount/msb-config.json'), 'utf8'),
      );
      expect(configuration.sandbox_defaults.memory_mib).toBe(expected);
      await native.create(binding, currentReceipt(binding), signal());
      const creation = calls.find((args) => args[0] === 'create')!;
      const expectedCli = memoryMiB === undefined ? '2048M' : '3072M';
      expect(creation[creation.indexOf('--memory') + 1]).toBe(expectedCli);
      expect(creation[creation.indexOf('--max-memory') + 1]).toBe(expectedCli);
    },
  );
  it.each([null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, '2048'])(
    'rejects invalid provider MiB cap %s before native work',
    async (memoryMiB) => {
      const runner = vi.fn();
      expect(() =>
        Reflect.construct(MicrosandboxPersonVm, [
          {
            binary: '/b',
            libkrunfw: '/fw',
            agentd: '/a',
            image: 'registry/node@sha256:' + 'a'.repeat(64),
            rootDiskGiB: 20,
            socketRoot: '/s',
            memoryMiB,
            runner,
          },
        ]),
      ).toThrowError('PROVIDER_FAILED');
      expect(runner).not.toHaveBeenCalled();
    },
  );
  it('不接可变镜像tag或不固定的运行版本', async () => {
    expect(
      () =>
        new MicrosandboxPersonVm({
          binary: '/b',
          libkrunfw: '/fw',
          agentd: '/a',
          image: 'node:latest',
          rootDiskGiB: 20,
          socketRoot: '/s',
        }),
    ).toThrowError('PROVIDER_FAILED');
    const root = await directory();
    const native = new MicrosandboxPersonVm({
      binary: '/b',
      libkrunfw: '/fw',
      agentd: '/a',
      image: 'registry/node@sha256:' + 'a'.repeat(64),
      rootDiskGiB: 20,
      socketRoot: await socketDirectory(),
      runner: async () => 'microsandbox 0.7.15',
    });
    await expect(
      native.prepare(
        {
          vmId: randomUUID(),
          personId: randomUUID(),
          organizationId: randomUUID(),
          instanceId: randomUUID(),
          leaseEpoch: 1,
        },
        join(root, 'm'),
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
  });
  it.each(['spawn', 'signal', 'oversize', 'nonzero'] as const)(
    '正常非零JSON opt-in仍保留 %s 失败，不把进程异常当guest completion',
    async (failure) => {
      const root = await directory();
      const script =
        failure === 'signal'
          ? 'console.log(JSON.stringify({code:0,success:true,timed_out:false}));process.kill(process.pid,"SIGKILL")'
          : failure === 'oversize'
            ? 'process.stdout.write(Buffer.alloc(4*1024*1024+1));setInterval(()=>{},1000)'
            : 'console.log(JSON.stringify({code:23,success:false,timed_out:false}));process.exit(23)';
      await expect(
        runCommand({
          executable:
            failure === 'spawn'
              ? join(root, 'absent-executable')
              : process.execPath,
          args: ['-e', script],
          env: { HOME: root, PATH: '/usr/bin:/bin' },
          signal: signal(),
          readNonzeroExit: failure !== 'nonzero',
        }),
      ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    },
  );
  it('构造时按完整UUID预算检查103/104字节和UTF8；prepare仍核实际binding及别名target', async () => {
    const root = await mkdtemp('/tmp/aa-'); // 14 bytes: control endpoint is 103.
    temporary.push(root);
    const runner = vi.fn(async () => 'microsandbox 0.7.16');
    const options = {
      binary: '/b',
      libkrunfw: '/fw',
      agentd: '/a',
      image: 'registry/node@sha256:' + 'a'.repeat(64),
      rootDiskGiB: 20,
      socketRoot: root,
      runner,
    };
    const make = (socketRoot: string) =>
      new MicrosandboxPersonVm({ ...options, socketRoot });
    const binding = {
      vmId: randomUUID(),
      personId: randomUUID(),
      organizationId: randomUUID(),
      instanceId: randomUUID(),
      leaseEpoch: 1,
    };
    const native = new MicrosandboxPersonVm(options),
      mount = join(root, 'mount'),
      alias = join(root, binding.vmId);
    options.socketRoot = root + 'x'; // Cannot invalidate the qualified snapshot.
    expect(
      Buffer.byteLength(
        join(alias, 'run/sandboxes', '0'.repeat(24), 'control.sock'),
      ),
    ).toBe(103);
    await native.prepare(binding, mount, signal());
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect(await readlink(alias)).toBe(join(mount, 'microsandbox'));
    const config = JSON.parse(
      await readFile(join(mount, 'msb-config.json'), 'utf8'),
    );
    expect(config.home).toBe(alias);
    for (const rejectedRoot of [root + 'x', root.slice(0, -1) + 'é']) {
      expect(
        Buffer.byteLength(
          join(
            rejectedRoot,
            binding.vmId,
            'run/sandboxes',
            '0'.repeat(24),
            'control.sock',
          ),
        ),
      ).toBe(104);
      expect(() => make(rejectedRoot)).toThrowError('PROVIDER_FAILED');
    }
    const untouched = join(root, 'not-created-invalid-binding');
    await expect(
      native.prepare(
        { ...binding, vmId: binding.vmId + 'x' },
        untouched,
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    await expect(lstat(untouched)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      native.prepare(binding, join(root, 'different'), signal()),
    ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    expect(await readlink(alias)).toBe(join(mount, 'microsandbox'));
    expect(runner).toHaveBeenCalledTimes(1);

    const nextSocketRoot = await socketDirectory();
    await make(nextSocketRoot).prepare(binding, mount, signal());
    const nextConfig = JSON.parse(
      await readFile(join(mount, 'msb-config.json'), 'utf8'),
    );
    expect(config.paths.sandboxes).toBe(join(mount, 'microsandbox/sandboxes'));
    expect(nextConfig.paths.sandboxes).toBe(config.paths.sandboxes);
    expect(nextConfig.home).toBe(join(nextSocketRoot, binding.vmId));
    expect(nextConfig.home).not.toBe(config.home);
    expect(await readlink(nextConfig.home)).toBe(join(mount, 'microsandbox'));
    const differentMount = join(root, 'different-mounted-disk');
    await make(await socketDirectory()).prepare(
      binding,
      differentMount,
      signal(),
    );
    const differentConfig = JSON.parse(
      await readFile(join(differentMount, 'msb-config.json'), 'utf8'),
    );
    expect(differentConfig.paths.sandboxes).toBe(
      join(differentMount, 'microsandbox/sandboxes'),
    );
    expect(differentConfig.paths.sandboxes).not.toBe(config.paths.sandboxes);
    expect(runner).toHaveBeenCalledTimes(3);
  });
  it('取消真实子进程等待退出，不把仍跑的promise丢给回收器', async () => {
    const root = await directory(),
      controller = new AbortController();
    const pidFile = join(root, 'pid');
    const command = runCommand({
      executable: process.execPath,
      args: [
        '-e',
        'require("fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)',
        pidFile,
      ],
      env: { HOME: root, PATH: '/usr/bin:/bin' },
      signal: controller.signal,
    });
    let pid: number | undefined;
    for (let attempt = 0; attempt < 200 && !pid; attempt += 1) {
      try {
        pid = Number(await readFile(pidFile, 'utf8'));
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    controller.abort();
    expect(pid).toBeGreaterThan(0);
    await expect(command).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    expect(() => process.kill(pid!, 0)).toThrow();
  });
});

it('keeps the mounted disk on retained VMs and rolls back an absent VM to directory provisioning', async () => {
  const dsh = await readonlyFixture();
  const signed = (input: string) =>
    createHash('sha256').update(input).digest('hex');
  const diskBytes = 'synthetic sealed raw ext4 disk';
  const diskSha256 = signed(diskBytes);
  const root = await directory();
  const generation = join(root, diskSha256);
  const diskPath = join(generation, 'runtime.ext4');
  const candidatePath = join(generation, 'candidate.json');
  const cliSha256 = signed('synthetic CLI');
  const bwrapSha256 = signed('synthetic bwrap');
  const abi = {
    interpreter: '/lib/ld-linux-aarch64.so.1',
    needed: ['libc.so.6'],
  };
  const receipt = JSON.stringify({
    schemaVersion: 1,
    platform: 'linux/arm64',
    source: {
      baseImage: readonlyImage,
      dshVersion: '0.2.1-rc.2',
      nodeVersion: '22.23.2',
      artifactSha256: dsh.artifactSha256,
      manifestSha256: dsh.manifestSha256,
      treeSha256: dsh.treeSha256,
      descriptorSha256: dsh.sealedManifestSha256,
      bubblewrapVersion: '0.8.0-2+deb12u1',
      bubblewrapDebSha256:
        'd044ba1d7961d835669035fcd1e11121f1dc960a1a2e1c6489a93ea44e083557',
      bubblewrapElfSha256: bwrapSha256,
      cli: 'node_modules/@deepseek-ai/dsh/lib/bin.js',
      lock: 'package-lock.json',
    },
    cliSha256,
    lockSha256: signed('package-lock.json'),
    guestDirectory: dsh.guestDirectory,
    abi: { 'sandbox-bin/bwrap': abi, 'usr/local/bin/node': abi },
    disk: {
      sha256: diskSha256,
      format: 'raw/ext4',
      bytes: Buffer.byteLength(diskBytes),
      e2fsprogs: '1.47.4',
    },
  });
  await mkdir(generation, { mode: 0o700 });
  await writeFile(diskPath, diskBytes, { mode: 0o444 });
  await writeFile(candidatePath, receipt, { mode: 0o444 });
  const disk = {
    diskPath,
    diskSha256,
    candidatePath,
    candidateSha256: signed(receipt),
    provision: 'disk' as const,
  };
  const files = new Map(
    COMMAND_MEMORY_CONTROL_FILES.map((name) => [name, Buffer.from(name)]),
  );
  const controlsSha = hashCommandMemoryControlFiles(files);
  const controls = {
    hostDirectory: join(root, controlsSha),
    guestDirectory: '/opt/allrice/command-memory/' + controlsSha,
    sha256: controlsSha,
  };
  await mkdir(controls.hostDirectory, { mode: 0o700 });
  for (const [name, bytes] of files)
    await writeFile(join(controls.hostDirectory, name), bytes, {
      mode: name === 'launch-dsh.sh' ? 0o555 : 0o444,
    });
  const f = await bootstrapFixture('ok', dsh, undefined, {
    readonlyDshRuntimeDisk: disk,
    readonlyCommandMemoryDirectory: controls,
  });
  const cli = dsh.guestDirectory + '/node_modules/@deepseek-ai/dsh/lib/bin.js';
  const commandConfig = '/run/allrice-command-memory/config.json';
  f.h.runtime.memoryGuestPlan = async () => ({
    files: [{ path: commandConfig, contents: '{}', mode: 0o600 }],
    initialize: {
      executable: 'node',
      args: [controls.guestDirectory + '/initialize.cjs', commandConfig],
    },
    launcher: controls.guestDirectory + '/launch-dsh.sh',
    env: {
      BASH_ENV: controls.guestDirectory + '/bash-env.sh',
      ALLRICE_MEMORY_RECEIPT_WRITER:
        controls.guestDirectory + '/command-observer.cjs',
      ALLRICE_MEMORY_RECEIPT_DIRECTORY: '/run/allrice-command-memory/receipts',
      ALLRICE_MEMORY_RECEIPT_NODE: '/usr/local/bin/node',
    },
  });
  f.h.runtime.start = async (_binding, _signal, scope) => {
    const job = await scope.launch({
      executable: 'node',
      args: [cli],
      env: { PATH: '/work/caller-path' },
    });
    expect(await job.wait(signal())).toEqual({ exitCode: 0, timedOut: false });
  };
  await f.service.prewarm(f.rc, { trigger: 'page' }, signal());
  const calls = await f.calls();
  const create = calls.find(([op]) => op === 'create');
  expect(create).toEqual(
    expect.arrayContaining([
      '--mount-disk',
      diskPath + ':' + dsh.guestDirectory + ':format=raw,fstype=ext4,ro',
      '--mount-dir',
      controls.hostDirectory + ':' + controls.guestDirectory + ':ro',
    ]),
  );
  expect(create?.filter((v) => v === '--mount-dir')).toHaveLength(1);
  expect(calls.some((args) => args.includes(prepareDshSandbox))).toBe(false);
  expect(calls.some((args) => args.includes(verifyDshRuntimeDisk))).toBe(true);
  const dshLaunch = calls.find((args) => args.at(-1) === cli);
  expect(dshLaunch?.slice(-7)).toEqual([
    '/bin/sh',
    '-c',
    launchDshSandbox,
    'allrice-dsh',
    dsh.guestDirectory +
      '/sandbox-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    '/usr/local/bin/node',
    cli,
  ]);
  expect(dshLaunch).toContain(controls.guestDirectory + '/launch-dsh.sh');

  const reference = JSON.parse(
    await readFile(
      join(f.mount, 'microsandbox/allrice-readonly-dsh.json'),
      'utf8',
    ),
  );
  const binding = {
    vmId: reference.vmId,
    personId: reference.personId,
    organizationId: randomUUID(),
    instanceId: randomUUID(),
    leaseEpoch: 2,
  };
  expect(reference).toMatchObject({
    runtimeDiskSha256: diskSha256,
    commandMemorySha256: controlsSha,
  });
  await f.native.stop(binding, signal());
  const retained = f.reloadNative({ ...disk, provision: 'directory' });
  await retained.prepare(binding, f.mount, signal());
  await retained.start(binding, signal());
  await retained.stop(binding, signal());
  expect((await f.calls()).filter(([op]) => op === 'create')).toHaveLength(1);

  const absent = await bootstrapFixture('pull-fails-once', dsh, undefined, {
    readonlyDshRuntimeDisk: disk,
    readonlyCommandMemoryDirectory: controls,
  });
  const fresh = { ...binding, vmId: randomUUID() };
  await absent.native.prepare(fresh, absent.mount, signal());
  await expect(
    absent.native.create(fresh, currentReceipt(fresh), signal()),
  ).rejects.toThrow();
  expect(await absent.native.status(fresh, signal())).toBe('absent');
  const referenceFile = join(
    absent.mount,
    'microsandbox/allrice-readonly-dsh.json',
  );
  expect(JSON.parse(await readFile(referenceFile, 'utf8'))).toMatchObject({
    runtimeDiskSha256: diskSha256,
  });
  const fallback = absent.reloadNative({ ...disk, provision: 'directory' });
  await fallback.prepare(fresh, absent.mount, signal());
  await fallback.create(fresh, currentReceipt(fresh), signal());
  const createDirectory = (await absent.calls()).find(
    ([op]) => op === 'create',
  )!;
  expect(createDirectory).not.toContain('--mount-disk');
  expect(createDirectory).toEqual(
    expect.arrayContaining([
      '--mount-dir',
      dsh.hostDirectory + ':' + dsh.guestDirectory + ':ro',
      '--mount-dir',
      controls.hostDirectory + ':' + controls.guestDirectory + ':ro',
    ]),
  );
  expect(JSON.parse(await readFile(referenceFile, 'utf8'))).not.toHaveProperty(
    'runtimeDiskSha256',
  );
  await fallback.stop(fresh, signal());
});
