from typing import Dict, Optional

from ..cache.lease_cache import LeaseCache
from ..lock.wait_graph import WaitForGraph
from ..tx.manager import MVCCManager


class TransactionPipeline:
    def __init__(self, cache: Optional[LeaseCache] = None) -> None:
        self.mvcc = MVCCManager()
        self.cache = cache if cache is not None else LeaseCache()
        self.locks = WaitForGraph()

    def begin(self, read_only: bool = False) -> int:
        return self.mvcc.begin_tx(read_only)

    def read(self, tx_id: int, key: str) -> Optional[object]:
        value, commit_ts = self.mvcc.read_version(tx_id, key)
        if commit_ts is None and value is not None:
            return value
        payload, epoch = self.cache.get_or_lease(key, tx_id)
        if payload is not None:
            cached_value, cached_ts = payload
            if cached_ts <= self.mvcc.snapshot_ts(tx_id):
                return cached_value
        if value is not None and commit_ts is not None:
            self.cache.fill_if_valid(key, epoch, (value, commit_ts))
        return value

    def scan(self, tx_id: int, prefix: str = "") -> Dict[str, object]:
        return self.mvcc.scan(tx_id, prefix)

    def write(self, tx_id: int, key: str, value: object) -> bool:
        if not self.locks.acquire_lock(tx_id, key):
            return False
        try:
            self.mvcc.write(tx_id, key, value)
        except Exception:
            self.locks.release_lock(tx_id, key)
            raise
        self.cache.invalidate_on_write_or_abort(key)
        return True

    def commit(self, tx_id: int) -> int:
        keys = self.mvcc.pending_keys(tx_id)
        commit_ts = self.mvcc.commit(tx_id)
        for key in keys:
            self.cache.invalidate_on_write_or_abort(key)
        self.locks.release_all(tx_id)
        return commit_ts

    def abort(self, tx_id: int) -> None:
        keys = self.mvcc.pending_keys(tx_id)
        if self.mvcc.is_active(tx_id):
            self.mvcc.abort(tx_id)
        for key in keys:
            self.cache.invalidate_on_write_or_abort(key)
        self.cache.invalidate_leases_for_tx(tx_id)
        self.locks.release_all(tx_id)
