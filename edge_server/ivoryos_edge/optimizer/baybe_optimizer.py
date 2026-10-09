from pandas import DataFrame

from ivoryos_edge.optimizer.base_optimizer import OptimizerBase
from ivoryos_edge.optimizer.constraints import ConstraintError, describe, parse_all

# How a substance is described to the model (BayBE's SubstanceEncoding names). Mordred
# descriptors are BayBE's default and the usual choice for solvents and reagents; fingerprints
# (ECFP) are quicker and suit larger, more varied sets.
SUBSTANCE_ENCODINGS = ["MORDRED", "ECFP", "RDKIT2DDESCRIPTORS"]


def chemistry_available() -> bool:
    """Whether BayBE's chemistry extras (`baybe[chem]`) are installed, which substances need."""
    try:
        from baybe._optional.info import CHEM_INSTALLED
        return bool(CHEM_INSTALLED)
    except Exception:
        import importlib.util
        return all(importlib.util.find_spec(m) is not None for m in ("rdkit", "skfp"))

class BaybeOptimizer(OptimizerBase):
    # Its two-phase recommender switches after this many *results*, so an optimizer rebuilt from a
    # campaign's results (campaigns.py) is already in the right phase.
    random_start_counts_results = True
    def __init__(self, experiment_name, parameter_space, objective_config, optimizer_config,
                 parameter_constraints:list=None, datapath=None, additional_params:dict=None):
        try:
            from baybe import Campaign
        except ImportError as e:
            raise ImportError(
                "BaybeOptimizer requires the optional BayBE dependency. "
                "Install it with `pip install baybe`."
            ) from e

        super().__init__(experiment_name, parameter_space, objective_config, optimizer_config, parameter_constraints, datapath, additional_params)
        self._trial_id = 0
        self._trials = {}
        self._pending = None

        self.experiment = Campaign(
            searchspace=self._convert_parameter_to_searchspace(parameter_space, parameter_constraints),
            objective=self._convert_objective_to_baybe_format(objective_config),
            recommender=self._convert_recommender_to_baybe_format(optimizer_config),
            # Never suggest a point already measured: one from existing data, or (in a suggest-only
            # campaign, rebuilt from its results each time, campaigns.py) one this optimizer did
            # not itself suggest and so would otherwise suggest again. BayBE allows the setting
            # only when every parameter is stepped or a choice; a continuous point is not repeated
            # exactly anyway.
            **({} if any(self._kind(p) == "continuous" for p in parameter_space)
               else {"allow_recommending_already_measured": False}),
        )


    def suggest(self, n=1):
        # self.df = self.experiment.recommend(batch_size=n)
        return self.experiment.recommend(batch_size=n, pending_experiments=self._pending).to_dict(orient="records")

    def add_pending(self, points):
        """Suggestions still waiting for their results: BayBE leaves them out of the next ones."""
        names = [p["name"] for p in self.parameter_space]
        rows = [{name: point[name] for name in names} for point in points or [] if all(name in point for name in names)]
        self._pending = DataFrame(rows) if rows else None

    def observe(self, results, index=None):
        """
        Record a round's results: one dict per suggested trial, holding the parameter values it
        ran with and its objective values (the queue sends both; BayBE needs both).

        A trial with an objective missing failed and is left out: BayBE has no failed status
        (a missing target is refused as an incomplete measurement) and records only
        measurements. That is what Ax's mark_trial_failed amounts to as well -- a failed trial
        teaches neither model anything, and neither offers its point again in a discrete space
        (BayBE does not re-recommend a point it already recommended). Only the bookkeeping
        differs, and the run's own record holds the failed step, so this says so and moves on.
        """
        targets = [o["name"] for o in self.objective_config]
        params = [p["name"] for p in self.parameter_space]
        rows = [r for r in results if all(r.get(t) is not None for t in targets)]
        for r in results:
            if r not in rows:
                point = {p: r.get(p) for p in params}
                print(f"[optimizer] baybe: trial {point} gave no result; BayBE keeps no record of a failed "
                      f"experiment, so it is left out of the model.")
        if not rows:
            return
        df = DataFrame(rows)
        missing = [p for p in params if p not in df.columns]
        if missing:
            raise ValueError(f"BayBE needs each result's parameter values too; missing {missing}.")
        self.experiment.add_measurements(df[params + targets])

    def append_existing_data(self, existing_data: DataFrame, file_path: str = None):
        """
        Append existing data to the Ax experiment.
        :param existing_data: A dictionary containing existing data.
        """
        if existing_data.empty:
            return
        # parameter_names = [i.get("name") for i in self.parameter_space]
        # objective_names = [i.get("name") for i in self.objective_config]
        self.experiment.add_measurements(existing_data)
        # for name, value in existing_data.items():
        #     # First attach the trial and note the trial index
        #     parameters = {name: value for name in existing_data if name in parameter_names}
        #     trial_index = self.client.attach_trial(parameters=parameters)
        #     raw_data = {name: value for name in existing_data if name in objective_names}
        #     # Then complete the trial with the existing data
        #     self.client.complete_trial(trial_index=trial_index, raw_data=raw_data)


    @staticmethod
    def _kind(param):
        """How BayBE holds a parameter (as _convert_parameter_to_searchspace builds it)."""
        if param.get("type") == "substance":
            return "substance"
        if param.get("type") == "choice":
            values = param.get("bounds") or []
            return "discrete" if values and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in values) else "categorical"
        if len(param.get("bounds") or []) == 3 or param.get("value_type") == "int":
            return "discrete"
        return "continuous"

    @classmethod
    def check_constraints(cls, constraints, parameter_space):
        """For each constraint, why BayBE cannot use it, or None (the Optimize page's live check).

        BayBE constrains plain ranges (continuous) and stepped, whole-number or choice parameters
        (a list of combinations, filtered) in two different ways, so one constraint has to stay on
        one side. A choice of names or a substance has no number to add up.
        """
        by_name = {p["name"]: p for p in parameter_space}
        problems = []
        for con in constraints:
            kinds = {name: cls._kind(by_name[name]) for name in con.names}
            named = [n for n, k in kinds.items() if k in ("categorical", "substance")]
            continuous = [n for n, k in kinds.items() if k == "continuous"]
            discrete = [n for n, k in kinds.items() if k == "discrete"]
            if named:
                problems.append(f"'{con.text}': {named[0]} is {describe(by_name[named[0]])}, which has no number to add up.")
            elif continuous and discrete:
                problems.append(
                    f"'{con.text}' mixes {continuous[0]} ({describe(by_name[continuous[0]])}) with {discrete[0]} "
                    f"({describe(by_name[discrete[0]])}). BayBE constrains plain ranges and stepped or choice "
                    "parameters separately: give them the same kind, or split the constraint."
                )
            else:
                problems.append(None)
        return problems

    @staticmethod
    def _convert_constraints(constraints, parameter_space):
        """Parsed constraints as BayBE's: linear ones over plain ranges, filters over the rest."""
        from baybe.constraints import ContinuousLinearConstraint, DiscreteCustomConstraint
        kinds = {p["name"]: BaybeOptimizer._kind(p) for p in parameter_space}
        out = []
        for con in constraints:
            if all(kinds[name] == "continuous" for name in con.names):
                out.append(ContinuousLinearConstraint(
                    parameters=con.names, operator=con.operator,
                    coefficients=[con.coefficients[name] for name in con.names], rhs=con.rhs,
                ))
            else:
                # The combinations BayBE lists out, kept when they meet the constraint. A step of
                # 0.1 does not add up exactly in floating point, hence the tolerance in `holds`.
                def keep(df, con=con):
                    return df[con.names].apply(lambda row: con.holds(row.to_dict()), axis=1)
                out.append(DiscreteCustomConstraint(parameters=con.names, validator=keep))
        return out

    def _convert_parameter_to_searchspace(self, parameter_space, parameter_constraints=None):
        """
        Converts the parameter space configuration to Baybe format.
        :param parameter_space: The parameter space configuration.
        [
            {"name": "param_1", "type": "range", "bounds": [1.0, 2.0], "value_type": "float"},
            {"name": "param_2", "type": "range", "bounds": [1.0, 2.0, 0.5], "value_type": "float"},

            {"name": "param_3", "type": "choice", "bounds": ["a", "b", "c"], "value_type": "str"},
            {"name": "param_4", "type": "range", "bounds": [0 10], "value_type": "int"},
            {"name": "param_5", "type": "substance", "bounds": ["methanol", "water", "toluene"], "value_type": "str"} #TODO
        ]
        :return: A list of Baybe parameters.
        """
        from baybe.parameters.categorical import CategoricalParameter
        from baybe.parameters.numerical import NumericalContinuousParameter, NumericalDiscreteParameter
        from baybe.searchspace import SearchSpace
        constraints = parse_all(parameter_constraints, [p["name"] for p in parameter_space])
        problems = self.check_constraints(constraints, parameter_space)
        if any(problems):
            raise ConstraintError(" ".join(problem for problem in problems if problem))
        parameters = []
        for p in parameter_space:
            value_type = p.get("value_type", "float")
            if p["type"] == "range":
                if len(p["bounds"]) == 3:
                    values = self._create_discrete_search_space(range_with_step=p["bounds"],value_type=value_type)
                    parameters.append(NumericalDiscreteParameter(name=p["name"], values=values))
                elif value_type == "int":
                    values = tuple([int(v) for v in range(p["bounds"][0], p["bounds"][1] + 1)])
                    parameters.append(NumericalDiscreteParameter(name=p["name"], values=values))
                else:
                    parameters.append(NumericalContinuousParameter(name=p["name"], bounds=p["bounds"]))

            elif p["type"] == "choice":
                if value_type in ["int", "float"]:
                    parameters.append(NumericalDiscreteParameter(name=p["name"], values=p["bounds"]))
                else:
                    parameters.append(CategoricalParameter(name=p["name"], values=p["bounds"]))

            elif p["type"] == "substance":
                parameters.append(self._substance(p))
        searchspace = SearchSpace.from_product(parameters, self._convert_constraints(constraints, parameter_space))
        discrete = [p for p in parameter_space if self._kind(p) != "continuous"]
        if constraints and discrete and len(searchspace.discrete.exp_rep) == 0:
            raise ConstraintError("No combination of the stepped and choice values meets the constraints.")
        return searchspace

    @staticmethod
    def _substance(p):
        """A substance parameter: names the workflow receives, each with the SMILES BayBE describes
        it by (`bounds` is {name: SMILES}), so the model knows methanol is closer to ethanol than to
        toluene instead of treating them as unrelated labels."""
        if not chemistry_available():
            raise ImportError(
                f"{p['name']} is a substance, which needs BayBE's chemistry extras. Install BayBE with "
                "chemistry in the deck's Settings, Optimizers (or `pip install \"baybe[chem]\"`)."
            )
        from baybe.parameters import SubstanceParameter
        data = p.get("bounds") or {}
        if isinstance(data, list):  # [{name, smiles}] as well as {name: smiles}
            data = {str(d.get("name")): str(d.get("smiles")) for d in data}
        if len(data) < 2:
            raise ValueError(f"{p['name']} needs at least two substances to choose between.")
        encoding = str(p.get("encoding") or "MORDRED").upper()
        if encoding not in SUBSTANCE_ENCODINGS:
            raise ValueError(f"{p['name']}: unknown substance encoding {encoding} (one of {', '.join(SUBSTANCE_ENCODINGS)}).")
        try:
            return SubstanceParameter(name=p["name"], data=data, encoding=encoding)
        except Exception as e:
            raise ValueError(f"{p['name']}: {e}") from e

    def _convert_objective_to_baybe_format(self, objective_config):
        """
        Converts the objective configuration to Baybe format.
        :param parameter_space: The parameter space configuration.
        [
            {"name": "obj_1", "minimize": True},
            {"name": "obj_2", "minimize": False}
        ]
        :return: A Baybe objective configuration.
        """
        from baybe.targets import NumericalTarget
        from baybe.objectives import SingleTargetObjective, ParetoObjective
        targets = []
        weights = []
        for obj in objective_config:
            obj_name = obj.get("name")
            minimize = obj.get("minimize", True)
            weight = obj.get("weight", 1)
            weights.append(weight)
            targets.append(NumericalTarget(name=obj_name, minimize=minimize))

        if len(targets) == 1:
            return SingleTargetObjective(target=targets[0])
        else:
            # Handle multiple objectives
            return ParetoObjective(targets=targets)


    def _convert_recommender_to_baybe_format(self, recommender_config):
        """
        Converts the recommender configuration to Baybe format.
        :param recommender_config: The recommender configuration.
        :return: A Baybe recommender configuration.
        """
        from baybe.recommenders import (
            BotorchRecommender,
            FPSRecommender,
            TwoPhaseMetaRecommender,
            RandomRecommender,
            NaiveHybridSpaceRecommender
        )
        step_1 = recommender_config.get("step_1", {})
        step_2 = recommender_config.get("step_2", {})
        step_1_recommender = step_1.get("model", "Random")
        step_2_recommender = step_2.get("model", "BOTorch")
        if step_1.get("model") == "Random":
            step_1_recommender = RandomRecommender()
        elif step_1.get("model") == "FPS":
            step_1_recommender = FPSRecommender()
        if step_2.get("model") == "Naive Hybrid Space":
            step_2_recommender = NaiveHybridSpaceRecommender()
        elif step_2.get("model") == "BOTorch":
            step_2_recommender = BotorchRecommender()
        # How long step 1 lasts. BayBE switches once this many measurements are on record
        # (existing data counts, a failed trial does not) and takes only a real int of at
        # least 1, which is also its default. The Optimize page sends 0 for an emptied field.
        switch_after = max(1, int(step_1.get("num_samples") or 1))
        return TwoPhaseMetaRecommender(
            initial_recommender=step_1_recommender,
            recommender=step_2_recommender,
            switch_after=switch_after,
        )

    def get_plots(self, plot_type):
        try:
            import plotly.express as px
            import pandas as pd
            
            plots = {}
            if not hasattr(self.experiment, 'measurements') or self.experiment.measurements.empty:
                return {"error": "No measurements collected yet. Please wait for the first iteration to finish and try again."}
                
            df = self.experiment.measurements
            
            # --- Raw Data Plots ---
            # 1. Parallel Coordinates
            param_names = [p["name"] for p in self.parameter_space]
            available_params = [p for p in param_names if p in df.columns]
            
            if available_params and self.objective_config:
                obj_name = self.objective_config[0]["name"]
                if obj_name in df.columns:
                    plot_df = df.copy()
                    categorical_maps = {}
                    for col in available_params:
                        if plot_df[col].dtype == 'object' or plot_df[col].dtype.name == 'category':
                            plot_df[col] = pd.Categorical(plot_df[col])
                            plot_df[col] = plot_df[col].cat.codes
                    
                    fig_par = px.parallel_coordinates(
                        plot_df, 
                        dimensions=available_params + [obj_name],
                        color=obj_name,
                        title='Parallel Coordinates'
                    )
                    fig_par.update_layout(margin=dict(l=60, r=60, t=60, b=40))
                    plots['Parallel Coordinates'] = fig_par.to_html(full_html=False, include_plotlyjs=False)
            
            # 2. Pareto Frontier (if multiple objectives)
            if len(self.objective_config) > 1:
                obj1 = self.objective_config[0]["name"]
                obj2 = self.objective_config[1]["name"]
                
                if obj1 in df.columns and obj2 in df.columns:
                    fig_pareto = px.scatter(
                        df, 
                        x=obj1, 
                        y=obj2,
                        title='Objective Trade-offs (Pareto)',
                        hover_data=available_params
                    )
                    plots['Pareto Frontier'] = fig_pareto.to_html(full_html=False, include_plotlyjs=False)
                    
            return plots if plots else {"error": "Plots could not be generated. Check if parameters/objectives match the dataset."}
            
        except Exception as e:
            print(f"Failed to generate BayBE plots: {e}")
            return {"error": f"Failed to generate BayBE plots: {str(e)}"}

    @staticmethod
    def get_schema():
        """
        Returns a template for the optimizer configuration.
        """
        return {
            "parameter_types": ["range", "choice", "substance"],
            "multiple_objectives": True,
            "supports_continuous": True,
            "supports_constraints": True,
            "supports_suggest_only": True,
            # Substances need `baybe[chem]`; the page offers them only when it is installed.
            "substance_available": chemistry_available(),
            "substance_encodings": SUBSTANCE_ENCODINGS,
            "optimizer_config": {
                "step_1": {"model": ["Random", "FPS"], "num_samples": 10},
                "step_2": {"model": ["BOTorch", "Naive Hybrid Space"]}
            },
            "additional_field": {}
        }

if __name__ == "__main__":
    # Example usage
    baybe_optimizer = BaybeOptimizer(
        experiment_name="example_experiment",
        parameter_space=[
            {"name": "param_1", "type": "range", "bounds": [1.0, 2.0], "value_type": "float"},
            {"name": "param_2", "type": "choice", "bounds": ["a", "b", "c"], "value_type": "str"},
            {"name": "param_3", "type": "range", "bounds": [0, 10], "value_type": "int"}
        ],
        objective_config=[
            {"name": "obj_1", "minimize": True},
            {"name": "obj_2", "minimize": False}
        ],
        optimizer_config={
            "step_1": {"model": "Random", "num_samples": 10},
            "step_2": {"model": "BOTorch"}
        }
    )
    print(baybe_optimizer.suggest(5))
