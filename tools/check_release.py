"""Check the exact public source inventory for common accidental private files."""
import hashlib,json,pathlib,re,sys

ROOT=pathlib.Path(__file__).resolve().parents[1]
ALLOWED_ROOT={'.gitignore','README.md','LICENSE','NOTICE','SECURITY.md','CONTRIBUTING.md',
              'web-config.example.json','source-manifest.json','release-manifest.json'}
PATTERNS=[
    ('private IPv4',re.compile(r'\b(?:192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)\b')),
    ('GitHub credential',re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b')),
    ('cloud credential',re.compile(r'\bAKIA[A-Z0-9]{16}\b')),
    ('private key',re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')),
    ('credential URL',re.compile(r'https?://[^\s/\"\']+:[^\s/@\"\']+@')),
    ('literal long credential',re.compile(r'''(?i)["']?(?:api[_-]?key|password|access[_-]?token|secret)["']?\s*[:=]\s*["'][A-Za-z0-9_/-]{24,}["']''')),
]


def public_files(root=ROOT):
    for path in sorted(root.rglob('*')):
        relative=path.relative_to(root)
        if any(part in {'.git','__pycache__','build'} for part in relative.parts):continue
        if path.is_symlink():raise ValueError('Symlinks are not part of the release')
        if path.is_file():yield path


def findings(relative,text):
    result=[label for label,pattern in PATTERNS if pattern.search(text)]
    parts=pathlib.PurePosixPath(relative).parts
    if not parts or (len(parts)==1 and relative not in ALLOWED_ROOT):result.append('unexpected root file')
    if len(parts)>1 and parts[0] not in {'source','tools','docs','.github'}:result.append('unexpected directory')
    if pathlib.PurePosixPath(relative).suffix.lower() not in {'.md','.py','.js','.cjs','.css','.html','.json','.yml','.yaml',''} and relative!='.gitignore':result.append('unexpected file type')
    if pathlib.PurePosixPath(relative).name in {'settings.json','credentials.json','.env'}:result.append('runtime settings')
    return result


def inventory(root=ROOT):
    return [{'path':p.relative_to(root).as_posix(),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
            for p in public_files(root) if p.name!='release-manifest.json']


def main():
    errors=[];files=list(public_files())
    for path in files:
        name=path.relative_to(ROOT).as_posix()
        try:text=path.read_text(encoding='utf-8')
        except UnicodeError:errors.append({'path':name,'issues':['non-text file']});continue
        issues=findings(name,text)
        if issues:errors.append({'path':name,'issues':issues})
    manifest=json.loads((ROOT/'release-manifest.json').read_text())
    if manifest['files']!=inventory():errors.append({'path':'release-manifest.json','issues':['inventory or checksum mismatch']})
    print(json.dumps({'filesChecked':len(files),'findings':errors}))
    return bool(errors)


if __name__=='__main__':raise SystemExit(main())
