from typing import Optional, Sequence


class DeadlockVictimError(Exception):
    def __init__(self, tx_id: int, cycle: Sequence[int]) -> None:
        self.tx_id = tx_id
        self.cycle = tuple(cycle)
        super().__init__(
            "transaction %s aborted as deadlock victim, cycle=%s"
            % (self.tx_id, list(self.cycle))
        )


class StaleReadConflictError(Exception):
    def __init__(
        self,
        key: str,
        snapshot_ts: int,
        observed_ts: Optional[int],
    ) -> None:
        self.key = key
        self.snapshot_ts = snapshot_ts
        self.observed_ts = observed_ts
        super().__init__(
            "stale snapshot for key %r: snapshot_ts=%s observed_ts=%s"
            % (self.key, self.snapshot_ts, self.observed_ts)
        )
