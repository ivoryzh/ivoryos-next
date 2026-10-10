# How the optimizers behave

What the Optimize page's three backends, Ax, BayBE and NIMO, do with the settings you give them,
and what happens when an experiment fails. The backends differ in more places than the page
suggests, so read the row for the one you use.

Legacy IvoryOS has the same adapters (`ivoryos/optimizer/` in the `ivoryos` repository), and they
behave the same way. Its version of this page is `docs/source/users/optimizer-behavior.md`.

## Which optimizers are offered

An optimizer appears on the Optimize page when its package is installed on the deck (a deck's
**Settings → Optimizers** in the desktop app). If one is installed but missing from the page, it
failed to load, and the deck's log says why at startup:

```text
[optimizer] baybe is installed but could not be loaded: ...
```

## How many trials, and in what rounds

**Evaluation Budget** is the total number of trials. **Batch Size** is how many trials the
optimizer suggests at once: every trial in a round runs, then the whole round is reported back
together. The last round is cut short so the budget is never exceeded.

How many trials a backend actually returns for a round:

| | Trials per round |
|---|---|
| **Ax** | Usually the batch size. Ax limits a batch to what its current step has left, so where the random start hands over to the model, IvoryOS asks again for the rest and a round can mix random and model trials. If the model cannot suggest anything yet (no results so far), the round runs with fewer: with a random start of 2 and a batch of 3, the first round has 2 trials. |
| **BayBE** | Always the batch size, all from one stage. The random stage can run past its configured count to the end of a batch: 4 random samples with a batch of 3 is two random rounds, 6 trials. |
| **NIMO** | The batch size, from its candidate list. |

## The random start (first step of Optimization Strategy)

Each backend starts with random or space-filling suggestions before its model takes over. The
number field on the first step sets how long that lasts, and the three backends count it
differently:

| | What the number counts | Existing data counts towards it | 0 or empty |
|---|---|---|---|
| **Ax** | Trials. A failed trial does not count, so Ax runs another random one in its place. | No | No random start: the model goes first, so without existing data the first suggestion fails. |
| **BayBE** | Results on record. | Yes | 1 |
| **NIMO** | **Rounds**, not trials: 2 with a batch of 3 is 6 random trials. | No | No random start: the model goes first and fails without results. |

With no strategy configured, Ax uses its own default: the centre of the search space, then 4 Sobol
trials, then its model once 2 results are in. BayBE needs a strategy; an empty one fails.

## When an experiment fails to give a result

A trial counts as failed when one of its objectives has no value: the step that should have
produced it was skipped, or it returned nothing (`None`), NaN, or something that is not a number
(the queue keeps only numbers as objectives). For example, the experiment was to sample a top
layer and the mixture never separated.

| | A failed trial |
|---|---|
| **Ax** | Marked failed in Ax. The run carries on, and Ax's model does not use it. |
| **NIMO** | Its candidate is left unmeasured. The run carries on. |
| **BayBE** | Left out of the model, and the deck log says so (`[optimizer] baybe: trial {...} gave no result ...`). BayBE has no failed status; the rest of the round is recorded and the run carries on. |

A failed trial still counts towards the evaluation budget. BayBE's random start counts results
it has on record, so a random trial that failed is made up with another random one before the
model takes over.

To be asked instead, tick **Pause and ask me when a trial gives no result** on the Optimize page.
The run then stops after such a trial, with the deck as the trial left it, and you choose:
**Leave it out** (as above), **Stop, run cleanup**, or **Stop run**.

When the optimizer itself fails, the run pauses in the same way and waits for you:

| The optimizer... | You can |
|---|---|
| cannot suggest the next trials | **Ask again**, **Stop, run cleanup**, or **Stop run** |
| refuses a round's results | **Record again**, **Go on without it** (the optimizer does not learn from that round), **Stop, run cleanup**, or **Stop run** |

A failed step works the same way: **Retry step**, **Skip step**, **Stop, run cleanup** or
**Stop run**. **Stop run** never runs the cleanup steps, because a failure may have left the deck
in a state they should not walk into; choose **Stop, run cleanup** when it is safe. Either way the
queue stays paused until you resume it, and the error and what you chose are kept with the run.

## Existing data

Rows chosen under **Existing Data** (earlier runs from Data History, or a CSV) are given to the
optimizer before its first suggestion.

| | Existing data |
|---|---|
| **Ax** | Each row is added as a completed trial. It does not shorten the random start. |
| **BayBE** | Each row is added as a measurement, and counts towards the random start. Every row needs every parameter and objective; BayBE refuses a row with one missing. |
| **NIMO** | **Not used.** NIMO reads existing results only from a file of its own format, and the Optimize page passes rows. |

## Search space

- A range with a step (`min, max, step`) becomes a list of values; without one it is continuous.
  NIMO takes only lists: a range with a step, or a choice.
- A parameter's type defaults to a number with decimals when it is not given.
- Ax does not accept these objective names: `test`, `factor`, `range`, `product`, `prod`, `sum`,
  `type`, `yield`.

## Plots

Data History's **Optimizer Plots** shows plots for the most recent optimization run since the deck
started; for an older run the optimizer is gone, and the panel says so.

| | Plots |
|---|---|
| **Ax** | Feature importance, contour (first objective) and slice, plus a Pareto frontier with two or more objectives. Needs at least 2 completed trials. The model is fitted on every result when you open the panel. |
| **BayBE** | Parallel coordinates, plus objective trade-offs with two or more objectives. Needs at least one result. |
| **NIMO** | A phase diagram image, which Data History cannot show yet. It is skipped for more than 2,000 candidates (it takes about a minute at 5,000 and cannot be interrupted), and NIMO 2.1.5's own plotting fails with NumPy 2.4 or later. |
