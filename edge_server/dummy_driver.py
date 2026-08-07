import time

class PumpDriver:
    """A dummy pump driver for testing introspection and execution."""
    
    def __init__(self):
        self.flow_rate = 0.0
        self.is_running = False
        
    def set_flow_rate(self, rate: float):
        """Sets the flow rate of the pump."""
        print(f"[Pump] Setting flow rate to {rate}")
        self.flow_rate = rate
        return {"status": "success", "flow_rate": self.flow_rate}
        
    def start_pump(self) -> None:
        """Starts the pump at the current flow rate."""
        print("[Pump] Starting pump...")
        self.is_running = True
        
    def stop_pump(self):
        """Stops the pump."""
        print("[Pump] Stopping pump...")
        self.is_running = False
        return {"status": "success", "running": False}
        
    def long_running_task(self, duration: int):
        """A blocking task to test execution cancellation."""
        print(f"[Pump] Starting long task for {duration} seconds...")
        for i in range(duration):
            print(f"[Pump] Task running... {i+1}/{duration}")
            time.sleep(1)
        print("[Pump] Long task finished.")
        return {"status": "success", "duration": duration}

    def complex_initialization_sequence(self, target_temperature: float, solvent_name: str, enable_safety_checks: bool = True, retries: int = 3, timeout_seconds: float = 60.0):
        """
        A complex method with many parameters to stress test the UI.
        Requires temperature, solvent name, and optionally safety checks and timeout settings.
        """
        print(f"[Pump] Initializing with {solvent_name} at {target_temperature}C...")
        time.sleep(2)
        if enable_safety_checks:
            print("[Pump] Safety checks enabled, verifying pressure bounds...")
            time.sleep(1)
        return {
            "status": "success", 
            "message": f"Initialized {solvent_name}",
            "temp": target_temperature,
            "safety": enable_safety_checks
        }

    def very_long_module_method_name_to_test_truncation_issues_on_frontend(self, super_long_parameter_name_that_should_wrap: str = "default_val"):
        """Testing long names on the frontend display."""
        return {"result": super_long_parameter_name_that_should_wrap}

    def test_error_handling(self, should_fail: bool = True):
        """Throws an exception if should_fail is True."""
        if should_fail:
            raise ValueError("This is a simulated driver error!")
        else:
            return {"status": "success", "message": "Did not fail"}

class DummyMathDriver:
    """A dummy driver for testing the optimizer with a simulated mathematical function."""
    
    def evaluate_function(self, x: float, y: float) -> float:
        """
        Evaluates a simulated objective function: -(x-3)^2 - (y-2)^2 + 10
        Optimal parameters are x=3, y=2, yielding max=10.
        """
        print(f"[MathDriver] Evaluating at x={x}, y={y}")
        result = -((x - 3) ** 2) - ((y - 2) ** 2) + 10
        print(f"[MathDriver] Result: {result}")
        return result