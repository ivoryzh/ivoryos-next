from datetime import datetime
from typing import Optional, Dict, Any, List
from sqlalchemy import (
    String, Integer, DateTime, JSON, Text, ForeignKey, Float, UniqueConstraint,
    create_engine, event,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, sessionmaker
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

class SavedWorkflow(Base):
    """The head of a saved workflow — what the Library lists and the Designer loads.

    Named rather than id-keyed because the name *is* the identity: links between workflows are
    by name, so renaming is deliberately not a thing you can do (it would break every pinned
    reference), and a surrogate key would only add a second identity to keep in step.
    """
    __tablename__ = "saved_workflows"

    name: Mapped[str] = mapped_column(String(255), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    # The head carries its own body rather than pointing at a snapshot. It has to be able to
    # diverge from them: editing the head file by hand (or syncing one down from Cloud) changes
    # what runs without creating a version, and that is deliberate -- only save_version appends
    # to the history.
    body: Mapped[dict] = mapped_column(JSON, default=dict)
    body_hash: Mapped[str] = mapped_column(String(64), default="")
    updated_at: Mapped[float] = mapped_column(Float, default=0.0)
    # Tags live beside the body, never inside it: the body is content-hashed to decide whether a
    # save is a real edit, so folding tags in would make re-filing a workflow burn a version.
    tags: Mapped[list] = mapped_column(JSON, default=list)
    # The stat of the mirror file when it was last read in. Comparing these is what makes an
    # out-of-band edit cheap to notice -- one os.stat per workflow instead of re-reading and
    # re-hashing every file on every list.
    file_mtime: Mapped[float] = mapped_column(Float, default=0.0)
    file_size: Mapped[int] = mapped_column(Integer, default=0)


class SavedWorkflowVersion(Base):
    """An immutable snapshot. Append-only, and deliberately *not* cascaded from SavedWorkflow:
    deleting a workflow leaves its versions behind, because a finished run may still reference
    one and that provenance is the whole reason the store exists."""
    __tablename__ = "saved_workflow_versions"
    __table_args__ = (UniqueConstraint("name", "version", name="uq_workflow_version"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), index=True)
    version: Mapped[int] = mapped_column(Integer)
    body: Mapped[dict] = mapped_column(JSON)
    body_hash: Mapped[str] = mapped_column(String(64), default="")
    updated_at: Mapped[float] = mapped_column(Float, default=0.0)
    note: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    author: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)


# Database setup
DB_FILENAME = "ivoryos_edge.db"
DATABASE_URL = f"sqlite+aiosqlite:///{DB_FILENAME}"
engine = create_async_engine(DATABASE_URL, echo=False)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

# A second, synchronous engine over the same file, used only by the workflow store.
#
# That store is called from places that cannot await: `publish_sequences` runs on the MQTT status
# thread, and `expand_workflow_blocks` is called inline while building a run. Making the store
# async would mean touching every one of its ~25 call sites and would still leave the thread with
# no way in. A sync engine keeps those signatures exactly as they are.
#
# WAL is what makes two engines on one SQLite file safe here: readers don't block the writer and
# the writer doesn't block readers, so the async run-history traffic and the (human-paced) workflow
# traffic don't trip over each other. busy_timeout covers the one case WAL doesn't — two writers
# at once — by waiting instead of raising "database is locked".
sync_engine = create_engine(
    f"sqlite+pysqlite:///{DB_FILENAME}",
    echo=False,
    connect_args={"check_same_thread": False, "timeout": 15},
)
sync_session = sessionmaker(bind=sync_engine, expire_on_commit=False)


@event.listens_for(sync_engine, "connect")
def _set_sqlite_pragmas(dbapi_connection, _record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=15000")
    cursor.close()


async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
