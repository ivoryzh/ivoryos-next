# Optimizers

How the Optimize page's settings reach Ax, BayBE and NIMO, what each feature does, and a list of
what could be better. The adapters are in `edge_server/ivoryos_edge/optimizer/`; the payload the
page builds is `packages/shared-ui/src/optimizerConfig.ts` (shared with Cloud, so a run started
from either is the same run). AGENTS.md section 6 has the queue-side details.

| | Ax | BayBE | NIMO |
|---|---|---|---|
| Ranges, choices, Fixed, Per-iteration | yes | yes | yes |
| Stepped ranges (`2 to 10 by 2`) | yes, as an ordered choice | yes, as a discrete parameter | yes |
| Constraints | inequalities on plain ranges; `=` by working one parameter out | `<=`, `>=`, `=`, plain ranges and stepped/choice separately | no |
| Substances (SMILES) | no | yes, with `baybe[chem]` | no |
| Suggest-only campaigns | yes | yes | no |
| Stop early at a target; stop when nothing improves | yes | yes | yes |

## Search space

Each `#variable` in the workflow is a row: **Range** (min to max, optionally **by** a step),
**Choice** (a list), **Substance** (BayBE with chemistry), or **Fixed** (one value), and
independently **Per-iteration** (a value per iteration from a table). A step turns a range into a
grid, `min, min+step, ... max`; when min, max and step are all whole numbers the grid is whole
numbers (`value_type: "int"`), so `2, 4, 6` reach the workflow as integers. (Ax used to declare
every stepped range a float; `AxOptimizer` now keeps the type.)

## Constraints

Written as people write them, one per row, the same for every optimizer:

```
flow_rate + 2*temperature <= 100
a >= b
a + b + c = 1
2*(a + b) <= c/2 + 4
```

Sums and differences of the searched parameters, each times or divided by a number, compared
with `<=`, `>=` or `=` (`<`, `>` and `==` are read as those). `optimizer/constraints.py` reads the
text with Python's own parser (never evaluates it) into coefficients, an operator and a right-hand
side, and refuses anything not linear, naming the part at fault (`a * b` multiplies two
parameters). Each adapter's `check_constraints` then says what it cannot keep. The Optimize page
asks `POST /api/optimizers/{name}/constraints` as a constraint is typed and shows the answer
under the row; `prepare_run` asks the same before queueing, so a run is refused in the same words
rather than failing once it starts. Clicking a parameter name under the rows adds it to the row
last typed in.

**Ax** takes inequalities only, and only on plain ranges (no step, not a choice). An equality is
kept exactly anyway: `AxOptimizer._plan_constraints` solves it for its last decimal-range
parameter (`a + b + c = 1` keeps `a` and `b` and works out `c = 1 - a - b`), takes that parameter
out of the search, adds two inequalities keeping it inside its own range, and rewrites every other
constraint without it. Each suggestion then gets the worked-out value (`_with_solved`). An equality
over whole-number ranges only, or one that sets a parameter outside its range, is refused.

**BayBE** keeps `<=`, `>=` and `=` itself. Over plain ranges a constraint is BayBE's
`ContinuousLinearConstraint`; over stepped, whole-number or choice parameters (which BayBE lists
out as combinations) it is a filter, `DiscreteCustomConstraint`, with a tolerance so a step of 0.1
adds up. One constraint cannot mix the two kinds (BayBE has no constraint spanning them), and one
that leaves no combination at all is refused. A choice of names or a substance has no number to
add up.

**NIMO** takes none, and the page shows no Constraints card for it.

## Substances (BayBE)

A **Substance** row is a choice of chemicals the model compares by structure instead of as
unrelated labels: methanol is closer to ethanol than to toluene. Each line is the name the
workflow receives and its SMILES; **Find** asks PubChem for the SMILES by name (only when pressed,
and only the name is sent). The encoding is how the model describes each one: Mordred
descriptors (BayBE's default, good for solvents and reagents), ECFP fingerprints (quicker, for
larger and more varied sets) or RDKit 2D descriptors. At least two substances are needed.

It needs BayBE's chemistry extras (RDKit and fingerprints, a few hundred MB). In the desktop app
that is a deck's Settings, Optimizers, BayBE `0.15.0 with chemistry (substances)`, written to the
deck as `baybe[chem]==0.15.0`; elsewhere `pip install "baybe[chem]"`. The edge reports whether it
is installed (`substance_available` in `GET /api/optimizers`), and the page offers Substance only
then. `baybe[chem]==0.15.0` passed `tests/manual/optimizer_smoke.py` beside Ax 1.3.1 (Python 3.11,
CPU PyTorch); NIMO was not part of that check.

## Stopping a run early

- **At a target:** an objective's "Stop early at ≥ / ≤" ends the run once a trial reaches it; with
  several, "any criterion" or "all criteria" decides.
- **When nothing improves:** "Stop when no objective has improved for N iterations in a row"
  (`stop_after_no_improvement`, `NoImprovement` in `queue.py`). An iteration improves when any
  objective beats its best so far (existing data included); the random start (step 1's
  samples) never counts against it, and an improvement starts the count again.

Either way the run ends as completed, and the log says which rule stopped it.

## Suggest-only campaigns

For experiments the deck does not run, or not all of: **Suggest only** on the Optimize page makes
a campaign (`campaigns.py`, table `campaigns`) and opens it at `/campaign?id=`. The optimizer
suggests a batch; people run it their own way and type each result in when it is ready (now or
next week); **Suggest N more** asks for the next batch. A suggestion not run can be set aside
(neither a result nor waiting); a note can go with each. The campaign exports to CSV, and the
Optimize page lists the campaigns there are.

Nothing of the optimizer is kept between requests. Each "suggest more" builds it again from the
campaign: its settings and existing data, every suggestion with a result (as data) and every one
still waiting (as pending, `add_pending`, so the same point is not suggested twice). That is what
lets a campaign outlive a restart and wait any length of time, at the price of fitting the model
per request (seconds, for a lab-sized campaign). Two details make the rebuild behave like one
long-lived optimizer:

- **The random start.** BayBE switches to its model after a number of *results*
  (`random_start_counts_results`), which is right as it is. Ax counts the trials its random step
  *generated*, and a rebuilt Ax generated none, so step 1's samples are reduced by the suggestions
  already given out (and kept random while there is no result yet, since a model has nothing to
  fit).
- **No repeats.** A long-lived BayBE campaign never re-suggests its own points; a rebuilt one did
  not know them, so `allow_recommending_already_measured=False` (allowed by BayBE only when every
  parameter is stepped or a choice; a continuous point does not recur exactly anyway).

Constraints, steps and substances work in campaigns as in runs. Stopping rules do not apply.
API: `GET/POST /api/campaigns`, `GET/PATCH/DELETE /api/campaigns/{id}`,
`POST /api/campaigns/{id}/suggest {n}`, `PUT /api/campaigns/{id}/rows/{row} {results, note, discarded}`.

## What could be better

What we know is missing or weak, roughly by how much it would matter to someone running a lab
campaign. None of it is started.

**Saying what you want**
- **Outcome limits.** "Maximize yield, but keep impurity under 5%." Ax has outcome constraints;
  BayBE can express it with a desirability objective and bounds. Not exposed.
- **Objective weights.** The page has no weight field. Ax's adapter can weigh objectives; BayBE's
  adapter reads a weight and ignores it, and always treats several objectives as a Pareto front.
  BayBE's `DesirabilityObjective` is the weighted alternative ("60% yield, 40% cost").
- **Hit a target value** ("pH 7.0", "match this colour"). BayBE's numerical targets can aim at a
  value; Ax would need `|x - target|` as the objective.
- **Pass/fail outcomes** ("did it crystallize?"): BayBE's `BinaryTarget`.
- **Log-scale ranges** for concentrations or flow rates spanning decades: Ax supports
  `scaling="log"`; BayBE would need a transformed parameter. Not exposed.
- **Rules that are not sums** (BayBE): never this combination (`DiscreteExcludeConstraint`, "never
  water above 100 °C"); the same value across a batch (`DiscreteBatchConstraint`, one heater block
  per plate, which fits batch mode directly); at most k components non-zero in a mixture
  (cardinality constraints); a parameter that only matters when another has a value
  (`DiscreteDependenciesConstraint`, "catalyst loading is ignored when catalyst = none"). They
  would be rule rows beside the equations.
- **Constraints on stepped ranges in Ax**, and constraints in NIMO.

**The model**
- **Explore vs exploit.** The one model knob worth putting in front of people: a slider mapping to
  the acquisition function (pure exploration, `PSTD`, "learn the landscape"; UCB with its beta;
  pure exploitation, `PM`).
- **Surrogate model** (BayBE): random forest, NGBoost or a Bayesian linear model instead of the
  Gaussian process, for small or noisy data.
- **Kernels.** Matern 5/2 (the default) is right for most lab problems; if exposed at all, as a few
  presets ("smooth / rough / periodic") rather than raw choices. Low priority.
- **Noise and replicates.** We send a mean only; Ax can take each result's standard error, and
  replicate trials could be averaged into one.

**Running a campaign**
- **Keep a run's optimizer.** A run's optimizer lives in memory for the most recent run only: a
  restart loses it and its plots, and a run cannot be resumed except by seeding a new one with its
  data. Both libraries can serialize their state (`Campaign.to_json`, Ax's JSON storage); keeping
  it per run would give resume and plots for every past run. (Campaigns avoid this by rebuilding.)
- **More stopping rules:** stop when the model is confident enough (its uncertainty over the
  space falls below a level), or when the expected improvement is negligible.
- **Learn from a related campaign** (another substrate, another reactor): BayBE's `TaskParameter`
  transfer learning, Ax's multi-task models (`SAAS_MTGP` is listed but nothing feeds it a task).
- **Cheap then real** experiments (simulation first, then the bench): multi-fidelity.
- **Campaigns without a workflow.** A campaign takes its parameters and objectives from the
  Designer's workflow; one for wholly manual experiments would want them typed in directly.
- **Campaigns in Data History and Cloud.** A campaign's results are only on its own page and in
  its CSV.

**Seeing what the optimizer thinks**
- **Best so far per iteration**, for all three optimizers, on the run.
- **The model's view:** prediction and uncertainty across a parameter, and which parameters
  matter most (BayBE's insights module, SHAP). BayBE's plots today are parallel coordinates and a
  trade-off scatter.
- **Why this point:** each suggestion's predicted value and uncertainty, beside it in the run view
  and the campaign table.

**Upkeep**
- The adapters exist twice, here and in Classic `ivoryos` (`ivoryos/optimizer/`), kept in step by
  hand. Classic's BayBE adapter has none of the constraint, substance or campaign work above.
- Ax refuses objectives named `yield`, `test`, `sum`, `type` and a few others
  (`AX_OBJ_BLACKLIST`), and the page does not warn until the run fails to start.
- `baybe[chem]` has not been checked beside NIMO.
