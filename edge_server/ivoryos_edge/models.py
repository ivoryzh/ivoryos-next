from datetime import datetime
from typing import Optional, Dict, Any, List
from sqlalchemy import String, Integer, DateTime, JSON, Text, ForeignKey
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker

class Base(DeclarativeBase):
    pass

class WorkflowRun(Base):
    """Represents an entire execution sequence or spreadsheet run."""
    __tablename__ = "workflow_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128), default="Run")
    status: Mapped[str] = mapped_column(String(32), default="pending")  # pending, running, paused, waiting_input, completed, error, cancelled
    start_time: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    end_time: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    
    # Optional parameters for the optimizer/sweep
    parameters: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    
    steps: Mapped[List["WorkflowStep"]] = relationship(back_populates="run", cascade="all, delete-orphan", order_by="WorkflowStep.sequence_index")
    
    def as_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "status": self.status,
            "start_time": self.start_time.isoformat() if self.start_time else None,
            "end_time": self.end_time.isoformat() if self.end_time else None,
            "parameters": self.parameters,
        }

class WorkflowStep(Base):
    """Represents a single function call within a WorkflowRun."""
    __tablename__ = "workflow_steps"

    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("workflow_runs.id", ondelete="CASCADE"))
    sequence_index: Mapped[int] = mapped_column(Integer, default=0)
    
    instrument: Mapped[str] = mapped_column(String(128))
    method: Mapped[str] = mapped_column(String(128))
    
    parameters: Mapped[dict] = mapped_column(JSON, default=dict)
    outputs: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="pending")  # pending, running, waiting_input, completed, error, skipped
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    
    start_time: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    end_time: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    
    run: Mapped["WorkflowRun"] = relationship(back_populates="steps")
    
    def as_dict(self):
        return {
            "id": self.id,
            "run_id": self.run_id,
            "sequence_index": self.sequence_index,
            "instrument": self.instrument,
            "method": self.method,
            "parameters": self.parameters,
            "outputs": self.outputs,
            "status": self.status,
            "error": self.error,
            "start_time": self.start_time.isoformat() if self.start_time else None,
            "end_time": self.end_time.isoformat() if self.end_time else None,
        }


# Database setup
DATABASE_URL = "sqlite+aiosqlite:///ivoryos_edge.db"
engine = create_async_engine(DATABASE_URL, echo=False)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
