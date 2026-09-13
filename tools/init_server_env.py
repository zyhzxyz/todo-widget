"""Create secrets in an exclusive 0600 file. Never print tokens or overwrite a file."""
import argparse
import os
import secrets
from pathlib import Path

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=root / 'deploy' / '.env')
args = parser.parse_args()
content = (root / 'deploy' / '.env.example').read_text()
content = content.replace('TODO_APP_TOKEN=\n', 'TODO_APP_TOKEN=' + secrets.token_urlsafe(32) + '\n')
content = content.replace('TODO_BOT_TOKEN=\n', 'TODO_BOT_TOKEN=' + secrets.token_urlsafe(32) + '\n')
fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as out:
    out.write(content)
    out.flush()
    os.fsync(out.fileno())
print(f'Created private configuration: {args.output}; tokens were not printed. Keep it out of Git.')
