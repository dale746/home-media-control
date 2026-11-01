"""Live transfer totals; completed migration batches are historical data."""


def matching_copy_bytes(status, telemetry):
    identifier=str(status.get('hash') or '').lower()
    filename=str(status.get('file') or '').replace('\\', '/')
    if (identifier and filename
            and identifier==str(telemetry.get('copyHash') or '').lower()
            and filename==str(telemetry.get('copyFile') or '').replace('\\', '/')):
        return telemetry.get('copyBytes')
    return None


def transfer_totals(jobs, copied, status, current_files, current_bytes, active):
    jobs = {item['hash'].lower(): item for item in jobs
            if item.get('category') in ('movies', 'tv')}
    verified = {key.lower() for key in copied}
    waiting = [item for key, item in jobs.items()
               if item.get('progress', 0) >= 1 and key not in verified]
    remaining = sum(max(0, item.get('size') or 0) for item in waiting)
    current_hash = str(status.get('hash') or '').lower()
    current_file = str(status.get('file') or '').replace('\\', '/')
    copied_in_job = 0
    if active and current_hash in {item['hash'].lower() for item in waiting}:
        for item in current_files or []:
            if item.get('priority', 1) == 0:
                continue
            if item.get('name', '').replace('\\', '/') == current_file:
                copied_in_job += min(max(0, current_bytes or 0), max(0, item.get('size') or 0))
                break
            copied_in_job += max(0, item.get('size') or 0)
        else:
            copied_in_job = 0
    remaining = max(0, remaining - copied_in_job)
    completed = len(verified)
    in_flight=bool(active and current_hash in {item['hash'].lower() for item in waiting})
    return {'completedTransfers': completed, 'waitingTransfers': len(waiting)-int(in_flight), 'readyTransfers':len(waiting),
            'remainingBytes': remaining,
            'incompleteDownloads': sum(item.get('progress', 0) < 1 for item in jobs.values()),
            # Compatibility for older status consumers, now backed by live data.
            'batchCopied': completed, 'batchTotal': completed + len(waiting),
            'phase': 'copying' if active else ('waiting' if waiting else 'idle')}
