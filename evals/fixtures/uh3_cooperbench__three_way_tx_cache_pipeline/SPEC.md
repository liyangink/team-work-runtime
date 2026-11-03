# SPEC：txengine 事务 / 租约缓存 / 死锁仲裁流水线

## 一、任务与交付物

本目录的 `src/txengine` 是一个 Python 库的基线版本：它提供单版本的键值存储、一个只记录占用关系的简单锁壳，以及一个不带租约世代校验的缓存包装。基线可以完成最基本的“开启事务 → 写入 → 提交 → 读取”，但不具备快照隔离、租约缓存防 ABA、等待图死锁仲裁这三项能力。

本任务要求保留既有四个子包的目录分层与公开导出，完成下列三项**相互耦合**的能力，并编写设计文档。

必须交付：

1. `DESIGN.md`（与本文档同目录）：设计文档，见第七节。
2. `src/txengine/` 下的实现代码：必须保持 `tx`、`cache`、`lock`、`coordinator` 四个子包以及根包 `txengine` 的导入路径不变；根包必须继续导出 `TransactionPipeline`、`MVCCManager`、`LeaseCache`、`WaitForGraph`、`DeadlockVictimError`、`StaleReadConflictError`。

不得修改本 SPEC 规定的公开契约。内部数据结构、辅助函数和私有方法可自行增加或调整。

## 二、运行环境与边界

- 仅使用 Python 3.9 及以上版本的标准库，不引入第三方依赖。
- 所有对象都在同一进程、同一线程内被同步调用；不要求线程安全、异步、阻塞等待或锁超时。锁的“等待”由调用方显式重试来表达。
- 不在磁盘、网络或外部服务中保存状态；不要求持久化、进程间共享、崩溃恢复。
- 值可以是任意非 `None` 的 Python 对象；不接受 `None` 作为写入值。删除键、范围事务、GC、TTL、真实时钟均不在本任务范围内。
- 事务、缓存、锁之间的调用顺序以本文档第四节的组合规则为准。

## 三、公开 API 契约

### 3.1 `txengine.types`

```python
DeadlockVictimError(tx_id: int, cycle: Sequence[int])
StaleReadConflictError(key: str, snapshot_ts: int, observed_ts: Optional[int])
```

- `DeadlockVictimError.tx_id`：被选中作为死锁牺牲者的事务 ID。
- `DeadlockVictimError.cycle`：环路上全部事务 ID 组成的元组；按等待方向排列，并从环中最小事务 ID 开始。
- `StaleReadConflictError.key`：发生快照冲突的键。
- `StaleReadConflictError.snapshot_ts`：冲突事务开始时的快照时间戳。
- `StaleReadConflictError.observed_ts`：冲突键在提交校验时观测到的、较新的已提交版本时间戳。
- 两个异常都应能被正常捕获，并保留上述属性。

### 3.2 `MVCCManager`

```python
begin_tx(read_only: bool = False) -> int
snapshot_ts(tx_id: int) -> int
transaction_state(tx_id: int) -> str
is_active(tx_id: int) -> bool
is_read_only(tx_id: int) -> bool
read(tx_id: int, key: str) -> Optional[object]
read_version(tx_id: int, key: str) -> Tuple[Optional[object], Optional[int]]
scan(tx_id: int, prefix: str = "") -> Dict[str, object]
write(tx_id: int, key: str, value: object) -> None
pending_keys(tx_id: int) -> Tuple[str, ...]
latest_commit_ts(key: str) -> Optional[int]
commit(tx_id: int) -> int
abort(tx_id: int) -> None
```

- `begin_tx`：创建一个事务并返回其事务 ID。事务 ID 从 1 开始严格递增。每次调用都分配一个严格递增的 `snapshot_ts`，该值在事务整个生命周期内固定不变，包括事务结束后再查询。
- `transaction_state` 只返回三种字符串：`"active"`、`"committed"`、`"aborted"`。
- `read` / `read_version` / `scan` / `write` / `commit` 只允许作用于 `"active"` 事务；否则抛出 `RuntimeError`。未知事务 ID 抛出 `KeyError`。
- `read` 返回 `read_version` 中的值部分。
- `read_version` 返回 `(value, commit_ts)`：
  - 若该事务自己已经暂存了该键的未提交写入，返回该暂存值与 `None`（表示这不是已提交版本，不可作为缓存回填依据）。
  - 否则返回对当前快照可见的最新已提交版本及其提交时间戳；没有可见版本时返回 `(None, None)`。
- `scan` 返回当前快照下以 `prefix` 开头、且对该事务可见的全部键值，外加该事务自己暂存的写入（后者覆盖前者）。快照之后才提交的键不得出现。
- `write` 把值暂存到该事务的未提交写集；同一事务重复写同一键时以后一次为准。只读事务写入、已结束事务写入都抛出 `RuntimeError`；写入 `None` 抛出 `ValueError`。
- `pending_keys` 返回该事务尚未提交的写集键（顺序不作要求）；事务已结束时返回空元组。
- `latest_commit_ts` 返回某个键当前最新已提交版本的时间戳；该键从未被提交过时返回 `None`。
- `commit`：
  - 对只读事务：不发布任何版本，标记为 `"committed"`，返回该事务的 `snapshot_ts`。
  - 对读写事务：先做快照校验。若该事务写集中的任意键的 `latest_commit_ts` 大于该事务的 `snapshot_ts`，说明该事务基于过期快照写入，必须抛出 `StaleReadConflictError`，且事务保持 `"active"`，由流水线负责随后中止它。存在多个冲突键时，按键的字典序取第一个。
  - 校验通过后，分配一个严格递增的提交时间戳，把写集中的全部键值以同一提交时间戳原子发布，清空写集，标记为 `"committed"`，返回该提交时间戳。即使写集为空，读写事务的提交也分配新的提交时间戳。
- `abort`：丢弃写集并标记为 `"aborted"`。对已经结束的事务重复调用是幂等的空操作。

### 3.3 `LeaseCache`

```python
get_or_lease(key: str, tx_id: int) -> Tuple[Optional[object], int]
fill_if_valid(key: str, epoch: int, payload: object) -> bool
invalidate_on_write_or_abort(key: str) -> int
invalidate_leases_for_tx(tx_id: int) -> int
```

- 缓存条目是不透明的 `payload`。流水线使用的 payload 固定为 `(value, commit_ts)` 二元组。
- 每个键维护一个只增不减的世代号（`lease_epoch`），初始为 0。
- `get_or_lease`：缓存命中时返回 `(payload, 当前世代号)`；未命中时返回 `(None, 当前世代号)`，并把“该事务在键 k、世代号 e 上获得了一个待回填租约”登记下来。只有未命中的调用才会产生待回填租约；命中不产生租约。
- `fill_if_valid`：仅当 `epoch` 等于该键的当前世代号、且该键当前没有缓存条目时，写入 payload 并返回 `True`；否则返回 `False` 且不改变缓存。回填成功会消耗掉所有在该键该世代号上的待回填租约。
- `invalidate_on_write_or_abort`：把该键的世代号加一，并移除该键的缓存条目；返回新的世代号。任何在此之前取得的该键租约随即失效。
- `invalidate_leases_for_tx`：作废该事务所持有的、仍处于当前世代号的待回填租约，并对这些键执行与 `invalidate_on_write_or_abort` 相同的失效动作；随后清空该事务的租约登记；返回实际作废的租约数量。已经回填消耗掉的租约不再属于待回填租约。

### 3.4 `WaitForGraph`

```python
WaitForGraph(abort_tx: Optional[Callable[[int], None]] = None)
acquire_lock(tx_id: int, key: str) -> bool
release_lock(tx_id: int, key: str) -> bool
release_all(tx_id: int) -> Tuple[str, ...]
held_locks(tx_id: int) -> Tuple[str, ...]
owner(key: str) -> Optional[int]
waiting_on(tx_id: int) -> Optional[Tuple[str, int]]
```

- `acquire_lock`：键空闲或已由同一事务持有时，记录持有并返回 `True`。键由其他事务持有时，把当前事务登记为“等待该键的当前持有者”，然后检测等待关系中是否存在环路：
  - 没有环路：返回 `False`。当前事务的这次写入没有发生，调用方可稍后重试。
  - 发现环路：从环路上选择事务 ID 最大的事务作为牺牲者（最年轻事务）。若构造时提供了 `abort_tx`，必须先调用 `abort_tx(牺牲者)`；随后必须清理该牺牲者在等待图中的全部锁持有记录与等待记录；最后抛出 `DeadlockVictimError(牺牲者, 环路)`。本次调用不会获得锁。
- 无论是否提供 `abort_tx`，抛出 `DeadlockVictimError` 之前都必须保证等待图中不再残留牺牲者的锁或等待边。牺牲者事务的写集回滚、缓存租约作废等动作由 `abort_tx` 回调完成；`TransactionPipeline` 必须提供该回调。
- `release_lock`：只有持有者本人能释放；释放成功返回 `True`，并移除所有正在等待该键的等待记录（这些事务需要重试）。非持有者释放返回 `False`。
- `release_all`：释放该事务持有的全部键，清除该事务自身的等待记录，返回被释放的键元组。
- `held_locks`：返回该事务当前持有的键元组；顺序不作要求。
- `owner`：返回键的当前持有事务 ID，空闲时返回 `None`。
- `waiting_on`：返回 `(等待的键, 该键的持有者事务 ID)`；不在等待时返回 `None`。

### 3.5 `TransactionPipeline`

```python
TransactionPipeline(cache: Optional[LeaseCache] = None)
begin(read_only: bool = False) -> int
read(tx_id: int, key: str) -> Optional[object]
scan(tx_id: int, prefix: str = "") -> Dict[str, object]
write(tx_id: int, key: str, value: object) -> bool
commit(tx_id: int) -> int
abort(tx_id: int) -> None
```

- 构造后可通过公开属性 `mvcc`、`cache`、`locks` 访问三个协作者；不传 `cache` 时自行创建。
- `begin` 等价于创建事务并返回事务 ID。
- 其余方法遵守第四节的组合规则。

## 四、业务规则

### 4.1 快照隔离读视图

- 事务开始时确定 `snapshot_ts`，之后不再改变。事务只能看见提交时间戳小于等于自己 `snapshot_ts` 的已提交版本，并且每个键只能看见其中最新的那个版本。
- 同一事务在两次读取同一键之间，即使其他事务提交了该键的新版本，也必须返回第一次看到的值（防不可重复读）。
- 同一事务在两次 `scan` 同一前缀之间，即使其他事务提交了新的键，也不得看到这些新键（防幻读）；已经可见的键不得消失。
- 事务必须能读到自己尚未提交的写入；这些写入对其他事务不可见，也绝不能进入共享缓存。
- 提交只能让新版本对 `snapshot_ts` 大于等于该提交时间戳的事务可见；对更早快照的事务必须保持不可见。
- 只读事务不写入、不发布版本、不持有写锁；可以正常读取快照。

### 4.2 租约世代缓存（防 ABA 幽灵回填）

- 缓存只允许承载某一时刻该键的**最新已提交版本**，绝不能承载未提交值、回滚值或已被覆盖的旧版本。
- 流水线读取时先检查自己的未提交写（读己之写），再向缓存申请租约：
  - 缓存命中且 payload 的 `commit_ts` 不大于该事务的 `snapshot_ts` 时，可直接返回缓存值。
  - 缓存命中但 `commit_ts` 大于 `snapshot_ts` 时，该条目对当前快照过新，必须忽略并改读快照版本。
  - 缓存未命中时读取快照版本；只有读到的值确实是该键当前最新已提交版本、且不是本事务未提交写入时，才允许用申请到的租约回填 `(value, commit_ts)`。若只是看到了历史快照版本，不得回填，以免旧值覆盖新值。
- 任何事务写入某键、或提交/中止涉及某键时，都必须使该键的旧缓存条目与旧租约失效。提交发布新版本与缓存失效必须在同一提交调用返回前完成。
- 事务中止（包括死锁牺牲者被自动中止）时，必须原子地完成：丢弃写集、使其写过的键的缓存失效、作废它持有的全部待回填租约。此后任何使用旧世代号发起的回填都必须失败。这正是阻止“旧租约在写或回滚之后把脏数据写回缓存”的保证。
- 回填成功后该租约即被消耗；之后缓存命中直接返回条目，不会再次申请回填。

### 4.3 等待图死锁检测与牺牲者仲裁

- 写操作发生锁冲突时，必须登记等待关系，并检测等待关系中是否存在环路。等待关系由“等待者事务 → 该键的当前持有者事务”构成。
- 发现环路时必须：
  1. 精确选择环路上事务 ID 最大的事务作为牺牲者；
  2. 自动对该牺牲者执行中止（见 4.2 与 4.4 的中止规则），回滚其全部已写未提交键、释放其持有的全部锁、作废其发出的全部待回填租约，并唤醒等待其锁的事务；
  3. 抛出 `DeadlockVictimError`，异常携带牺牲者事务 ID 与按等待方向排列、从最小事务 ID 开始的环路元组。
- 没有环路时冲突只表现为“本次未获得锁”：`acquire_lock` 返回 `False`，写入不暂存，缓存不变；调用方可重试。
- 同一事务重复获取自己已持有的锁是合法的，直接返回成功。
- 锁持有者提交、中止或显式释放锁后，等待该键的事务不再处于等待状态，可重试获取。

### 4.4 流水线组合规则

- `read`：
  1. 本事务有该键的未提交写入时，直接返回该值，不读缓存、不回填。
  2. 否则按 4.2 的租约读取流程返回快照可见值；键不存在或对快照不可见时返回 `None`。
- `write`：
  - 成功时返回 `True`，且该值已进入本事务未提交写集、该键的旧缓存条目与旧租约已失效。
  - 锁冲突且无死锁时返回 `False`，值不进入写集，缓存不变。
  - 检测到死锁时，牺牲者已完成回滚与清理，异常向调用方抛出。
  - 只读事务写入、写 `None`、对已结束事务写入时抛出错误；不得留下已获取但未释放的锁。
- `commit`：
  - 成功时返回提交时间戳；本次提交的全部写入对新快照可见，写过的键的缓存旧值与旧租约已失效，事务持有的锁与等待记录已全部释放。
  - 发生 `StaleReadConflictError` 时，必须先按中止规则清理该事务（写集、缓存、租约、锁、等待记录），再向调用方抛出该异常。
- `abort`：
  - 对活动事务：丢弃写集、使写过的键的缓存失效、作废该事务的全部待回填租约、释放其全部锁与等待记录；方法返回前完成全部清理。
  - 对已经中止的事务：幂等的空操作（仍可重复清理）。
  - 对已提交事务：不改变其提交结果，也不得重新发布或删除已提交版本；只做幂等的锁/租约清理。
  - 对未知事务 ID：抛出 `KeyError`。
- 死锁牺牲者的自动中止必须复用同一套中止语义，调用方捕获 `DeadlockVictimError` 后应能观察到：牺牲者事务不再是 `"active"`、其锁已释放、其未提交写已丢弃、其待回填租约已失效、等待其锁的事务可重试成功。
- 三项能力必须在同一代码树中协同工作：快照读取要经过租约缓存，写入要经过锁与缓存失效，提交/中止要同时收敛 MVCC 版本、缓存世代和等待图状态。不得为某一项能力单独绕开另外两项。

## 五、典型可验证行为

以下行为必须成立（等价场景可自行扩展，不得改变公开契约）：

1. 读己之写：事务写入后立即读到自己的值；其他事务读不到该未提交值。
2. 不可重复读防护：事务两次读同一键，中间另一事务提交新值，两次结果相同。
3. 幻读防护：事务两次扫描同一前缀，中间另一事务新增并提交键，第二次扫描看不到新键。
4. 快照版本：旧快照事务在缓存已存入新版本时仍读到自己的旧版本，且不会把旧版本回填到缓存覆盖新版本。
5. 旧租约回填拒绝：取得租约后，另一事务写入并提交/中止使世代号推进，旧世代号的 `fill_if_valid` 返回 `False`。
6. 中止作废租约：事务取得待回填租约后中止，使用旧世代号回填失败。
7. 死锁牺牲者：两个事务交叉持锁并互相等待，事务 ID 较大者被中止并抛出 `DeadlockVictimError`；其写集丢弃、锁释放，另一个事务重试后成功。
8. 写-写冲突：事务基于旧快照写入已被其他事务提交的键，提交抛出 `StaleReadConflictError`，且该事务随即被中止、锁被释放。
9. 只读事务：只读事务可以读快照、提交返回其 `snapshot_ts`；写入被拒绝。

## 六、基线与兼容

- 基线已能完成单事务的基本键值读写；实现上述能力后，这些基本用法必须仍然成立。
- 根包与四个子包的导入路径、六个公开名字以及本文第三节的签名不得改变。
- 允许增加私有辅助模块或私有方法，但不得把三项能力做成彼此隔离的可选插件；三者必须在同一条读写/提交/中止路径上生效。
- 不要求提供测试文件；实现者可以自行添加测试，但测试不得修改或绕过公开契约。

## 七、`DESIGN.md` 要求

`DESIGN.md` 必须用朴实、可核对的文字说明实际实现，至少覆盖：

1. 四个子包的分层、职责与依赖方向；
2. 快照读视图如何确定可见版本、如何保证重复读与扫描结果稳定；
3. 租约世代号在读取、回填、写入、提交、中止各路径上的变化时机，以及它如何阻断旧租约回填；
4. 等待关系的建立、环路的判定、牺牲者选择与自动中止的执行顺序；
5. 提交与中止时 MVCC、缓存、锁三者如何收敛到一致状态，以及失败路径（写冲突、死锁）如何恢复；
6. 已知边界：不处理线程并发、不做持久化与 GC 等。

设计文档可以包含图表，但不得只给图不给文字；也不得把上述契约改写成另一套行为。
