"""Parse the terminal receipt produced by m5-run, not m5-test's dispatch log."""
import re
import sys
from pathlib import Path

REPOSITORY = 'semiok/allrice-vm'
REPOSITORY_ID = 1469490636
SHA = r'[a-f0-9]{40}'
HEADER = re.compile(rf'm5-test: repository {REPOSITORY} id {REPOSITORY_ID} commit ({SHA})')


def tail_lines(path):
    with open(path, 'rb') as stream:
        stream.seek(max(0, path.stat().st_size - 4096))
        return stream.read().decode('utf-8', errors='replace').splitlines()


def result_exit(lines, host, run, sha):
    prefix = f'm5-test: result repository {REPOSITORY} id {REPOSITORY_ID} commit {sha} host {host} run {run} exit '
    closing = rf'm5-test: done on {host} \({sha[:8]}, .*\), exit '
    for i in range(len(lines) - 1, -1, -1):
        line = lines[i]
        if not line.startswith('m5-test: result repository '):
            continue
        if not line.startswith(prefix) or i + 1 == len(lines):
            return None
        code = line[len(prefix):]
        if re.fullmatch(r'0|[1-9][0-9]{0,2}', code) and int(code) <= 255 and re.fullmatch(closing + code, lines[i + 1]):
            return int(code)
        return None
    return None


if __name__ == '__main__':
    try:
        code = result_exit(tail_lines(Path(sys.argv[1])), *sys.argv[2:])
    except OSError:
        code = None
    if code is None:
        sys.exit(1)
    print(code)
