from typing import Dict, Optional, Tuple


class WaitForGraph:
    def __init__(self) -> None:
        self._owners: Dict[str, int] = {}
        self._waits: Dict[int, Tuple[str, int]] = {}

    def acquire_lock(self, tx_id: int, key: str) -> bool:
        owner = self._owners.get(key)
        if owner is None:
            self._owners[key] = tx_id
            pending = self._waits.get(tx_id)
            if pending is not None and pending[0] == key:
                del self._waits[tx_id]
            return True
        if owner == tx_id:
            return True
        self._waits[tx_id] = (key, owner)
        return False

    def release_lock(self, tx_id: int, key: str) -> bool:
        if self._owners.get(key) != tx_id:
            return False
        del self._owners[key]
        for waiter, (wait_key, _owner) in list(self._waits.items()):
            if wait_key == key:
                del self._waits[waiter]
        return True

    def release_all(self, tx_id: int) -> Tuple[str, ...]:
        keys = tuple(
            key for key, owner in self._owners.items() if owner == tx_id
        )
        for key in keys:
            self.release_lock(tx_id, key)
        self._waits.pop(tx_id, None)
        return keys

    def held_locks(self, tx_id: int) -> Tuple[str, ...]:
        return tuple(
            key for key, owner in self._owners.items() if owner == tx_id
        )

    def owner(self, key: str) -> Optional[int]:
        return self._owners.get(key)

    def waiting_on(self, tx_id: int) -> Optional[Tuple[str, int]]:
        return self._waits.get(tx_id)
