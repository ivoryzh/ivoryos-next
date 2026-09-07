from pandas import DataFrame

from ivoryos_edge.optimizer.base_optimizer import OptimizerBase

# hardcoded blacklist for Ax objective names from SymPy
AX_OBJ_BLACKLIST = ["test", "factor", "range", "product", "prod", "sum", "type", "yield"]

class AxOptimizer(OptimizerBase):
    def __init__(self, experiment_name, parameter_space, objective_config, optimizer_config=None,
                 parameter_constraints:list=None, datapath=None, additional_params:dict=None):
        self.trial_index_list = None
        try:
            from ax.api.client import Client
        except ImportError as e:
            raise ImportError(
                "AxOptimizer requires the optional Ax dependency. "
                "Install it with `pip install ax-platform`."
            ) from e
        super().__init__(experiment_name, parameter_space, objective_config, optimizer_config, parameter_constraints,
                         datapath, additional_params)

        self.client = Client()
        # 2. Configure where Ax will search.
        self.client.configure_experiment(
            name=experiment_name,
            parameters=self._convert_parameter_to_ax_format(parameter_space),
            parameter_constraints=parameter_constraints
        )
        # 3. Configure the objective function.
        self.client.configure_optimization(objective=self._convert_objective_to_ax_format(objective_config))
        if optimizer_config:
            self.client.set_generation_strategy(self._convert_generator_to_ax_format(optimizer_config))
        self.generators = self._create_generator_mapping()

    @staticmethod
    def _create_generator_mapping():
        """Create a mapping from string values to Generator enum members."""
        from ax.adapter import Generators
        return {member.value: member for member in Generators}

    def _convert_parameter_to_ax_format(self, parameter_space):
        """
        Converts the parameter space configuration to Baybe format.
        :param parameter_space: The parameter space configuration.
        [
            {"name": "param_1", "type": "range", "bounds": [1.0, 2.0], "value_type": "float"},
            {"name": "param_2", "type": "choice", "bounds": ["a", "b", "c"], "value_type": "str"},
            {"name": "param_3", "type": "range", "bounds": [0 10], "value_type": "int"},
        ]
        :return: A list of Baybe parameters.
        """
        from ax import RangeParameterConfig, ChoiceParameterConfig
        ax_params = []
        for p in parameter_space:
            value_type = p.get("value_type", "float")
            if p["type"] == "range":
                # if step is used here, convert to ChoiceParameterConfig
                if  len(p["bounds"]) == 3:
                    values = self._create_discrete_search_space(range_with_step=p["bounds"],value_type=value_type)
                    ax_params.append(ChoiceParameterConfig(name=p["name"], values=values, parameter_type="float", is_ordered=True))
                else:
                    ax_params.append(
                        RangeParameterConfig(
                            name=p["name"],
                            bounds=tuple(p["bounds"]),
                            parameter_type=value_type
                        ))
            elif p["type"] == "choice":
                ax_params.append(
                    ChoiceParameterConfig(
                        name=p["name"],
                        values=p["bounds"],
                        parameter_type=value_type,
                    )
                )
        return ax_params

    def _convert_objective_to_ax_format(self, objective_config: list):
        """
        Converts the objective configuration to Baybe format.
        :param parameter_space: The parameter space configuration.
        [
            {"name": "obj_1", "minimize": True, "weight": 1},
            {"name": "obj_2", "minimize": False, "weight": 2}
        ]
        :return: Ax objective configuration. "-cost, utility"
        """
        objectives = []
        for obj in objective_config:
            obj_name = obj.get("name")

            # # fixing unknown Ax "unsupported operand type(s) for *: 'One' and 'LazyFunction'" in v1.1.2, test is not allowed as objective name
            if obj_name in AX_OBJ_BLACKLIST:
                raise ValueError(f"{obj_name} is not allowed as objective name")

            minimize = obj.get("minimize", True)
            weight = obj.get("weight", 1)
            sign = "-" if minimize else ""
            objectives.append(f"{sign}{weight} * {obj_name}")
        return ", ".join(objectives)

    def _convert_generator_to_ax_format(self, optimizer_config):
        """
        Converts the optimizer configuration to Ax format.
        :param optimizer_config: The optimizer configuration.
        :return: Ax generator configuration.
        """
        from ax.generation_strategy.generation_node import GenerationStep
        from ax.generation_strategy.generation_strategy import GenerationStrategy
        generators = self._create_generator_mapping()
        steps = []
        for i in range(1, len(optimizer_config) + 1):
            step = optimizer_config.get(f"step_{i}", {})
            generator = step.get("model")
            num_trials = step.get("num_samples", -1)
            if not num_trials == 0:
                steps.append(GenerationStep(generator=generators.get(generator), num_trials=num_trials, should_deduplicate=True))

        import inspect
        if "steps" not in inspect.signature(GenerationStrategy.__init__).parameters:
            return GenerationStrategy(nodes=steps)
        else:
            return GenerationStrategy(steps=steps)

    def suggest(self, n=1):
        trials = self.client.get_next_trials(n)
        trial_index_list = []
        param_list = []
        for trial_index, params in trials.items():
            trial_index_list.append(trial_index)
            param_list.append(params)
        self.trial_index_list = trial_index_list
        return param_list

    def observe(self, results):
        for trial_index, result in zip(self.trial_index_list, results):
            obj_only_result = {k: v for k, v in result.items() if k in [obj["name"] for obj in self.objective_config]}
            if not obj_only_result:
                self.client.mark_trial_failed(trial_index=trial_index, failed_reason="No objective values returned.")
            elif len(obj_only_result.keys()) != len(self.objective_config):
                self.client.mark_trial_failed(trial_index=trial_index, failed_reason="Missing one or more objective values.")
            else:
                self.client.complete_trial(
                    trial_index=trial_index,
                    raw_data=obj_only_result
                )

    def get_plots(self, plot_type):
        try:
            from ax.plot.contour import interact_contour_plotly
            from ax.plot.slice import interact_slice_plotly
            from ax.plot.trace import optimization_trace_single_method_plotly
            from ax.plot.render import plot_config_to_html
            import numpy as np
            
            plots = {}
            errors = []
            if hasattr(self, 'generators'):
                try:
                    from ax.plot.feature_importances import plot_feature_importance_by_feature_plotly
                    
                    # We need the model adapter from the current generation step to extract feature importance
                    gs = self.client._generation_strategy
                    adapter = gs.adapter if hasattr(gs, 'adapter') else gs.model
                    
                    if adapter is not None:
                        fig = plot_feature_importance_by_feature_plotly(model=adapter, relative=True)
                        plots['Feature Importance'] = fig.to_html(full_html=False, include_plotlyjs=False)
                except Exception as e:
                    errors.append(f"Feature Importance Error: {e}")

                try:
                    adapter = None
                    if hasattr(self.client, "_generation_strategy"):
                        gs = self.client._generation_strategy
                        if hasattr(gs, "adapter"):
                            adapter = gs.adapter
                        elif hasattr(gs, "model"):
                            adapter = gs.model

                    metric_name = self.objective_config[0]["name"] if self.objective_config else None
                    if metric_name:
                        fig = interact_contour_plotly(model=adapter, metric_name=metric_name)
                        plots['Contour'] = fig.to_html(full_html=False, include_plotlyjs=False)
                except Exception as e:
                    errors.append(f"Contour Error: {e}")

                try:
                    fig = interact_slice_plotly(model=adapter)
                    plots['Slice'] = fig.to_html(full_html=False, include_plotlyjs=False)
                except Exception as e:
                    errors.append(f"Slice Error: {e}")

            if len(self.objective_config) > 1:
                try:
                    from ax.plot.pareto_utils import compute_posterior_pareto_frontier
                    from ax.plot.pareto_frontier import plot_pareto_frontier
                    
                    experiment = self.client._experiment
                    metric_names = [o['name'] for o in self.objective_config]
                    
                    # Check if experiment has enough data and metrics
                    if len(metric_names) >= 2 and all(m in experiment.metrics for m in metric_names[:2]):
                        m1 = experiment.metrics[metric_names[0]]
                        m2 = experiment.metrics[metric_names[1]]
                        
                        frontier = compute_posterior_pareto_frontier(
                            experiment=experiment,
                            data=experiment.fetch_data(),
                            primary_objective=m1,
                            secondary_objective=m2,
                            absolute_metrics=metric_names,
                            num_points=30,
                        )
                        fig = plot_pareto_frontier(frontier, CI_level=0.90)
                        plots['Pareto Frontier'] = plot_config_to_html(fig)
                except Exception as e:
                    errors.append(f"Pareto Error: {e}")

            if not plots:
                try:
                    trial_count = len(self.client.experiment.trials)
                except:
                    trial_count = 0
                    
                if trial_count < 5:
                    return {"error": "Not enough data points yet. Ax requires a few initial random trials to build the surrogate model."}
                else:
                    return {"error": f"Failed to generate plots. Errors encountered: {' | '.join(errors)}"}
            return plots
            
        except Exception as e:
            return {"error": f"Critical error in get_plots: {str(e)}"}

    @staticmethod
    def get_schema():
        return {
            "parameter_types": ["range", "choice"],
            "multiple_objectives": True,
            # "objective_weights": True,
            "supports_continuous": True,
            "supports_constraints": True,
            "optimizer_config": {
                "step_1": {"model": ["Sobol", "Uniform", "Factorial", "Thompson"], "num_samples": 5},
                "step_2": {"model": ["BoTorch", "SAASBO", "SAAS_MTGP", "Legacy_GPEI", "EB", "EB_Ashr", "ST_MTGP", "BO_MIXED", "Contextual_SACBO"]}
            },
            "additional_field": {}
        }

    def append_existing_data(self, existing_data:DataFrame, file_path: str = None):
        """
        Append existing data to the Ax experiment.
        :param existing_data: A dictionary containing existing data.
        :param file_path: The path to the CSV file containing existing data.
        """

        if isinstance(existing_data, DataFrame):
            if existing_data.empty:
                return
            existing_data = existing_data.to_dict(orient="records")
        parameter_names = [i.get("name") for i in self.parameter_space]
        objective_names = [i.get("name") for i in self.objective_config]
        for entry in existing_data:
            # for name, value in entry.items():
                # First attach the trial and note the trial index
            parameters = {name: value for name, value in entry.items() if name in parameter_names}
            trial_index = self.client.attach_trial(parameters=parameters)
            raw_data = {name: value for name, value in entry.items() if name in objective_names}
            # Then complete the trial with the existing data
            self.client.complete_trial(trial_index=trial_index, raw_data=raw_data)


if __name__ == "__main__":
    # Example usage
    optimizer = AxOptimizer(
        experiment_name="example_experiment",
        parameter_space=[
            {"name": "param_1", "type": "range", "bounds": [0.0, 1.0], "value_type": "float"},
            {"name": "param_2", "type": "choice", "bounds": ["a", "b", "c"], "value_type": "str"}
        ],
        objective_config=[
            {"name": "objective_1", "minimize": True},
            {"name": "objective_2", "minimize": False}
        ],
        optimizer_config={
            "step_1": {"model": "Sobol", "num_samples": 5},
            "step_2": {"model": "BoTorch"}
        }
    )
    print(optimizer._create_generator_mapping())
