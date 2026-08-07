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
                         additional_params)

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
            if p["type"] == "range":
                # if step is used here, convert to ChoiceParameterConfig
                if  len(p["bounds"]) == 3:
                    values = self._create_discrete_search_space(range_with_step=p["bounds"],value_type=p["value_type"])
                    ax_params.append(ChoiceParameterConfig(name=p["name"], values=values, parameter_type="float", is_ordered=True))
                else:
                    ax_params.append(
                        RangeParameterConfig(
                            name=p["name"],
                            bounds=tuple(p["bounds"]),
                            parameter_type=p["value_type"]
                        ))
            elif p["type"] == "choice":
                ax_params.append(
                    ChoiceParameterConfig(
                        name=p["name"],
                        values=p["bounds"],
                        parameter_type=p["value_type"],
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
        return None

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
