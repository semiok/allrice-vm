import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { relative, resolve } from 'node:path';
import process from 'node:process';
import {
  WorkspaceAnalyzer,
  FaceModelEmitter,
  writePackageArtifacts,
} from '@deepseek-ai/dsh-typert-generator';

// No authored descriptor/codec or live Host: the official analyzer validates
// the source program and the official emitter/writer creates both artifacts.
const here = import.meta.dirname;
const root = resolve(here, '../..');
const require = createRequire(import.meta.url);
execFileSync(
  process.execPath,
  [
    require.resolve('typescript/bin/tsc'),
    '-p',
    resolve(here, 'tsconfig.build.json'),
  ],
  { stdio: 'inherit' },
);
const workspace = new WorkspaceAnalyzer({
  root,
  hostConfig: relative(root, resolve(here, 'tsconfig.host.json')),
  faces: ['host'],
  packages: ['@allrice/dsh-native-history-source'],
  rejectBuildOutputs: true,
}).analyze();
const face = workspace.faces.find((face) => face.face === 'host');
if (!face) throw new Error('HISTORY_SOURCE_HOST_FACE_MISSING');
const artifact = new FaceModelEmitter(face).emit(
  '@allrice/dsh-native-history-source',
);
if (!artifact.remote) throw new Error('HISTORY_SOURCE_REMOTE_MISSING');
writePackageArtifacts(here, [
  { ...artifact, packageRoot: relative(root, here) },
]);
