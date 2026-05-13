from __future__ import annotations

from fastapi import APIRouter, Depends

from app.core.audit import write_event
from app.core.deps import Actor, DbSession, require_min_role
from app.models import Memory
from app.schemas import MemoryExtractIn, MemoryQueryIn
from app.services import memory_out

router = APIRouter()


@router.post("/api/memory/extract")
def extract_memory(
    payload: MemoryExtractIn,
    db: DbSession,
    actor: Actor = Depends(require_min_role("operator")),
):
    memory = Memory(
        space_id=actor.space_id,
        namespace=payload.namespace,
        observation=payload.observation,
        source=payload.source,
        project_name=payload.project_name,
        backend=payload.backend,
        created_by=actor.actor_id,
    )
    db.add(memory)
    db.flush()
    write_event(
        db,
        space_id=actor.space_id,
        actor_type="user",
        actor_id=actor.actor_id,
        source_type="memory",
        source_id=payload.namespace,
        event_type="memory.promote",
        payload={"source": payload.source},
    )
    db.commit()
    return {"memory": memory_out(memory)}


@router.post("/api/memory/query")
def query_memory(payload: MemoryQueryIn, db: DbSession, actor: Actor = Depends(require_min_role("viewer"))):
    query = f"%{payload.query}%"
    rows = (
        db.query(Memory)
        .filter(Memory.space_id == actor.space_id)
        .filter(Memory.namespace == payload.namespace)
        .filter(Memory.observation.like(query) if payload.query else True)
        .order_by(Memory.created_at.desc())
        .limit(50)
        .all()
    )
    return {"items": [memory_out(memory) for memory in rows]}
