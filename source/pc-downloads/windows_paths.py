"""Keep path validation consistent while permitting long Windows file names."""
import os
import pathlib


def io_path(path):
    value = os.path.abspath(path)
    if os.name != 'nt' or value.startswith('\\\\?\\') or len(value) < 248:
        return pathlib.Path(value)
    if value.startswith('\\\\'):
        return pathlib.Path('\\\\?\\UNC\\' + value[2:])
    return pathlib.Path('\\\\?\\' + value)


def resolved_path(path):
    value = str(io_path(path).resolve())
    if os.name == 'nt':
        if value.startswith('\\\\?\\UNC\\'):
            value = '\\\\' + value[8:]
        elif value.startswith('\\\\?\\'):
            value = value[4:]
    return pathlib.Path(value)
