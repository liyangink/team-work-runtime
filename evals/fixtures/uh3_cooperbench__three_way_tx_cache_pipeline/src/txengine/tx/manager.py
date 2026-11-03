from dataclasses import dataclass, field
from typing import Dict, Optional, Tuple


@dataclass
class _Txn:
    tx_id: int
    snapshot_ts: int
    read_only: bool
    state: str = "active"
    writes: Dict[str, object] = field(default_factory=dict)


class MVCCManager:
    def __init__(self) -> None:
        self._clock = 0
        self._next_tx_id = 0
        self._txns: Dict[int, _Txn] = {}
        self._data: Dict[str, Tuple[object, int]] = {}

    def _txn(self, tx_id: int) -> _Txn:
        tx = self._txns.get(tx_id)
        if tx is None:
            raise KeyError("unknown transaction %r" % (tx_id,))
        return tx

    def _active(self, tx_id: int) -> _Txn:
        tx = self._txn(tx_id)
        if tx.state != "active":
            raise RuntimeError(
                "transaction %s is %s" % (tx_id, tx.state)
            )
        return tx

    def begin_tx(self, read_only: bool = False) -> int:
        self._next_tx_id += 1
        self._clock += 1
        tx = _Txn(
            tx_id=self._next_tx_id,
            snapshot_ts=self._clock,
            read_only=bool(read_only),
        )
        self._txns[tx.tx_id] = tx
        return tx.tx_id

    def snapshot_ts(self, tx_id: int) -> int:
        return self._txn(tx_id).snapshot_ts

    def transaction_state(self, tx_id: int) -> str:
        return self._txn(tx_id).state

    def is_active(self, tx_id: int) -> bool:
        tx = self._txns.get(tx_id)
        return tx is not None and tx.state == "active"

    def is_read_only(self, tx_id: int) -> bool:
        return self._txn(tx_id).read_only

    def read(self, tx_id: int, key: str) -> Optional[object]:
        value, _commit_ts = self.read_version(tx_id, key)
        return value

    def read_version(
        self, tx_id: int, key: str
    ) -> Tuple[Optional[object], Optional[int]]:
        tx = self._active(tx_id)
        if key in tx.writes:
            return tx.writes[key], None
        entry = self._data.get(key)
        if entry is None:
            return None, None
        value, commit_ts = entry
        return value, commit_ts

    def scan(self, tx_id: int, prefix: str = "") -> Dict[str, object]:
        tx = self._active(tx_id)
        result: Dict[str, object] = {}
        for key, (value, _commit_ts) in self._data.items():
            if key.startswith(prefix):
                result[key] = value
        for key, value in tx.writes.items():
            if key.startswith(prefix):
                result[key] = value
        return result

    def write(self, tx_id: int, key: str, value: object) -> None:
        tx = self._active(tx_id)
        if tx.read_only:
            raise RuntimeError("transaction %s is read-only" % (tx_id,))
        if value is None:
            raise ValueError("value must not be None")
        tx.writes[key] = value

    def pending_keys(self, tx_id: int) -> Tuple[str, ...]:
        return tuple(self._txn(tx_id).writes.keys())

    def latest_commit_ts(self, key: str) -> Optional[int]:
        entry = self._data.get(key)
        if entry is None:
            return None
        return entry[1]

    def commit(self, tx_id: int) -> int:
        tx = self._active(tx_id)
        if tx.read_only:
            tx.state = "committed"
            return tx.snapshot_ts
        self._clock += 1
        commit_ts = self._clock
        for key, value in tx.writes.items():
            self._data[key] = (value, commit_ts)
        tx.writes.clear()
        tx.state = "committed"
        return commit_ts

    def abort(self, tx_id: int) -> None:
        tx = self._txn(tx_id)
        if tx.state != "active":
            return
        tx.writes.clear()
        tx.state = "aborted"
