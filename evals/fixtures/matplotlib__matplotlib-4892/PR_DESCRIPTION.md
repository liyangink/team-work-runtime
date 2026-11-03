# Pull Request Review Task

## PR Title
Fix single-shot timers in nbagg backend

## PR Description
Single-shot timers are currently non-functional (raise an error) when using the `nbagg` backed.

To reproduce the issue, try running the following _in an ipython notebook_ (I can't seem to find a way to set up a fully independent `nbagg` figure without manually starting a "full" notebook):

```
import numpy as np
import matplotlib
matplotlib.use('nbAgg')
import matplotlib.pyplot as plt

fig, ax = plt.subplots()

def callback(ax):
    ax.plot(np.random.random((10, 10)))
    ax.figure.canvas.draw()

timer = fig.canvas.new_timer(1000, [(callback, [ax], {})])
timer.single_shot = True
timer.start()

plt.show()
```

Ideally, you'd get a figure that would update with a plot 1 second after being displayed.  Instead, you'll get an `AttributeError`:

```
---------------------------------------------------------------------------
AttributeError                            Traceback (most recent call last)
<ipython-input-1-346b07a4494a> in <module>()
     13 timer = fig.canvas.new_timer(500, [(callback, [ax], {})])
     14 timer.single_shot = True
---> 15 timer.start()
     16 #timer.stop()
     17 

/home/jofer/anaconda/lib/python2.7/site-packages/matplotlib/backend_bases.pyc in start(self, interval)
   1218         if interval is not None:
   1219             self._set_interval(interval)
-> 1220         self._timer_start()
   1221 
   1222     def stop(self):

/home/jofer/anaconda/lib/python2.7/site-packages/matplotlib/backends/backend_nbagg.pyc in _timer_start(self)
    186                 self._on_timer,
    187                 self.interval)
--> 188         self._timer.start()
    189 
    190     def _timer_stop(self):

AttributeError: '_Timeout' object has no attribute 'start'
```

Fully fixing this issue is slightly more complex than it seems at first glance.  Basically, single-shot timers need to follow a completely different code path than regular timers when using Tornado.

I've added some additional user acceptance tests to `/lib/matplotlib/backends/web_backend/nbagg_uat.ipynb` and can vouch that the current changes don't break any of the manual user acceptance tests in the notebook.


## Commits (2)
- Commit 1: Fixed single-shot timers in nbagg backend
- Commit 2: Added user-acceptance-tests for nbagg timers
