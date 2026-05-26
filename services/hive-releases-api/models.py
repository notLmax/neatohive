from sqlalchemy import TIMESTAMP, Column, Text, Uuid, text
from sqlalchemy.orm import declarative_base

Base = declarative_base()


class Release(Base):
    __tablename__ = "releases"

    id = Column(Uuid(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    version = Column(Text, nullable=False, unique=True)
    tarball_url = Column(Text, nullable=False)
    checksum_sha256 = Column(Text, nullable=False)
    released_at = Column(TIMESTAMP(timezone=True), nullable=False, server_default=text("NOW()"))
    changelog_url = Column(Text, nullable=True)
    release_notes_summary = Column(Text, nullable=True)
    deprecated_at = Column(TIMESTAMP(timezone=True), nullable=True)
