from typing import Dict, Optional, Set, Tuple


class LeaseCache:
    def __init__(self) -> None:
        self._entries: Dict[str, object] = {}
        self._leases: Dict[int, Set[Tuple[str, int]]] = {}

    def get_or_lease(
        self, key: str, tx_id: int
    ) -> Tuple[Optional[object], int]:
        payload = self._entries.get(key)
        epoch = 0
        if payload is None:
            self._leases.setdefault(tx_id, set()).add((key, epoch))
        return payload, epoch

    def fill_if_valid(self, key: str, epoch: int, payload: object) -> bool:
        if key in self._entries:
            return False
        self._entries[key] = payload
        return True

    def invalidate_on_write_or_abort(self, key: str) -> int:
        self._entries.pop(key, None)
        return 0

    def invalidate_leases_for_tx(self, tx_id: int) -> int:
        leases = self._leases.pop(tx_id, set())
        invalidated = 0
        for key, _epoch in leases:
            self._entries.pop(key, None)
            invalidated += 1
        return invalidated
