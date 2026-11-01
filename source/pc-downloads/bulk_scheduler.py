"""Keep request generation separate from long file copies."""
import json,os,pathlib,threading,time
import worker
import bulk_policy as policy
import bulk_queue
import bulk_feed
import control_state

def produce():
    while True:
        try:
            if (worker.ROOT/'server-move-hold.json').exists():time.sleep(5);continue
            worker.refresh_config()
            controls=control_state.read(worker.ROOT)
            if not worker.CONFIG.get('bulk_enabled',True) or controls.get(('pc' if worker.CONFIG.get('bulk_destination','computer')=='computer' else 'pi')+'Paused'):
                time.sleep(5);continue
            state=policy.load()
            # Resolve the next older year only after the current verified pool has
            # been handed off. Every new batch is selected by its real date.
            manifest=json.loads(bulk_feed.MANIFEST.read_text()) if bulk_feed.MANIFEST.exists() else {}
            for kind in ['movie','tv']:
                unrequested=[x for x in policy.pending_items(state) if x['kind']==kind and not x.get('manual') and not x.get('nativeId') and x.get('deferUntil',0)<=time.time() and policy.key(kind,x['tmdbId']) not in manifest]
                if not unrequested:
                    years=[int(k.split(':')[1]) for k in state['resolvedYears'] if k.startswith(kind+':')]
                    next_year=min(years)-1 if years else __import__('datetime').date.today().year
                    if next_year>=1880:policy.hydrate_year(state,kind,next_year)
            policy.expand_sequels(state);policy.apply_native_policy(state)
            report=bulk_feed.run(max_add=20)
            policy.write_plan(policy.load())
            (worker.ROOT/'bulk-request-status.json').write_text(json.dumps(report,indent=2))
            try:
                from collections_v2 import run as update_collections
                collections=update_collections()
                (worker.ROOT/'collection-status.json').write_text(json.dumps({'status':'Updated','result':collections},indent=2))
            except Exception as exc:
                (worker.ROOT/'collection-status.json').write_text(json.dumps({'status':'Collection refresh deferred','reason':type(exc).__name__}))
        except Exception as exc:
            (worker.ROOT/'bulk-request-status.json').write_text(json.dumps({'status':'Retry deferred','reason':type(exc).__name__}))
        stamp=control_state.read(worker.ROOT).get('updated');settings_stamp=(worker.ROOT/'settings.json').stat().st_mtime_ns
        for _ in range(60):
            time.sleep(5)
            if control_state.read(worker.ROOT).get('updated')!=stamp or (worker.ROOT/'settings.json').stat().st_mtime_ns!=settings_stamp:break

def main():
    import msvcrt
    lock=(worker.ROOT/'bulk-scheduler.lock').open('a+b')
    try:msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
    except OSError:return
    threading.Thread(target=produce,daemon=True).start()
    while True:
        try:
            if (worker.ROOT/'server-move-hold.json').exists():time.sleep(5);continue
            result=bulk_queue.run()
            (worker.ROOT/'bulk-queue-status.json').write_text(json.dumps(result,indent=2))
        except Exception as exc:
            (worker.ROOT/'bulk-queue-status.json').write_text(json.dumps({'status':'Queue check deferred','reason':type(exc).__name__}))
        time.sleep(30)

if __name__=='__main__':main()
