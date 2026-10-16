"""Version local static references from one deterministic asset-tree digest."""
import hashlib
from html import escape, unescape
import os
from pathlib import Path
import re
import stat
import tempfile
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit, urlunsplit


REFERENCE = re.compile(r'''(\b(?:src|href)\s*=\s*)(["'])(/static/[^"']+)\2''', re.I)
TEXT_TYPES = {'.html', '.css', '.js', '.mjs', '.svg', '.json', '.md', '.txt'}


def bump(base):
    static = (Path(base) / 'app/static').resolve()
    index = static / 'index.html'
    source = index.read_text(encoding='utf-8')
    digest = hashlib.sha256()
    assets = sorted((p for p in static.rglob('*') if p.is_file() and p != index),
                    key=lambda p: p.relative_to(static).as_posix())
    for path in assets:
        content = path.read_bytes()
        if path.suffix.lower() in TEXT_TYPES:
            content = content.replace(b'\r\n', b'\n')
        digest.update(path.relative_to(static).as_posix().encode() + b'\0')
        digest.update(content + b'\0')
    revision = digest.hexdigest()[:12]

    def replace(match):
        url = urlsplit(unescape(match[3]))
        target = (static / unquote(url.path[len('/static/'):])).resolve()
        if not target.is_relative_to(static) or not target.is_file():
            raise ValueError(f'静态资源不存在或路径越界：{url.path}')
        query = [(key, value) for key, value in parse_qsl(url.query, keep_blank_values=True) if key != 'v']
        query.append(('v', revision))
        updated = urlunsplit(('', '', url.path, urlencode(query), url.fragment))
        return match[1] + match[2] + escape(updated, quote=True) + match[2]

    updated, count = REFERENCE.subn(replace, source)
    if not count:
        raise ValueError('入口未引用任何本地静态资源')
    if updated != source:
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', newline='\n',
                                             dir=static, prefix='.index-', suffix='.tmp', delete=False) as output:
                temporary = Path(output.name)
                output.write(updated)
            os.chmod(temporary, stat.S_IMODE(index.stat().st_mode))
            temporary.replace(index)
        finally:
            if temporary is not None and temporary.exists():
                temporary.unlink()
    return revision


if __name__ == '__main__':
    print('静态资源版本号 -> ?v=' + bump(Path(__file__).resolve().parents[1]))
