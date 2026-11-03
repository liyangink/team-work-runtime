# Pull Request Review Task

## PR Title
Coordinate representation lost in `__getitem__`

## PR Description
When a SkyCoord or Frame is reduced via `__getitem__` then the representation always goes back to that of the internal representation data:

```
In [2]: c = SkyCoord([90], [0], unit='deg')

In [3]: c.representation = 'cartesian'

In [4]: c
Out[4]: 
<SkyCoord (ICRS): (x, y, z) [dimensionless]
    (0.0, 1.0, 0.0)>

In [5]: c[0]
Out[5]: 
<SkyCoord (ICRS): (ra, dec) in deg
    (90.0, 0.0)>
```

This is fixed in 8765e59 within #REDACTED.  I didn't want to lose momentum on #REDACTED so I didn't stop to make a separate PR and wait for that to get merged.  We can cherry pick that commit to make a formal PR to fix this bug if everything looks fine.


## Commits (2)
- Commit 1: Fix bug where coord representation gets lost in __getitem__
- Commit 2: Update CHANGES.rst
