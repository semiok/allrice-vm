import { execFileSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export async function resolveServiceBuildRoot(directory, home = homedir()) {
  const root = await realpath(resolve(directory));
  const directRelease = ['allrice40-dev-releases', 'allrice40-worktrees'].some(
    (parent) => dirname(root) === join(home, parent),
  );
  const taskRoot = dirname(root);
  // Keep the same task-name grammar as scripts/m1/qa-instance.
  const qaRelease =
    basename(root) === 'release' &&
    dirname(taskRoot) === join(home, 'allrice-qa') &&
    /^[a-z0-9][a-z0-9-]{0,30}$/.test(basename(taskRoot));
  if (!directRelease && !qaRelease) throw Error('DEV_BUILD_ROOT_NOT_ALLOWED');
  return root;
}

export async function resolveServiceBuildSource(
  directory,
  sourceSha,
  home = homedir(),
) {
  const root = await resolveServiceBuildRoot(directory, home);
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const canonical = join(await realpath(home), 'allrice40-repo/.git');
  const origins = new Set([
    'https://github.com/semiok/allrice-vm',
    'https://github.com/semiok/allrice-vm.git',
    'git@github.com:semiok/allrice-vm.git',
  ]);
  try {
    if (
      (await realpath(canonical)) !== canonical ||
      (await realpath(
        git('rev-parse', '--path-format=absolute', '--git-common-dir'),
      )) !== canonical ||
      git('rev-parse', '--show-toplevel') !== root ||
      !origins.has(git('remote', 'get-url', 'origin'))
    )
      throw Error('repository');
  } catch {
    throw Error('DEV_BUILD_REPOSITORY_NOT_ALLOWED');
  }
  if (
    git('rev-parse', 'HEAD') !== sourceSha ||
    git('status', '--porcelain=v1', '--untracked-files=normal')
  )
    throw Error('DEV_BUILD_SOURCE_NOT_CLEAN');
  return { root, sourceSha, sourceTree: git('rev-parse', 'HEAD^{tree}') };
}
