### ivoryos/optimizers/base.py

from abc import ABC, abstractmethod



class OptimizerBase(ABC):
    def __init__(self, experiment_name:str, parameter_space: list, objective_config: dict, optimizer_config: dict,
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
        optimizer_config={
            "step_1": {"model": "Random", "num_samples": 10},
            "step_2": {"model": "BOTorch"}
        }
        """
        self.experiment_name = experiment_name
        self.parameter_space = parameter_space
        self.objective_config = objective_config
        self.optimizer_config = optimizer_config
        self.parameter_constraints = parameter_constraints
        self.additional_params = additional_params
        self.datapath = datapath

    @abstractmethod
    def suggest(self, n=1):
        pass

    @abstractmethod
    def observe(self, results: dict):
        """
        observe
        :param results: {"objective_name": "value"}
        """

    @abstractmethod
    def append_existing_data(self, existing_data, file_path: str = None):
        pass

    @abstractmethod
    def get_plots(self, plot_type):
        pass

    @staticmethod
    def _create_discrete_search_space(range_with_step=None, value_type ="float"):
        if range_with_step is None:
            range_with_step = []
        import numpy as np
        low, high, step = range_with_step
        values = np.arange(low, high + 1e-9 * step, step).tolist()
        if value_type == "float":
            values = [float(v) for v in values]
        if value_type == "int":
            values = [int(v) for v in values]
        return values

    @staticmethod
    def get_schema():
        """
        Returns a template for the optimizer configuration.
        """
        return {
            "parameter_types": ["range", "choice"],
            "multiple_objectives": True,
            # "objective_weights": True,
            "optimizer_config": {
                "step_1": {"model": [], "num_samples": 10},
                "step_2": {"model": []}
            },
            "additional_field": {}
        }



