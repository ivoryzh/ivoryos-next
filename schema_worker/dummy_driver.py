from pydantic import BaseModel

class PumpConfig(BaseModel):
    speed: float = 1.0
    enabled: bool = True

class Pump:
    def set_speed(self, speed: float) -> bool:
        """Sets the pump speed."""
        pass
        
    def start(self, config: PumpConfig):
        """Starts the pump with the given config."""
        pass
