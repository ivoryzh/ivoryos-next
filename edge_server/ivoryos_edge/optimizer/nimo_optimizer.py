### ivoryos/optimizers/nimo_optimizer.py
import glob
import itertools
import os

import pandas as pd
from pandas import DataFrame

from ivoryos_edge.optimizer.base_optimizer import OptimizerBase


class NIMOOptimizer(OptimizerBase):
    def __init__(self, experiment_name:str, parameter_space: list, objective_config: list, optimizer_config: dict,
                 parameter_constraints:list=None, datapath:str=None, additional_params:dict=None):
        """
        :param experiment_name: arbitrary name
        :param parameter_space: list of parameter names
        [
            {"name": "param_1", "type": "range", "bounds": [1.0, 2.0], "value_type": "float"},
            {"name": "param_2", "type": "choice", "bounds": ["a", "b", "c"], "value_type": "str"},
            {"name": "param_3", "type": "range", "bounds": [0 10], "value_type": "int"},
        ]
        :param objective_config: objective configuration
        [
            {"name": "obj_1", "minimize": True, "weight": 1},
            {"name": "obj_2", "minimize": False, "weight": 1}
        ]
        :param optimizer_config: optimizer configuration
        {
            "step_1": {"model": "RE", "num_samples": 10},
            "step_2": {"model": "PDC"}
        }
        """
        try:
            import nimo
        except ImportError as e:
            raise ImportError(
                "NIMOOptimizer requires the optional NIMO dependency. "
                "Install it with `pip install nimo`."
            ) from e

        self.current_step = 0
        self.experiment_name = experiment_name
        self.parameter_space = parameter_space
        self.objective_config = objective_config
        self.optimizer_config = optimizer_config

        super().__init__(experiment_name, parameter_space, objective_config, optimizer_config, parameter_constraints, datapath, additional_params)

        os.makedirs(os.path.join(self.datapath, "nimo_data"), exist_ok=True)

        step_1 = optimizer_config.get("step_1", {})
        step_2 = optimizer_config.get("step_2", {})
        self.step_1_generator = step_1.get("model", "RE")
        self.step_1_batch_num = step_1.get("num_samples", 1)
        self.step_2_generator = step_2.get("model", "PDC")
        self.candidates = os.path.join(self.datapath, "nimo_data", f"{self.experiment_name}_candidates.csv")
        self.proposals = os.path.join(self.datapath, "nimo_data", f"{self.experiment_name}_proposals.csv")
        self.n_objectives = len(self.objective_config)
        self._create_candidates_csv()


    def _create_candidates_csv(self):
        """create candidates csv file for nimo input"""
        param_names = [p["name"] for p in self.parameter_space]

        param_values = []
        for p in self.parameter_space:
            if p["type"] == "choice" and isinstance(p["bounds"], list):
                param_values.append(p["bounds"])
            elif p["type"] == "range" and len(p["bounds"]) == 3:
                values = self._create_discrete_search_space(range_with_step=p["bounds"],value_type=p["value_type"])
                param_values.append(values)
            else:
                raise ValueError(f"Unsupported parameter format: {p}")

        # Generate all possible combinations
        combos = list(itertools.product(*param_values))

        # Create a DataFrame with parameter columns
        df = pd.DataFrame(combos, columns=param_names)
        # Add empty objective columns
        for obj in self.objective_config:
            df[obj["name"]] = ""

        # Save to CSV
        df.to_csv(self.candidates, index=False)


    def suggest(self, n=1):
        """suggest n candidates for next batch of trials"""
        import nimo

        method = self.step_1_generator if self.current_step < self.step_1_batch_num else self.step_2_generator

        nimo.selection(method = method,
                       input_file = self.candidates,
                       output_file = self.proposals,
                       num_objectives = self.n_objectives,
                       num_proposals = n,
                       **self.additional_params
                       )
        self.current_step += 1
        # Read proposals from CSV file
        proposals_df = pd.read_csv(self.proposals)
        # Get parameter names
        param_names = [p["name"] for p in self.parameter_space]
        # Convert proposals to list of parameter dictionaries
        proposals = []
        for _, row in proposals_df.iterrows():
            proposal = {name: row[name] for name in param_names}
            proposals.append(proposal)
        return proposals

    def _convert_observation_to_list(self, obs: dict) -> list:
        obj_names = [o["name"] for o in self.objective_config]
        return [obs.get(name, None) for name in obj_names]

    def observe(self, results: list):
        """
        observe single output, nimo obj input is [1,2,3] or [[1, 2], [1, 2], [1, 2]] for MO
        :param results: [{"objective_name": "value"}, {"objective_name": "value"}]]
        """
        import nimo
        nimo_objective_values = [self._convert_observation_to_list(result) for result in results]
        nimo.output_update(input_file=self.proposals,
                           output_file=self.candidates,
                           num_objectives=self.n_objectives,
                           objective_values=nimo_objective_values)

    def append_existing_data(self, existing_data: DataFrame, file_path: str = None):
        """
        append existing data to the candidates csv file for nimo input
        """
        import nimo
        num_objectives = len(self.objective_config)
        if file_path is None:
            return
        nimo.insert_objectives(input_file=file_path,
                               output_file=self.candidates,
                               num_objectives=num_objectives,
                               ndigits=2)

    def get_plots(self, plot_type):
        """requests phase diagram plot from nimo"""
        import nimo
        nimo.visualization.plot_phase_diagram.plot(input_file=self.candidates,
                                                   fig_folder=os.path.join(self.datapath, "nimo_data"))
        files = sorted(glob.glob(os.path.join(os.path.join(self.datapath, "nimo_data"), "phase_diagram_*.png")))
        if not files:
            return None
        return files[-1]

    @staticmethod
    def get_schema():
        return {
            "parameter_types": ["choice", "range"],
            "multiple_objectives": True,
            "supports_continuous": False,
            "supports_constraints": False,
            "optimizer_config": {
                "step_1": {"model": ["RE", "ES"], "num_samples": 5},
                "step_2": {"model": ["PHYSBO", "PDC", "BLOX", "PTR", "SLESA", "BOMP", "COMBI"]}
            },
            "additional_field":{
                "re_seed": {"type": "int", "required": False},
                "ptr_ranges": {"type": "list[float]", "required": False},

                "slesa_beta_max": {"type": "float", "required": False},
                "slesa_beta_num": {"type": "int", "required": False},

                "physbo_score": {"type": "choice", "options": ["Default", "EI", "PI", "TS", "HVPI", "EHVI", "TS"]},

                "pdc_estimation": {"type": "choice", "options": ["Default", "LP", "LS"]},
                "pdc_sampling": {"type": "choice", "options": ["Default", "LC", "MS", "EA"]},

                "process_X": {"type": "list[float]", "required": False},

                "combi_ranges": {"type": "list[float]", "required": False},
                "spread_elements": {"type": "list[int]", "required": False},

                "output_res": {"type": "choice", "options": ["Default", "True", "False"]},
                "training_res": {"type": "choice", "options": ["Default", "True", "False"]},
            }
        }




if __name__ == "__main__":
    parameter_space = [
        {"name": "silica", "type": "choice", "bounds": [100], "value_type": "float"},
        {"name": "water", "type": "range", "bounds": [500, 900, 50], "value_type": "float"},
        {"name": "PVA", "type": "choice", "bounds": [0, 0.005, 0.0075, 0.01, 0.05, 0.075, 0.1], "value_type": "float"},
        {"name": "SDS", "type": "choice", "bounds": [0], "value_type": "float"},
        {"name": "DTAB", "type": "choice", "bounds": [0, 0.005, 0.0075, 0.01, 0.05, 0.075, 0.1], "value_type": "float"},
        {"name": "PVP", "type": "choice", "bounds": [0], "value_type": "float"},
    ]
    objective_config = [
        {"name": "objective", "minimize": False, "weight": 1},

    ]
    optimizer_config = {
        "step_1": {"model": "RE", "num_samples": 10},
        "step_2": {"model": "PDC"}
    }

    nimo_optimizer = NIMOOptimizer(experiment_name="example_experiment", optimizer_config=optimizer_config, parameter_space=parameter_space, objective_config=objective_config)
    nimo_optimizer.suggest(n=1)
    nimo_optimizer.observe(
        results=[{"objective": 1.0}]
    )