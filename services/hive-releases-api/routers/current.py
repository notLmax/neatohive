from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from db import get_session
from models import Release

router = APIRouter()


class CurrentRelease(BaseModel):
    version: str
    tarball_url: str
    checksum_sha256: str
    released_at: str
    changelog_url: str


def serialize_released_at(value) -> str:
    return value.isoformat().replace("+00:00", "Z")


@router.get("/current", response_model=CurrentRelease)
def get_current_release(session: Session = Depends(get_session)) -> CurrentRelease:
    stmt = (
        select(Release)
        .where(Release.deprecated_at.is_(None))
        .order_by(Release.released_at.desc())
        .limit(1)
    )
    release = session.execute(stmt).scalar_one_or_none()
    if release is None:
        raise HTTPException(status_code=500, detail="no active release found")

    return CurrentRelease(
        version=release.version,
        tarball_url=release.tarball_url,
        checksum_sha256=release.checksum_sha256,
        released_at=serialize_released_at(release.released_at),
        changelog_url=release.changelog_url,
    )
