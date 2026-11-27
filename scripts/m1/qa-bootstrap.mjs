#!/usr/bin/env node
// Set up a company and member on an isolated QA instance. The platform admin
// releases only that person into 4.0; the member creates their own employee.
// The password and stable creation request ID are stored in --creds (0600).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (acc, v, i, a) =>
        v.startsWith('--')
          ? [...acc, [v.slice(2), a[i + 1]?.startsWith('--') ? '' : a[i + 1]]]
          : acc,
      [],
    ),
);
const home = os.homedir();
const port = Number(args.port);
const company = args.company;
const username = args.username;
const credsPath = args.creds;
const envPath = args.env ?? `${home}/allrice40-dev/.env`;
if (!port || !company || !username || !credsPath) {
  console.error(
    'usage: qa-bootstrap.mjs --port <webPort> --company <name> --username <user> --creds <file>',
  );
  process.exit(2);
}
const ADMIN_HOST = 'allrice-admin.bplabs.xyz';
const env = Object.fromEntries(
  fs
    .readFileSync(envPath, 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1).replace(/^['"]|['"]$/g, '')];
    }),
);
const admin = { host: ADMIN_HOST, cookie: '' };
const member = { host: 'allrice.bplabs.xyz', cookie: '' };

function request(session, method, path, body, scope) {
  return new Promise((resolve, reject) => {
    const data =
      body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          host: session.host,
          origin: `https://${session.host}`,
          ...(scope && {
            'x-allrice-organization-id': scope.organizationId,
            'x-allrice-workspace-id': scope.workspaceId,
          }),
          'sec-fetch-site': 'same-origin',
          accept: 'application/json',
          ...(session.cookie ? { cookie: session.cookie } : {}),
          ...(data
            ? {
                'content-type': 'application/json',
                'content-length': data.length,
              }
            : {}),
        },
        timeout: 120_000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const set = res.headers['set-cookie'];
          if (set) {
            const jar = new Map(
              session.cookie
                ? session.cookie
                    .split('; ')
                    .map((c) => c.split(/=(.*)/s).slice(0, 2))
                : [],
            );
            for (const c of set) {
              const [kv] = c.split(';');
              const [k, v] = kv.split(/=(.*)/s);
              jar.set(k, v);
            }
            session.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
          }
          const text = Buffer.concat(chunks).toString();
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on('timeout', () =>
      req.destroy(new Error(`timeout ${method} ${path}`)),
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
async function call(session, method, path, body, ok = [200, 201], scope) {
  const response = await request(session, method, path, body, scope);
  if (!ok.includes(response.status))
    throw new Error(`${method} ${path} -> ${response.status}`);
  return response.json;
}
const step = (s) => console.log(`[bootstrap] ${s}`);

// 1. Platform admin login (env credentials on the admin portal host).
await call(admin, 'POST', '/api/v1/auth/login', {
  username: env.ALLRICE_PLATFORM_ADMIN_USER,
  password: env.ALLRICE_PLATFORM_ADMIN_PASSWORD,
});
step('admin logged in');

// 2. Company (reuse by name).
const orgs = await call(admin, 'GET', '/api/v1/admin/organizations');
let org = (orgs.organizations ?? orgs.items ?? []).find(
  (o) => o.name === company,
);
if (!org) {
  const created = await call(admin, 'POST', '/api/v1/admin/organizations', {
    name: company,
    businessContext: `${company}：AllRice 验收与冒烟测试用公司，不放真实业务数据。`,
  });
  org = { id: created.organizationId };
  step(`company created: ${company}`);
} else step(`company exists: ${company}`);
const orgDetail = await call(
  admin,
  'GET',
  `/api/v1/admin/organizations/${org.id}`,
);
const workspaceId = orgDetail.organization?.defaultWorkspaceId;
if (orgDetail.organization?.id !== org.id || !workspaceId)
  throw new Error('could not resolve QA default workspace');

// 3. Member account: create (reusing the password in --creds when present), or reset
// the password when our creds file is missing.
let creds = fs.existsSync(credsPath)
  ? JSON.parse(fs.readFileSync(credsPath, 'utf8'))
  : null;
const people = await call(
  admin,
  'GET',
  `/api/v1/admin/organizations/${org.id}/people`,
);
const person = (people.people ?? people.items ?? []).find(
  (p) => p.username === username,
);
if (!person) {
  // A fresh database with an existing creds file (e.g. after a Dev rebuild): keep the
  // password people already have instead of issuing a new one.
  if (!creds || creds.username !== username) {
    creds = {
      username,
      password: 'Qa-' + crypto.randomBytes(12).toString('base64url'),
    };
  }
  await call(admin, 'POST', `/api/v1/admin/organizations/${org.id}/people`, {
    people: [
      {
        username,
        displayName: `${company} 体验号`,
        jobTitle: '验收测试',
        responsibilities: '冒烟与验收测试账号',
        departmentId: null,
        password: creds.password,
      },
    ],
  });
  step(`account created: ${username}`);
} else if (!creds || creds.username !== username) {
  creds = {
    username,
    password: 'Qa-' + crypto.randomBytes(12).toString('base64url'),
  };
  await call(
    admin,
    'POST',
    `/api/v1/admin/organizations/${org.id}/people/${person.userId}/password`,
    { password: creds.password },
    [200, 204],
  );
  step(`account exists, password reset: ${username}`);
} else step(`account exists: ${username}`);
const memberDirectory = await call(
  admin,
  'GET',
  `/api/v1/admin/organizations/${org.id}/people`,
);
const matching = (memberDirectory.people ?? []).filter(
  (item) => item.username === username,
);
const personId = matching[0]?.userId;
if (matching.length !== 1 || !personId)
  throw new Error('could not resolve unique QA member');

const scope = { organizationId: org.id, workspaceId };
const policyPath = '/api/v1/admin/d-entry-release-policy';
const policy = await call(admin, 'GET', policyPath);
if (
  !policy.selections.some(
    (row) => row.organizationId === org.id && row.personId === personId,
  )
) {
  await call(admin, 'PUT', policyPath, {
    ...policy,
    selections: [...policy.selections, { organizationId: org.id, personId }],
  });
}

const previousRequest =
  creds.organizationId === org.id &&
  creds.workspaceId === workspaceId &&
  creds.personId === personId
    ? creds.employeeCreationRequestId
    : undefined;
const requestId = previousRequest ?? crypto.randomUUID();
const saved = {
  username: creds.username,
  password: creds.password,
  company,
  port,
  ...scope,
  personId,
  employeeCreationRequestId: requestId,
};
function writeCredentials(value) {
  const temporary = `${credsPath}.${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), {
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(temporary, credsPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
writeCredentials(saved);

const login = await call(member, 'POST', '/api/v1/auth/login', {
  username: creds.username,
  password: creds.password,
});
if (login.user?.id !== personId) throw new Error('QA member login mismatch');
const instancesPath = '/api/v1/employee-instances';
const before = await call(
  member,
  'GET',
  `${instancesPath}?workspaceId=${workspaceId}`,
  undefined,
  [200],
  scope,
);
if (
  !Array.isArray(before.instances) ||
  (!previousRequest && before.instances.length)
)
  throw new Error('new QA member does not have an empty employee roster');
const input = {
  workspaceId,
  expectedOwnerId: personId,
  requestId,
  profile: { name: '验收员工' },
};
const { instance } = await call(
  member,
  'POST',
  instancesPath,
  input,
  [201],
  scope,
);
if (
  !instance?.id ||
  instance.kind !== 'custom' ||
  instance.ownerId !== personId ||
  instance.organizationId !== org.id ||
  instance.workspaceId !== workspaceId
)
  throw new Error('created QA employee does not match the member scope');
const after = await call(
  member,
  'GET',
  `${instancesPath}?workspaceId=${workspaceId}`,
  undefined,
  [200],
  scope,
);
if (after.instances.length !== 1 || after.instances[0]?.id !== instance.id)
  throw new Error('QA employee roster did not match the creation receipt');
writeCredentials({ ...saved, employeeInstanceId: instance.id });

console.log(
  JSON.stringify({
    ok: true,
    company,
    ...scope,
    personId,
    employeeInstanceId: instance.id,
    username,
    credsPath,
  }),
);
