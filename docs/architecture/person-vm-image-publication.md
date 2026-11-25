# Person VM offline runtime image candidate

This tooling builds an OCI layout and a separate raw ext4 runtime disk from the
same fixed Linux arm64 DSH distribution. It is the first part of the cold-start
work in MET-260. It does not register an image, start a sandbox, install tools,
or configure the Worker. DSH's CLI, dependency lock and bubblewrap are reused
byte-for-byte. **MET-225:** this build introduces no DSH behavior or configuration
change. Native mount and startup validation belong to the later runtime PR.

## Prepare local inputs

Use an isolated operator-owned directory. Obtain the official Node OCI manifest
`af0bb4bf5b7318e3269417a7684a9e116c3c22eaf05382578b0d0d33de597ad2`
and its config and layer blobs. Put their original bytes under
`base/blobs/sha256/<hex>`. Retain the bytes of the pinned manifest itself.
Tag resolution and transcoding are outside the offline build. This manifest
is Linux arm64 with Node 22.23.2. Acquisition may use the registry; both tools
below consume only local inputs.

Stage the three files from the formal MET-267 `24b04334…` release separately
from any runtime directory. Use the already verified `descriptor.json`,
`manifest.json` and `artifact.tar`. The receipt preserves the association with
the unchanged DSH 0.2.1-rc.2 tar/manifest and the Debian Bookworm arm64
bubblewrap 0.8.0-2+deb12u1 package and ELF. The signed Debian index and
license provenance remain the formal publisher's records. This build verifies
those sealed input bytes against fixed pins and carries the bundled copyright
and license files. It accepts no npm installs, credential inputs, profiles,
user homes, or mutable service directories.

Required tools on the isolated builder's PATH are Node 22.23.2, Python 3.9+,
LLVM objdump, and e2fsprogs 1.47.4 with libarchive tar population and debugfs.
Record the Git commit and tool versions for byte comparisons. Plan for roughly 8 GiB of temporary disk
space for a build or verification, plus space for the inputs and final output.
The included Dockerfile describes the same root-owned copy, for OCI tooling
with a pre-staged base and the normalized payload. The offline CLI constructs
the OCI layout directly without Docker, a daemon, a registry, or an arm64
execution environment.

## Build and independently read back

Run each build with a fresh output path. The parent directory must exist.

```sh
node scripts/person-vm-image/build.mjs /isolated/base /isolated/sealed /isolated/candidate-one
node scripts/person-vm-image/build.mjs /isolated/base /isolated/sealed /isolated/candidate-two
cmp /isolated/candidate-one/candidate.json /isolated/candidate-two/candidate.json
node scripts/person-vm-image/verify.mjs /isolated/base /isolated/sealed /isolated/candidate-one
node scripts/person-vm-image/verify.mjs /isolated/base /isolated/sealed /isolated/candidate-two
```

- `oci/` contains the OCI image layout and content-addressed blobs. The final
  manifest digest identifies the image. The added layer installs the sealed
  runtime under `/opt/allrice/dsh/<sealed-artifact-sha256>/`.
- `runtime.ext4` contains the same payload at the filesystem root. The receipt
  records the independent SHA-256 of the complete disk bytes. Its host mode
  is 0444. The consuming runtime must use a read-only mount and prove in-guest
  execution and write rejection before switching from the existing delivery.
- `candidate.json` binds source pins, CLI and lock hashes, normalized payload,
  checked ELF dependency closure, OCI manifest and layer and raw disk.
  The verifier recomputes those expectations from the pinned inputs in private
  scratch space, checks the filesystem without mounting it, then reads and
  verifies both outputs. The disk readback checks the actual inode inventory,
  owners, modes, link targets, file contents and absence of bwrap attributes.
  A receipt by itself is never its trust anchor.

The payload has fixed root ownership and normalized permissions and timestamps.
Only declared, exact file bytes and internal links are carried forward. The
builder rejects undeclared content, traversal, special files, privilege bits
and archive capabilities. It never extracts the source archive into a host
runtime directory. A failed output without a valid receipt is incomplete.
Keep existing published artifacts and their references for rollback, and place
any later publication behind the existing owner's review and release process.

See the [OCI image manifest specification](https://github.com/opencontainers/image-spec/blob/v1.1.1/manifest.md)
for the image layout descriptor and digest semantics.
